# Ladybug Explorer — Proxy Mode (remote shared DB over SSH-tunneled HTTP)

**Date:** 2026-06-17
**Status:** Approved design, pending implementation plan
**Repos touched:**
- Client: `/hdd/Project/ladybug-explorer` (ladybugdb-explorer)
- Server: `/hdd/Project/asm/ecoai-context-provider`

## Problem

Ladybug (Kùzu-family) is an **embedded, single-writer** database. When the
`ecoai-context-provider` process holds `/data/ecoai/assets/context/kg.db` open
in read-write mode, no other process can open the same database file — even
read-only — because the lock is exclusive. Opening it from Ladybug Explorer
fails with:

```
RuntimeError: IO exception: Could not set lock on file
```

Reference: https://docs.ladybugdb.com/concurrency/

## Goal

Let Ladybug Explorer inspect/query the live `kg.db` **without opening the file
itself**. The process that owns the DB (`ecoai-context-provider`) exposes a
small query endpoint; Explorer connects to it as a client. All read/explore UI
plus arbitrary read **and** write Cypher must work; the data-import wizard and
"Reset" are out of scope for proxy mode.

Hard constraint on both sides: **minimize impact on existing code.** Default
build/behaviour of both projects must be unchanged when proxy mode is unused.

## Decisions (confirmed with user)

| Decision | Choice |
|---|---|
| Transport | **HTTP** via `cpp-httplib` (header-only) on the server; `axios` on the client |
| Access / auth | **SSH local port-forward** (`ssh -L`); bridge binds to `127.0.0.1` only and is never exposed on the network. Passphrase or private-key auth, reusing existing SSH UX |
| Feature scope | Read/explore **+ write/DDL Cypher**. **Import wizard and Reset disabled** in proxy mode |

## Architecture

```
┌─ ladybug-explorer (CLIENT) ──────────┐         ┌─ ecoai-context-provider (SERVER) ─┐
│ Vue frontend (DBConfigModal +proxy)  │         │ main.cpp (sdbus event loop)        │
│   │ /api/* (unchanged)               │         │   KgService → LadybugGraphStore    │
│ Express backend                      │         │        │  (owns Database + lock)    │
│   Database façade ──┬─ Embedded      │         │   ExplorerBridge (NEW)             │
│                     └─ ProxyBackend  │         │     httplib server on 127.0.0.1    │
│                          │ axios HTTP │  SSH    │     own lbug::Connection           │
│   SSHTunnel (ssh -L) ════╪═══════════╪═tunnel══╪═> 127.0.0.1:<bridgePort>           │
└─────────────────────────────────────┘         └────────────────────────────────────┘
```

- The C++ process owns the DB and the lock. It gains a tiny embedded HTTP
  server (`ExplorerBridge`) running on its own thread with its **own**
  `lbug::main::Connection` on the **same** `lbug::main::Database`. Ladybug
  supports multiple connections on one Database and serializes transactions
  internally.
- The bridge binds to `127.0.0.1:<bridgePort>` only. Explorer's Express backend
  opens an SSH local port-forward to that port and speaks plain HTTP through the
  tunnel. The bridge port is therefore never exposed off-host.
- Explorer's Express backend is the proxy **client**. The browser never talks to
  the bridge directly — it keeps calling Explorer's existing `/api/*` routes.

## Wire contract (bridge HTTP API)

The bridge is deliberately tiny. The client rebuilds everything else (schema,
etc.) from these primitives.

### `POST /cypher`
Request:
```json
{ "query": "MATCH (n) RETURN n LIMIT 10", "params": { "k": 1 } }
```
- `params` optional. When present, the bridge runs a prepared statement and
  binds the params; otherwise a plain query.
- The bridge supports multi-statement queries (`;`-separated) like the native
  connection.

Response (single statement):
```json
{
  "isMultiStatement": false,
  "rows": [ { "n": { "_id": {"table":0,"offset":3}, "_label":"Device", "name":"x" } } ],
  "dataTypes": { "n": "NODE" }
}
```
Response (multi-statement):
```json
{ "isMultiStatement": true, "results": [ { "rows": [...], "dataTypes": {...} }, ... ] }
```
Error (HTTP 400):
```json
{ "error": "Binder exception: Table Foo does not exist. query=..." }
```

**Value serialization contract** — `ResultJson` must replicate
`ladybug/tools/nodejs_api/src_cpp/node_util.cpp::ConvertToNapiObject` so the
Explorer graph view (`src/components/ShellView/ResultGraph.vue`) receives the
exact shapes it already parses:

- `NODE` → object of properties plus `_label` (string) and `_id` (`{table,offset}`).
- `REL` → object of properties plus `_src`, `_dst` (`{table,offset}`), `_label`, `_id`.
- `RECURSIVE_REL` → `{ "_nodes": [...], "_rels": [...] }`.
- `INTERNAL_ID` → `{table, offset}`.
- `STRUCT`/`UNION` → object keyed by field names; `LIST`/`ARRAY` → JSON array;
  `MAP` → object keyed by stringified key.
- `INT128` → string (JSON has no 128-bit int; mirrors the explorer's
  `int128Replacer` BigInt-to-string handling).
- Scalars (bool/ints/float/double/string/uuid) → native JSON; `BLOB` → string.
- `DATE`/`TIMESTAMP[_*]`/`TIMESTAMP_TZ` → **ISO-8601 string**. Rationale: the
  native path returns JS `Date` objects which `Cypher.js` then runs through
  `JSON.stringify`, yielding ISO-8601 (`toJSON`) strings on the wire. The bridge
  emits ISO-8601 directly so the wire payload is identical to the embedded path.
  `INTERVAL` → milliseconds as a JSON number (matches `node_util.cpp`). Null →
  JSON null.

`dataTypes` values are the Ladybug `LogicalType::toString()` strings per column
(e.g. `"NODE"`, `"REL"`, `"RECURSIVE_REL"`, `"INT64"`, `"STRING"`), matching what
`QueryResult.getColumnDataTypes()` returns natively, because
`ResultGraph.vue` switches on these strings.

### `GET /version`
```json
{ "version": "0.15.3", "storageVersion": 39 }
```
- `version` from `CALL db_version() RETURN *`. `storageVersion` from the
  Ladybug C++ storage-version constant.

### `GET /ping`
```json
{ "status": "ok" }
```
Liveness check used by the client right after the tunnel is up.

## Server implementation (ecoai-context-provider) — additive

### New files
- `include/bridge/ExplorerBridge.h` / `src/bridge/ExplorerBridge.cpp`
  - Constructed with a `LadybugGraphStore&`, a bind address and a port.
  - On `start()`: creates its own `lbug::main::Connection` via the store and
    launches a `cpp-httplib` `Server` on a dedicated `std::thread`.
  - On destruction/`stop()`: `svr.stop()` then joins the thread.
  - Routes: `POST /cypher`, `GET /version`, `GET /ping`. Each handler catches
    exceptions and returns HTTP 400 `{error}` on failure; never lets an
    exception escape the handler thread.
- `src/bridge/ResultJson.h` / `src/bridge/ResultJson.cpp`
  - `nlohmann::json valueToJson(const lbug::common::Value&)` — the
    `node_util.cpp` port described above.
  - `nlohmann::json queryResultToJson(lbug::main::QueryResult&)` — iterates
    tuples into `{rows, dataTypes}`; honours an optional row cap.

### Minimal edits to existing code
- `LadybugGraphStore` (`include/graphdb/LadybugGraphStore.h`,
  `src/graphdb/LadybugGraphStore.cpp`): add
  `std::unique_ptr<lbug::main::Connection> createConnection() const;` returning a
  new `Connection` on `m_database`. (Existing methods untouched.)
- `KgService` (`include/KgService.h`): add accessor
  `graphdb::LadybugGraphStore& graphStore() { return m_store; }`.
- `main.cpp`: read new config keys and, only when enabled, build and start the
  bridge after `KgService` is constructed:
  - `explorer_bridge_enabled` (bool, default **false**)
  - `explorer_bridge_port` (int, e.g. 7999)
  - `explorer_bridge_bind` (string, default `127.0.0.1`)
  - When disabled, no thread is started and behaviour is byte-for-byte today's.
- `CMakeLists.txt`: vendor `cpp-httplib` (single header via `FetchContent` or a
  committed header under `third_party/`); add the two new `src/bridge/*.cpp`
  files to the target. No new linked system libraries (httplib is header-only;
  it needs `-lpthread`, already pulled in).

### Concurrency notes
- The bridge uses a separate `Connection` from the domain's connection. Reads
  are concurrent; writes from the bridge and the domain are serialized by
  Ladybug's transaction manager. The bridge does not share or mutate any
  `KgService` state beyond obtaining one connection at construction.
- httplib serves requests on its own threads; the bridge serializes access to
  its single `Connection` with a mutex (one in-flight query at a time is
  sufficient for an interactive explorer and avoids per-request connection
  churn).

## Client implementation (ladybug-explorer) — façade keeps routes unchanged

### Backend
- `src/server/utils/Database.js` → **façade**. The existing class is preserved
  as the **embedded** backend (default, no behaviour change). The exported
  singleton delegates the methods the routes use
  (`getConnection`, `releaseConnection`, `getSchema`, `getDbVersion`,
  `getCurrentConfig`, `getAccessModeString`, `reconfigure`, `reset`, `lbug`) to
  the currently active backend.
- New `src/server/utils/ProxyBackend.js`:
  - `getConnection()` → `ProxyConnection`; `releaseConnection()` no-op/pool.
  - `getSchema()` reuses a shared `buildSchema(conn)` helper (extracted from the
    current embedded `getSchema`) so schema assembly is identical.
  - `getDbVersion()` → `GET /version`.
  - `getCurrentConfig()` → `{ mode:"proxy", host, bridgePort, ... }`.
  - `getAccessModeString()` → `READ_WRITE` (writes allowed).
  - `reconfigure()`/`reset()` → throw "not supported in proxy mode" (UI hides
    these anyway).
- New `src/server/utils/ProxyConnection.js`:
  - `query(cypher, progressCb?)` and `prepare()/execute(stmt, params)` → `POST
    /cypher` (params passed through; `progressCb` ignored).
  - Returns `ProxyResult` wrapping the JSON payload, exposing
    `getAll()`, `getNext()` (iterates the in-memory rows), `getNumTuples()`,
    `getColumnDataTypes()`, `getColumnNames()`, `close()`. This lets
    `Cypher.js`, `Schema.js`, `State.js` run **unmodified**.
- New `src/server/utils/SSHTunnel.js`:
  - Spawns `ssh -N -L <localPort>:127.0.0.1:<remoteBridgePort> user@host`
    (key file, or password via `sshpass`), reusing the invocation style of the
    existing `SSHManager`. Picks a free local port; tears the tunnel down on
    switch-away. Kept separate from `SSHManager` (sshfs) so file-SSH mode is
    untouched.
- `src/server/DBConfig.js`: add a `mode === "proxy"` branch:
  - Validate fields → open `SSHTunnel` → activate `ProxyBackend` pointed at
    `127.0.0.1:<localPort>` → probe with `GET /ping` (and `getSchema()`), roll
    back on failure exactly like the SSH-mount path.
  - The existing file/memory/ssh logic stays in the `else` branch.
  - `buildResponse()` reports `mode:"proxy"` and proxy fields (never the
    password/passphrase).
- State/mode response gains a `backend: "proxy" | "embedded"` flag so the
  frontend can gate UI.

### Frontend
- `src/components/DBView/DBConfigModal.vue`: add a 4th radio **"Proxy (remote
  ladybug process)"** to the existing mutually-exclusive mode group. Its fields
  reuse the SSH host/port/user + auth (password / key file) block, plus a
  **"Bridge port"** field (the remote `explorer_bridge_port`). `buildPayload()`
  emits `{ mode:"proxy", ssh:{...}, bridgePort }`. Pre-populate from `/api/db`
  on open (no secret echoed back).
- Hide/disable **Import** and **Reset** affordances when the active backend is
  `proxy` (driven by the new `backend` flag). The progress bar simply never
  appears (no streaming).

## Data flow (a Shell query in proxy mode)

1. User runs Cypher in the Shell → browser `POST /api/cypher` (unchanged).
2. `Cypher.js` calls `database.getConnection()` → façade returns a
   `ProxyConnection`.
3. `conn.query(q)` → `ProxyConnection` does `POST http://127.0.0.1:<localPort>/cypher`.
4. SSH tunnel forwards to the server host's `127.0.0.1:<bridgePort>`.
5. `ExplorerBridge` runs the query on its Connection, `ResultJson` serializes
   the result preserving node/rel structure + column types, returns JSON.
6. `ProxyResult` serves `getAll/getColumnDataTypes/...`; `Cypher.js` builds the
   same response body as today; `ResultGraph.vue` renders the graph unchanged.

## Error handling

- Bridge handler error → HTTP 400 `{error}` → `ProxyConnection` rejects with the
  message → same `/api/cypher` 400 path the UI already shows.
- Tunnel/connect failure during DB switch → 400 in the modal, rollback to the
  previous backend (mirrors the SSH-mount failure path in `DBConfig.js`).
- Server with the bridge disabled → tunnel connects but HTTP fails → clear
  "proxy endpoint not reachable" message.
- Storage/version mismatch is irrelevant in proxy mode (Explorer never opens the
  file); `GET /version` is informational only.

## Testing

- **Server (C++):** unit tests for `ResultJson` against representative values
  (scalars, NODE, REL, RECURSIVE_REL, STRUCT, LIST, MAP, INT128, null) asserting
  shapes match the `node_util.cpp` contract; an integration test starting
  `ExplorerBridge` on a `:memory:` store and hitting `/cypher`, `/version`,
  `/ping` over loopback. Follow the existing `tests/` layout.
- **Client (JS):** unit tests for `ProxyResult`/`ProxyConnection` (mock HTTP),
  `buildSchema(conn)` parity between embedded and proxy connections, and the
  `DBConfig` proxy branch with a stubbed tunnel + stubbed bridge.
- **Manual end-to-end:** run `ecoai-context-provider` with the bridge enabled
  against a real `kg.db` held read-write; from Explorer pick Proxy mode, confirm
  Schema view, a graph query, node expansion, and a write query all work while
  the owning process keeps the lock.

## Out of scope / non-goals

- Data-import wizard (file upload → `COPY FROM`) in proxy mode — requires file
  locality on the server host; disabled.
- "Reset" in proxy mode — would wipe another process's DB; disabled.
- Local DB switching/SSH-mount/in-memory remain exactly as today and are
  mutually exclusive with proxy mode (single radio group).
- Streaming query progress over the proxy.
- Authn beyond the SSH tunnel (the tunnel is the security boundary).
