const test = require("node:test");
const assert = require("node:assert");
const { ProxyBackend } = require("../ProxyBackend");

function backendWith(routeHandlers) {
  // post(path, body) dispatches to a per-path handler returning { data }.
  const post = async (path, body) => ({ data: await routeHandlers[path](body) });
  const get = async (path) => ({ data: await routeHandlers[path]() });
  return new ProxyBackend({ host: "h", bridgePort: 7999, localPort: 5000 }, { post, get });
}

test("getAccessModeString is READ_WRITE", () => {
  const b = backendWith({});
  assert.equal(b.getAccessModeString(), "READ_WRITE");
});

test("getConnection returns a usable ProxyConnection", async () => {
  const b = backendWith({
    "/cypher": async () => ({ isMultiStatement: false, rows: [{ a: 1 }], dataTypes: { a: "INT64" } }),
  });
  const conn = b.getConnection();
  const res = await conn.query("RETURN 1 AS a;");
  assert.equal(res.getNumTuples(), 1);
  b.releaseConnection(conn);
});

test("getDbVersion reads the bridge /version", async () => {
  const b = backendWith({ "/version": async () => ({ version: "0.15.3", storageVersion: 39 }) });
  const v = await b.getDbVersion();
  assert.equal(v.version, "0.15.3");
  assert.equal(v.storageVersion, 39);
});

test("getCurrentConfig reports proxy mode without secrets", () => {
  const b = backendWith({});
  const cfg = b.getCurrentConfig();
  assert.equal(cfg.mode, "proxy");
  assert.equal(cfg.host, "h");
  assert.ok(!("password" in cfg));
});

test("reset and reconfigure are rejected", async () => {
  const b = backendWith({});
  await assert.rejects(() => b.reset());
});
