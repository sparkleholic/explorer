# Ladybug Explorer Proxy Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Ladybug Explorer query a live `kg.db` that another process holds read-write, by routing Cypher through an SSH-tunneled HTTP bridge embedded in the DB-owning process (`ecoai-context-provider`), instead of opening the file directly.

**Architecture:** The C++ DB owner gains a tiny header-only HTTP server (`ExplorerBridge`) with its own Ladybug connection on the same `Database`. Explorer's Express backend becomes a proxy client: a `Database` façade switches between the existing embedded backend and a new `ProxyBackend` that forwards Cypher over an `ssh -L` tunnel. The browser keeps calling the unchanged `/api/*` routes.

**Tech Stack:** C++17, `cpp-httplib` (find_package→FetchContent), `nlohmann/json`, GoogleTest, Ladybug C++ API; Node/Express, `axios`, Node built-in `node:test` runner, Vue 3 / Pinia / Bootstrap.

**Spec:** `docs/superpowers/specs/2026-06-17-ladybug-proxy-mode-design.md`

**Repos:**
- Client: `/hdd/Project/ladybug-explorer`
- Server: `/hdd/Project/asm/ecoai-context-provider`

---

## File Structure

**Server (ecoai-context-provider) — new:**
- `include/bridge/ResultJson.h`, `src/bridge/ResultJson.cpp` — Ladybug `Value`/`QueryResult` → `nlohmann::json` (replicates `node_util.cpp`).
- `include/bridge/ExplorerBridge.h`, `src/bridge/ExplorerBridge.cpp` — httplib server + own connection + mutex.
- `tests/bridge/ResultJsonTest.cpp`, `tests/bridge/ExplorerBridgeTest.cpp`.

**Server — modified:**
- `include/graphdb/LadybugGraphStore.h`, `src/graphdb/LadybugGraphStore.cpp` — add `createConnection()`.
- `include/KgService.h` — add `graphStore()` accessor.
- `src/main.cpp` — read bridge config keys, start bridge when enabled.
- `CMakeLists.txt`, `tests/CMakeLists.txt` — httplib dependency + link.

**Client (ladybug-explorer) — new:**
- `src/server/utils/SchemaBuilder.js` — shared `buildSchema(conn)`.
- `src/server/utils/ProxyConnection.js` — `ProxyConnection` + `ProxyResult` (injectable HTTP fn).
- `src/server/utils/ProxyBackend.js` — proxy `Database`-surface backend.
- `src/server/utils/SSHTunnel.js` — `ssh -L` local port-forward manager.
- `src/server/utils/__tests__/ProxyConnection.test.js`, `SchemaBuilder.test.js`, `ProxyBackend.test.js`.

**Client — modified:**
- `src/server/utils/Database.js` — extract embedded class, add façade + `setBackend`.
- `src/server/DBConfig.js` — add `mode === "proxy"` branch + report backend.
- `src/server/Mode.js` and/or `src/server/State.js` — report `backend` field.
- `src/store/ModeStore.js` — `backend` state + `isProxy` getter.
- `src/components/MainLayout.vue` — gate Import; pass backend to settings/reset.
- `src/components/SettingsView/SettingsMainView.vue` — disable Reset in proxy mode.
- `src/components/DBView/DBConfigModal.vue` — add Proxy radio + fields + payload.

---

## PART A — Server (ecoai-context-provider)

> Build/test commands (run from `/hdd/Project/asm/ecoai-context-provider`):
> Configure once: `cmake -S . -B build -DBUILD_TESTING=ON`
> Build tests: `cmake --build build --target ecoai-context-provider-tests -j`
> Run a single test: `./build/tests/ecoai-context-provider-tests --gtest_filter='ResultJson.*'`
> `tests/CMakeLists.txt` globs `src/*.cpp` and `tests/*.cpp` recursively, so new
> files under `src/bridge/` and `tests/bridge/` are picked up automatically once
> the httplib include path is wired (Task A1).

### Task A1: Add cpp-httplib dependency (find_package → FetchContent fallback)

**Files:**
- Modify: `CMakeLists.txt`
- Modify: `tests/CMakeLists.txt`

- [ ] **Step 1: Declare the dependency in the top-level CMakeLists.txt**

Add immediately after the LadybugDB header block (after the
`message(STATUS "Found LadybugDB headers: ...")` line, around line 49):

```cmake
# ── cpp-httplib (Explorer bridge HTTP server) ────────────────────────────────
# Prefer a system/sysroot package; only download when absent.
find_package(httplib QUIET)
if(NOT httplib_FOUND)
    message(STATUS "httplib not found via find_package; fetching v0.18.7")
    FetchContent_Declare(httplib
        GIT_REPOSITORY https://github.com/yhirose/cpp-httplib.git
        GIT_TAG        v0.18.7)
    FetchContent_MakeAvailable(httplib)
else()
    message(STATUS "Found httplib via find_package")
endif()
```

- [ ] **Step 2: Add the new bridge sources and link httplib to the main target**

In the main executable's source list (the block starting near
`src/graphdb/LadybugGraphStore.cpp`, around line 175) add:

```cmake
    src/bridge/ResultJson.cpp
    src/bridge/ExplorerBridge.cpp
```

In the main target's `target_link_libraries(...)` (around line 227) add:

```cmake
        httplib::httplib
```

- [ ] **Step 3: Link httplib into the test target**

In `tests/CMakeLists.txt`, inside `target_link_libraries(${TESTS_NAME} PRIVATE ...)`
add `httplib::httplib` (after `nlohmann_json::nlohmann_json`):

```cmake
    httplib::httplib
```

- [ ] **Step 4: Configure to verify the dependency resolves**

Run: `cmake -S . -B build -DBUILD_TESTING=ON`
Expected: configures without error; prints either "Found httplib via find_package"
or "fetching v0.18.7". (No bridge sources exist yet — that's fine; we only verify
CMake configuration here, not a full build.)

- [ ] **Step 5: Commit**

```bash
git add CMakeLists.txt tests/CMakeLists.txt
git commit -m "build: add cpp-httplib (find_package, FetchContent fallback) for explorer bridge"
```

---

### Task A2: ResultJson — scalar + null serialization (TDD)

**Files:**
- Create: `include/bridge/ResultJson.h`
- Create: `src/bridge/ResultJson.cpp`
- Test: `tests/bridge/ResultJsonTest.cpp`

The serializer mirrors `ladybug/tools/nodejs_api/src_cpp/node_util.cpp`. This task
covers primitives; Tasks A3–A4 add nested/graph types and the QueryResult wrapper.

- [ ] **Step 1: Write the header**

Create `include/bridge/ResultJson.h`:

```cpp
#pragma once

#include <nlohmann/json.hpp>

namespace lbug::common { class Value; }
namespace lbug::main { class QueryResult; }

namespace ecoai::context_provider::bridge {

// Serializes one Ladybug Value to JSON, mirroring the node.js API's
// node_util.cpp::ConvertToNapiObject so the Explorer frontend receives the
// exact shapes it already parses (NODE/REL/_id/_label/etc.).
nlohmann::json valueToJson(const lbug::common::Value& value);

// Serializes a full result: { "rows": [...], "dataTypes": { col: typeString } }.
// Resets the result iterator; reads up to `rowCap` rows (0 = unlimited).
nlohmann::json queryResultToJson(lbug::main::QueryResult& result, std::size_t rowCap);

}  // namespace ecoai::context_provider::bridge
```

- [ ] **Step 2: Write failing tests for scalars and null**

Create `tests/bridge/ResultJsonTest.cpp`:

```cpp
#include <gtest/gtest.h>

#include <lbug.hpp>

#include "bridge/ResultJson.h"

using ecoai::context_provider::bridge::queryResultToJson;
using ecoai::context_provider::bridge::valueToJson;

namespace {

// Runs a query against a shared in-memory DB and returns the first tuple's value 0.
class ResultJsonTest : public ::testing::Test {
protected:
    void SetUp() override {
        db = std::make_unique<lbug::main::Database>(":memory:");
        conn = std::make_unique<lbug::main::Connection>(db.get());
    }
    nlohmann::json firstCellJson(const std::string& cypher) {
        auto result = conn->query(cypher);
        EXPECT_TRUE(result->isSuccess()) << result->getErrorMessage();
        auto tuple = result->getNext();
        return valueToJson(*tuple->getValue(0));
    }
    std::unique_ptr<lbug::main::Database> db;
    std::unique_ptr<lbug::main::Connection> conn;
};

TEST_F(ResultJsonTest, SerializesInteger) {
    EXPECT_EQ(firstCellJson("RETURN 42;"), nlohmann::json(42));
}

TEST_F(ResultJsonTest, SerializesString) {
    EXPECT_EQ(firstCellJson("RETURN 'hello';"), nlohmann::json("hello"));
}

TEST_F(ResultJsonTest, SerializesBool) {
    EXPECT_EQ(firstCellJson("RETURN true;"), nlohmann::json(true));
}

TEST_F(ResultJsonTest, SerializesDouble) {
    EXPECT_EQ(firstCellJson("RETURN 1.5;"), nlohmann::json(1.5));
}

TEST_F(ResultJsonTest, SerializesNull) {
    EXPECT_TRUE(firstCellJson("RETURN null;").is_null());
}

}  // namespace
```

- [ ] **Step 3: Run tests to verify they fail to build/link**

Run: `cmake --build build --target ecoai-context-provider-tests -j`
Expected: build FAILS (no `ResultJson.cpp` symbol / file yet).

- [ ] **Step 4: Implement scalar + null serialization**

Create `src/bridge/ResultJson.cpp`. (Nested/graph types are stubbed with a
`toString()` fallback now; replaced in A3.)

```cpp
#include "bridge/ResultJson.h"

#include <lbug.hpp>

namespace ecoai::context_provider::bridge {

using lbug::common::LogicalTypeID;
using lbug::common::Value;

nlohmann::json valueToJson(const Value& value) {
    if (value.isNull()) return nullptr;
    switch (value.getDataType().getLogicalTypeID()) {
    case LogicalTypeID::BOOL:    return value.getValue<bool>();
    case LogicalTypeID::UINT8:   return value.getValue<uint8_t>();
    case LogicalTypeID::UINT16:  return value.getValue<uint16_t>();
    case LogicalTypeID::UINT32:  return value.getValue<uint32_t>();
    case LogicalTypeID::UINT64:  return value.getValue<uint64_t>();
    case LogicalTypeID::INT8:    return value.getValue<int8_t>();
    case LogicalTypeID::INT16:   return value.getValue<int16_t>();
    case LogicalTypeID::INT32:   return value.getValue<int32_t>();
    case LogicalTypeID::INT64:
    case LogicalTypeID::SERIAL:  return value.getValue<int64_t>();
    case LogicalTypeID::FLOAT:   return value.getValue<float>();
    case LogicalTypeID::DOUBLE:  return value.getValue<double>();
    case LogicalTypeID::UUID:
    case LogicalTypeID::STRING:
    case LogicalTypeID::BLOB:    return value.getValue<std::string>();
    // INT128, nested, and graph types handled in later tasks; fall back to text.
    default:                     return value.toString();
    }
}

nlohmann::json queryResultToJson(lbug::main::QueryResult&, std::size_t) {
    return nlohmann::json::object();  // implemented in Task A4
}

}  // namespace ecoai::context_provider::bridge
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cmake --build build --target ecoai-context-provider-tests -j && ./build/tests/ecoai-context-provider-tests --gtest_filter='ResultJsonTest.*'`
Expected: 5 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add include/bridge/ResultJson.h src/bridge/ResultJson.cpp tests/bridge/ResultJsonTest.cpp
git commit -m "feat(bridge): ResultJson scalar/null value serialization"
```

---

### Task A3: ResultJson — INT128, nested, NODE/REL/RECURSIVE_REL (TDD)

**Files:**
- Modify: `src/bridge/ResultJson.cpp`
- Test: `tests/bridge/ResultJsonTest.cpp`

- [ ] **Step 1: Add failing tests for INT128, list, struct, internal id, node, rel**

Append to `tests/bridge/ResultJsonTest.cpp` inside the anonymous namespace:

```cpp
TEST_F(ResultJsonTest, SerializesInt128AsString) {
    // INT128 has no JSON integer representation; emit a string (matches the
    // explorer's int128Replacer BigInt->string handling).
    auto j = firstCellJson("RETURN CAST(170141183460469231731687303715884105727 AS INT128);");
    EXPECT_TRUE(j.is_string());
    EXPECT_EQ(j.get<std::string>(), "170141183460469231731687303715884105727");
}

TEST_F(ResultJsonTest, SerializesList) {
    auto j = firstCellJson("RETURN [1, 2, 3];");
    EXPECT_EQ(j, nlohmann::json({1, 2, 3}));
}

TEST_F(ResultJsonTest, SerializesStruct) {
    auto j = firstCellJson("RETURN {name: 'a', n: 1};");
    EXPECT_EQ(j["name"], "a");
    EXPECT_EQ(j["n"], 1);
}

TEST_F(ResultJsonTest, SerializesNodeWithIdAndLabel) {
    ASSERT_TRUE(conn->query("CREATE NODE TABLE Person(id INT64, name STRING, PRIMARY KEY(id));")->isSuccess());
    ASSERT_TRUE(conn->query("CREATE (:Person {id: 1, name: 'Alice'});")->isSuccess());
    auto j = firstCellJson("MATCH (p:Person) RETURN p;");
    EXPECT_EQ(j["_label"], "Person");
    EXPECT_EQ(j["name"], "Alice");
    ASSERT_TRUE(j["_id"].is_object());
    EXPECT_TRUE(j["_id"].contains("table"));
    EXPECT_TRUE(j["_id"].contains("offset"));
}

TEST_F(ResultJsonTest, SerializesRelWithSrcDst) {
    ASSERT_TRUE(conn->query("CREATE NODE TABLE City(id INT64, PRIMARY KEY(id));")->isSuccess());
    ASSERT_TRUE(conn->query("CREATE REL TABLE Road(FROM City TO City, dist INT64);")->isSuccess());
    ASSERT_TRUE(conn->query("CREATE (:City {id: 1}); ")->isSuccess());
    ASSERT_TRUE(conn->query("CREATE (:City {id: 2}); ")->isSuccess());
    ASSERT_TRUE(conn->query("MATCH (a:City {id:1}),(b:City {id:2}) CREATE (a)-[:Road {dist: 5}]->(b);")->isSuccess());
    auto j = firstCellJson("MATCH ()-[r:Road]->() RETURN r;");
    EXPECT_EQ(j["_label"], "Road");
    EXPECT_EQ(j["dist"], 5);
    EXPECT_TRUE(j["_src"].contains("offset"));
    EXPECT_TRUE(j["_dst"].contains("offset"));
    EXPECT_TRUE(j["_id"].is_object());
}
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `cmake --build build --target ecoai-context-provider-tests -j && ./build/tests/ecoai-context-provider-tests --gtest_filter='ResultJsonTest.*'`
Expected: the 5 new tests FAIL (currently hitting the `toString()` fallback).

- [ ] **Step 3: Implement INT128, nested, internal-id, node, rel, recursive-rel**

Add these includes at the top of `src/bridge/ResultJson.cpp`:

```cpp
#include "common/types/value/nested.h"
#include "common/types/value/node.h"
#include "common/types/value/recursive_rel.h"
#include "common/types/value/rel.h"
```

Add a helper above `valueToJson`:

```cpp
namespace {
nlohmann::json nodeIdToJson(const lbug::common::nodeID_t& id) {
    return nlohmann::json{{"offset", id.offset}, {"table", id.tableID}};
}
}  // namespace
```

Replace the `default:` fallback's relevant cases by inserting these `case`
branches before `default:` (uses the `lbug::common` nested/node/rel helpers, the
C++ analogues of node_util.cpp):

```cpp
    case LogicalTypeID::INT128:
        return value.toString();  // 128-bit -> decimal string
    case LogicalTypeID::DECIMAL:
        return value.toString();
    case LogicalTypeID::LIST:
    case LogicalTypeID::ARRAY: {
        nlohmann::json arr = nlohmann::json::array();
        auto size = lbug::common::NestedVal::getChildrenSize(&value);
        for (auto i = 0u; i < size; ++i)
            arr.push_back(valueToJson(*lbug::common::NestedVal::getChildVal(&value, i)));
        return arr;
    }
    case LogicalTypeID::STRUCT:
    case LogicalTypeID::UNION: {
        nlohmann::json obj = nlohmann::json::object();
        const auto& names = lbug::common::StructType::getFieldNames(value.getDataType());
        auto size = lbug::common::NestedVal::getChildrenSize(&value);
        for (auto i = 0u; i < size; ++i)
            obj[names[i]] = valueToJson(*lbug::common::NestedVal::getChildVal(&value, i));
        return obj;
    }
    case LogicalTypeID::MAP: {
        nlohmann::json obj = nlohmann::json::object();
        auto size = lbug::common::NestedVal::getChildrenSize(&value);
        for (auto i = 0u; i < size; ++i) {
            auto* entry = lbug::common::NestedVal::getChildVal(&value, i);
            auto key = lbug::common::NestedVal::getChildVal(entry, 0)->toString();
            obj[key] = valueToJson(*lbug::common::NestedVal::getChildVal(entry, 1));
        }
        return obj;
    }
    case LogicalTypeID::INTERNAL_ID:
        return nodeIdToJson(value.getValue<lbug::common::nodeID_t>());
    case LogicalTypeID::NODE: {
        nlohmann::json obj = nlohmann::json::object();
        auto n = lbug::common::NodeVal::getNumProperties(&value);
        for (auto i = 0u; i < n; ++i)
            obj[lbug::common::NodeVal::getPropertyName(&value, i)] =
                valueToJson(*lbug::common::NodeVal::getPropertyVal(&value, i));
        auto* labelVal = lbug::common::NodeVal::getLabelVal(&value);
        auto* idVal = lbug::common::NodeVal::getNodeIDVal(&value);
        obj["_label"] = labelVal ? nlohmann::json(labelVal->getValue<std::string>()) : nlohmann::json(nullptr);
        obj["_id"] = idVal ? valueToJson(*idVal) : nlohmann::json(nullptr);
        return obj;
    }
    case LogicalTypeID::REL: {
        nlohmann::json obj = nlohmann::json::object();
        auto n = lbug::common::RelVal::getNumProperties(&value);
        for (auto i = 0u; i < n; ++i)
            obj[lbug::common::RelVal::getPropertyName(&value, i)] =
                valueToJson(*lbug::common::RelVal::getPropertyVal(&value, i));
        auto* srcVal = lbug::common::RelVal::getSrcNodeIDVal(&value);
        auto* dstVal = lbug::common::RelVal::getDstNodeIDVal(&value);
        auto* labelVal = lbug::common::RelVal::getLabelVal(&value);
        auto* idVal = lbug::common::RelVal::getIDVal(&value);
        obj["_src"] = srcVal ? nodeIdToJson(srcVal->getValue<lbug::common::nodeID_t>()) : nlohmann::json(nullptr);
        obj["_dst"] = dstVal ? nodeIdToJson(dstVal->getValue<lbug::common::nodeID_t>()) : nlohmann::json(nullptr);
        obj["_label"] = labelVal ? nlohmann::json(labelVal->getValue<std::string>()) : nlohmann::json(nullptr);
        obj["_id"] = idVal ? valueToJson(*idVal) : nlohmann::json(nullptr);
        return obj;
    }
    case LogicalTypeID::RECURSIVE_REL: {
        nlohmann::json obj = nlohmann::json::object();
        obj["_nodes"] = valueToJson(*lbug::common::RecursiveRelVal::getNodes(&value));
        obj["_rels"] = valueToJson(*lbug::common::RecursiveRelVal::getRels(&value));
        return obj;
    }
```

> Note: confirm exact namespaces/signatures against
> `ladybug/src/include/common/types/value/{node,rel,recursive_rel,nested}.h` if a
> symbol does not resolve; the node.js binding in `node_util.cpp` calls the same
> helpers (unqualified, via `using namespace lbug::common`).

- [ ] **Step 4: Run tests to verify all pass**

Run: `cmake --build build --target ecoai-context-provider-tests -j && ./build/tests/ecoai-context-provider-tests --gtest_filter='ResultJsonTest.*'`
Expected: all 10 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/bridge/ResultJson.cpp tests/bridge/ResultJsonTest.cpp
git commit -m "feat(bridge): ResultJson INT128/nested/node/rel serialization"
```

---

### Task A4: ResultJson — date/timestamp + queryResultToJson (TDD)

**Files:**
- Modify: `src/bridge/ResultJson.cpp`
- Test: `tests/bridge/ResultJsonTest.cpp`

- [ ] **Step 1: Add failing tests for ISO dates and the full result wrapper**

Append to `tests/bridge/ResultJsonTest.cpp`:

```cpp
TEST_F(ResultJsonTest, SerializesDateAsIsoString) {
    auto j = firstCellJson("RETURN DATE('2024-01-15');");
    ASSERT_TRUE(j.is_string());
    EXPECT_EQ(j.get<std::string>().substr(0, 10), "2024-01-15");
}

TEST_F(ResultJsonTest, QueryResultHasRowsAndDataTypes) {
    auto result = conn->query("RETURN 1 AS a, 'x' AS b;");
    ASSERT_TRUE(result->isSuccess());
    auto j = queryResultToJson(*result, 0);
    ASSERT_TRUE(j["rows"].is_array());
    ASSERT_EQ(j["rows"].size(), 1u);
    EXPECT_EQ(j["rows"][0]["a"], 1);
    EXPECT_EQ(j["rows"][0]["b"], "x");
    EXPECT_EQ(j["dataTypes"]["a"], "INT64");
    EXPECT_EQ(j["dataTypes"]["b"], "STRING");
}

TEST_F(ResultJsonTest, QueryResultRespectsRowCap) {
    auto result = conn->query("UNWIND [1,2,3,4,5] AS x RETURN x;");
    ASSERT_TRUE(result->isSuccess());
    auto j = queryResultToJson(*result, 2);
    EXPECT_EQ(j["rows"].size(), 2u);
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cmake --build build --target ecoai-context-provider-tests -j && ./build/tests/ecoai-context-provider-tests --gtest_filter='ResultJsonTest.*'`
Expected: the 3 new tests FAIL.

- [ ] **Step 3: Implement date/timestamp cases and queryResultToJson**

Add date/time cases before `default:` in `valueToJson` (emit ISO-8601 so the wire
payload matches the embedded path, where JS `Date` is `JSON.stringify`-d):

```cpp
    case LogicalTypeID::DATE:
    case LogicalTypeID::TIMESTAMP:
    case LogicalTypeID::TIMESTAMP_TZ:
    case LogicalTypeID::TIMESTAMP_NS:
    case LogicalTypeID::TIMESTAMP_MS:
    case LogicalTypeID::TIMESTAMP_SEC:
        return value.toString();  // Ladybug renders ISO-8601 (e.g. 2024-01-15)
    case LogicalTypeID::INTERVAL:
        return value.toString();
```

Replace the stub `queryResultToJson` body:

```cpp
nlohmann::json queryResultToJson(lbug::main::QueryResult& result, std::size_t rowCap) {
    nlohmann::json out = nlohmann::json::object();
    auto names = result.getColumnNames();
    auto types = result.getColumnDataTypes();
    nlohmann::json dataTypes = nlohmann::json::object();
    for (size_t i = 0; i < names.size(); ++i)
        dataTypes[names[i]] = types[i].toString();
    out["dataTypes"] = dataTypes;

    nlohmann::json rows = nlohmann::json::array();
    std::size_t count = 0;
    while (result.hasNext()) {
        if (rowCap != 0 && count >= rowCap) break;
        auto tuple = result.getNext();
        nlohmann::json row = nlohmann::json::object();
        for (size_t i = 0; i < names.size(); ++i)
            row[names[i]] = valueToJson(*tuple->getValue(i));
        rows.push_back(std::move(row));
        ++count;
    }
    out["rows"] = std::move(rows);
    return out;
}
```

> If `getColumnDataTypes()` returns `LogicalType` by value/reference, `.toString()`
> yields the same strings the node API exposes (e.g. `"NODE"`, `"INT64"`). Confirm
> against `ladybug/src/include/main/query_result.h`.

- [ ] **Step 4: Run tests to verify all pass**

Run: `cmake --build build --target ecoai-context-provider-tests -j && ./build/tests/ecoai-context-provider-tests --gtest_filter='ResultJsonTest.*'`
Expected: all 13 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/bridge/ResultJson.cpp tests/bridge/ResultJsonTest.cpp
git commit -m "feat(bridge): ResultJson date/timestamp + queryResultToJson wrapper"
```

---

### Task A5: LadybugGraphStore.createConnection() (TDD)

**Files:**
- Modify: `include/graphdb/LadybugGraphStore.h`
- Modify: `src/graphdb/LadybugGraphStore.cpp`
- Test: `tests/bridge/ExplorerBridgeTest.cpp` (new file; reused by Task A6)

- [ ] **Step 1: Write a failing test for a second working connection**

Create `tests/bridge/ExplorerBridgeTest.cpp`:

```cpp
#include <gtest/gtest.h>

#include <lbug.hpp>

#include "graphdb/LadybugGraphStore.h"

using ecoai::context_provider::graphdb::LadybugGraphStore;

TEST(LadybugGraphStoreConnection, CreateConnectionSharesDatabase) {
    LadybugGraphStore store(":memory:");
    store.execute("CREATE NODE TABLE T(id INT64, PRIMARY KEY(id));");
    store.execute("CREATE (:T {id: 7});");

    auto conn = store.createConnection();
    ASSERT_NE(conn, nullptr);
    auto result = conn->query("MATCH (t:T) RETURN t.id;");
    ASSERT_TRUE(result->isSuccess()) << result->getErrorMessage();
    ASSERT_TRUE(result->hasNext());
    EXPECT_EQ(result->getNext()->getValue(0)->getValue<int64_t>(), 7);
}
```

- [ ] **Step 2: Run test to verify it fails to compile**

Run: `cmake --build build --target ecoai-context-provider-tests -j`
Expected: FAIL — `createConnection` is not a member of `LadybugGraphStore`.

- [ ] **Step 3: Declare and implement createConnection**

In `include/graphdb/LadybugGraphStore.h`, add to the public section (after
`bool isEmpty() const override;`):

```cpp
    // Creates an additional Connection on the same underlying Database. Used by
    // the Explorer bridge so it never contends for the domain's connection.
    std::unique_ptr<lbug::main::Connection> createConnection() const;
```

In `src/graphdb/LadybugGraphStore.cpp`, add after `isEmpty()`:

```cpp
std::unique_ptr<lbug::main::Connection> LadybugGraphStore::createConnection() const
{
    return std::make_unique<lbug::main::Connection>(m_database.get());
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cmake --build build --target ecoai-context-provider-tests -j && ./build/tests/ecoai-context-provider-tests --gtest_filter='LadybugGraphStoreConnection.*'`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add include/graphdb/LadybugGraphStore.h src/graphdb/LadybugGraphStore.cpp tests/bridge/ExplorerBridgeTest.cpp
git commit -m "feat(graphdb): LadybugGraphStore.createConnection for bridge use"
```

---

### Task A6: ExplorerBridge HTTP server (TDD)

**Files:**
- Create: `include/bridge/ExplorerBridge.h`
- Create: `src/bridge/ExplorerBridge.cpp`
- Modify: `tests/bridge/ExplorerBridgeTest.cpp`

- [ ] **Step 1: Write the header**

Create `include/bridge/ExplorerBridge.h`:

```cpp
#pragma once

#include <cstdint>
#include <memory>
#include <mutex>
#include <string>
#include <thread>

namespace lbug::main { class Connection; }
namespace httplib { class Server; }

namespace ecoai::context_provider::graphdb { class LadybugGraphStore; }

namespace ecoai::context_provider::bridge {

// Embedded HTTP server exposing the owning process's Ladybug DB to Ladybug
// Explorer. Binds to `bind_addr` (default loopback) and serves POST /cypher,
// GET /version, GET /ping. Runs on its own thread with its own Connection,
// serialized by a mutex (one in-flight query at a time).
class ExplorerBridge {
public:
    ExplorerBridge(graphdb::LadybugGraphStore& store,
                   std::string bind_addr, uint16_t port);
    ~ExplorerBridge();

    ExplorerBridge(const ExplorerBridge&) = delete;
    ExplorerBridge& operator=(const ExplorerBridge&) = delete;

    void start();  // begins listening on a background thread
    void stop();   // stops the server and joins the thread

private:
    std::unique_ptr<lbug::main::Connection> m_conn;
    std::mutex m_conn_mutex;
    std::string m_bind_addr;
    uint16_t m_port;
    std::unique_ptr<httplib::Server> m_server;
    std::thread m_thread;
};

}  // namespace ecoai::context_provider::bridge
```

- [ ] **Step 2: Write failing integration tests**

Append to `tests/bridge/ExplorerBridgeTest.cpp`:

```cpp
#include <chrono>
#include <thread>

#include <httplib.h>
#include <nlohmann/json.hpp>

#include "bridge/ExplorerBridge.h"

using ecoai::context_provider::bridge::ExplorerBridge;

namespace {
constexpr uint16_t kTestPort = 18790;

struct BridgeFixture : ::testing::Test {
    void SetUp() override {
        store = std::make_unique<LadybugGraphStore>(":memory:");
        store->execute("CREATE NODE TABLE P(id INT64, name STRING, PRIMARY KEY(id));");
        store->execute("CREATE (:P {id: 1, name: 'Alice'});");
        bridge = std::make_unique<ExplorerBridge>(*store, "127.0.0.1", kTestPort);
        bridge->start();
        // Poll /ping until the listener is up (max ~2s).
        httplib::Client c("127.0.0.1", kTestPort);
        for (int i = 0; i < 40; ++i) {
            if (auto r = c.Get("/ping"); r && r->status == 200) return;
            std::this_thread::sleep_for(std::chrono::milliseconds(50));
        }
        FAIL() << "bridge did not start";
    }
    void TearDown() override { bridge->stop(); }
    std::unique_ptr<LadybugGraphStore> store;
    std::unique_ptr<ExplorerBridge> bridge;
};

TEST_F(BridgeFixture, PingReturnsOk) {
    httplib::Client c("127.0.0.1", kTestPort);
    auto r = c.Get("/ping");
    ASSERT_TRUE(r);
    EXPECT_EQ(r->status, 200);
    EXPECT_EQ(nlohmann::json::parse(r->body)["status"], "ok");
}

TEST_F(BridgeFixture, CypherReturnsRowsAndDataTypes) {
    httplib::Client c("127.0.0.1", kTestPort);
    nlohmann::json req{{"query", "MATCH (p:P) RETURN p.name AS name;"}};
    auto r = c.Post("/cypher", req.dump(), "application/json");
    ASSERT_TRUE(r);
    ASSERT_EQ(r->status, 200) << r->body;
    auto j = nlohmann::json::parse(r->body);
    EXPECT_FALSE(j["isMultiStatement"].get<bool>());
    EXPECT_EQ(j["rows"][0]["name"], "Alice");
    EXPECT_EQ(j["dataTypes"]["name"], "STRING");
}

TEST_F(BridgeFixture, CypherErrorReturns400) {
    httplib::Client c("127.0.0.1", kTestPort);
    nlohmann::json req{{"query", "MATCH (x:DoesNotExist) RETURN x;"}};
    auto r = c.Post("/cypher", req.dump(), "application/json");
    ASSERT_TRUE(r);
    EXPECT_EQ(r->status, 400);
    EXPECT_TRUE(nlohmann::json::parse(r->body).contains("error"));
}

TEST_F(BridgeFixture, VersionReturnsStorageVersion) {
    httplib::Client c("127.0.0.1", kTestPort);
    auto r = c.Get("/version");
    ASSERT_TRUE(r);
    ASSERT_EQ(r->status, 200) << r->body;
    auto j = nlohmann::json::parse(r->body);
    EXPECT_TRUE(j.contains("version"));
    EXPECT_TRUE(j.contains("storageVersion"));
}
}  // namespace
```

- [ ] **Step 3: Run tests to verify they fail to build**

Run: `cmake --build build --target ecoai-context-provider-tests -j`
Expected: FAIL — no `ExplorerBridge.cpp`.

- [ ] **Step 4: Implement the server**

Create `src/bridge/ExplorerBridge.cpp`:

```cpp
#include "bridge/ExplorerBridge.h"

#include <httplib.h>
#include <lbug.hpp>
#include <nlohmann/json.hpp>

#include "bridge/ResultJson.h"
#include "graphdb/LadybugGraphStore.h"

namespace ecoai::context_provider::bridge {

namespace {
constexpr std::size_t kRowCap = 0;  // 0 = unlimited; client queries use LIMIT.

// Builds the response for one or many results from a (possibly multi-statement)
// query. The Ladybug C++ QueryResult chains additional results via getNext-result.
nlohmann::json buildCypherResponse(lbug::main::QueryResult& first) {
    if (!first.hasNextQueryResult()) {
        auto body = queryResultToJson(first, kRowCap);
        body["isMultiStatement"] = false;
        return body;
    }
    nlohmann::json body{{"isMultiStatement", true}, {"results", nlohmann::json::array()}};
    body["results"].push_back(queryResultToJson(first, kRowCap));
    auto* next = first.getNextQueryResult();
    while (next != nullptr) {
        body["results"].push_back(queryResultToJson(*next, kRowCap));
        next = next->hasNextQueryResult() ? next->getNextQueryResult() : nullptr;
    }
    return body;
}
}  // namespace

ExplorerBridge::ExplorerBridge(graphdb::LadybugGraphStore& store,
                               std::string bind_addr, uint16_t port)
    : m_conn(store.createConnection()),
      m_bind_addr(std::move(bind_addr)),
      m_port(port),
      m_server(std::make_unique<httplib::Server>()) {}

ExplorerBridge::~ExplorerBridge() { stop(); }

void ExplorerBridge::start() {
    m_server->Post("/cypher", [this](const httplib::Request& req, httplib::Response& res) {
        try {
            auto in = nlohmann::json::parse(req.body);
            const std::string query = in.at("query").get<std::string>();
            std::lock_guard<std::mutex> lock(m_conn_mutex);
            std::unique_ptr<lbug::main::QueryResult> result;
            if (in.contains("params") && in["params"].is_object() && !in["params"].empty()) {
                auto prepared = m_conn->prepare(query);
                std::unordered_map<std::string, std::unique_ptr<lbug::common::Value>> params;
                for (auto& [k, v] : in["params"].items())
                    params[k] = std::make_unique<lbug::common::Value>(
                        lbug::common::Value::createValue(v.dump()));  // see note below
                result = m_conn->executeWithParams(prepared.get(), std::move(params));
            } else {
                result = m_conn->query(query);
            }
            if (!result->isSuccess()) {
                res.status = 400;
                res.set_content(nlohmann::json{{"error", result->getErrorMessage()}}.dump(),
                                "application/json");
                return;
            }
            res.set_content(buildCypherResponse(*result).dump(), "application/json");
        } catch (const std::exception& e) {
            res.status = 400;
            res.set_content(nlohmann::json{{"error", e.what()}}.dump(), "application/json");
        }
    });

    m_server->Get("/version", [this](const httplib::Request&, httplib::Response& res) {
        try {
            std::lock_guard<std::mutex> lock(m_conn_mutex);
            std::string version;
            auto r = m_conn->query("CALL db_version() RETURN *;");
            if (r->isSuccess() && r->hasNext()) version = r->getNext()->getValue(0)->toString();
            nlohmann::json out{{"version", version},
                               {"storageVersion", lbug::storage::StorageVersionInfo::getStorageVersion()}};
            res.set_content(out.dump(), "application/json");
        } catch (const std::exception& e) {
            res.status = 500;
            res.set_content(nlohmann::json{{"error", e.what()}}.dump(), "application/json");
        }
    });

    m_server->Get("/ping", [](const httplib::Request&, httplib::Response& res) {
        res.set_content(nlohmann::json{{"status", "ok"}}.dump(), "application/json");
    });

    m_thread = std::thread([this] { m_server->listen(m_bind_addr.c_str(), m_port); });
}

void ExplorerBridge::stop() {
    if (m_server) m_server->stop();
    if (m_thread.joinable()) m_thread.join();
}

}  // namespace ecoai::context_provider::bridge
```

> **Notes for the implementer (resolve against the installed Ladybug headers):**
> - Param binding: the exact prepared-statement API may be `connection->execute(prepared.get(), params)` or `executeWithParams`. Match the signature in `ladybug/src/include/main/connection.h`. For typed params, build `lbug::common::Value` from the JSON scalar directly (bool/int/double/string) rather than via `dump()`; the `dump()` shown is a placeholder — replace with a small `jsonToValue()` that switches on `nlohmann::json::value_t`. The explorer currently only sends params for import (out of scope here) and rarely for ad-hoc queries, so a minimal scalar mapping is sufficient.
> - Multi-statement chaining: verify `hasNextQueryResult()`/`getNextQueryResult()` exist in `query_result.h` (they are the C++ equivalents of the node API's result array). If the API differs, fall back to `isMultiStatement:false` for the single result.
> - Storage version constant: confirm `lbug::storage::StorageVersionInfo::getStorageVersion()` (or the symbol exposed as `STORAGE_VERSION` in the node binding) and include the right header.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cmake --build build --target ecoai-context-provider-tests -j && ./build/tests/ecoai-context-provider-tests --gtest_filter='BridgeFixture.*'`
Expected: 4 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add include/bridge/ExplorerBridge.h src/bridge/ExplorerBridge.cpp tests/bridge/ExplorerBridgeTest.cpp
git commit -m "feat(bridge): ExplorerBridge HTTP server (cypher/version/ping)"
```

---

### Task A7: Wire the bridge into main.cpp behind config (manual verification)

**Files:**
- Modify: `include/KgService.h`
- Modify: `src/main.cpp`

- [ ] **Step 1: Add the graphStore() accessor to KgService**

In `include/KgService.h`, add to the public section (after the method
declarations, before `private:`):

```cpp
    // Exposes the underlying store so an optional Explorer bridge can open its
    // own connection on the same Database.
    graphdb::LadybugGraphStore& graphStore() { return m_store; }
```

- [ ] **Step 2: Read bridge config and start the bridge in main.cpp**

In `src/main.cpp`, add the include near the other service includes:

```cpp
#include "bridge/ExplorerBridge.h"
```

Add config-key constants in the anonymous namespace (near `kKgDatabasePath`):

```cpp
constexpr const char* kBridgeEnabled = "explorer_bridge_enabled";
constexpr const char* kBridgePort    = "explorer_bridge_port";
constexpr const char* kBridgeBind    = "explorer_bridge_bind";
```

After the config is parsed (after the `orchestratorPath` line ~79), read:

```cpp
        const bool bridgeEnabled = config.value(kBridgeEnabled, false);
        const int  bridgePort    = config.value(kBridgePort, 7999);
        const std::string bridgeBind = config.value(kBridgeBind, std::string("127.0.0.1"));
```

After `KgService kgService(...)` is constructed (after the closing `);` ~117),
start the bridge when enabled:

```cpp
        std::unique_ptr<ecoai::context_provider::bridge::ExplorerBridge> explorerBridge;
        if (bridgeEnabled) {
            explorerBridge = std::make_unique<ecoai::context_provider::bridge::ExplorerBridge>(
                kgService.graphStore(), bridgeBind, static_cast<uint16_t>(bridgePort));
            explorerBridge->start();
            LOG_INFO("Explorer bridge listening on ", bridgeBind, ":", bridgePort);
        } else {
            LOG_INFO("Explorer bridge disabled (set explorer_bridge_enabled=true to enable)");
        }
```

(The `unique_ptr` lives to end of `main`, so the bridge stops/joins on shutdown.)

- [ ] **Step 3: Build the full binary**

Run: `cmake --build build --target ecoai-context-provider -j`
Expected: links successfully.

- [ ] **Step 4: Manually verify the bridge end-to-end**

Run (in one terminal), with a config enabling the bridge against an in-memory DB
or a test DB directory:

```bash
# Ensure the config used at CONFIG_FILE_PATH has:
#   "explorer_bridge_enabled": true, "explorer_bridge_port": 7999
./build/ecoai-context-provider &
sleep 1
curl -s http://127.0.0.1:7999/ping
curl -s -X POST http://127.0.0.1:7999/cypher \
     -H 'Content-Type: application/json' \
     -d '{"query":"RETURN 1 AS a;"}'
curl -s http://127.0.0.1:7999/version
```

Expected: `{"status":"ok"}`, a `{"rows":[{"a":1}],"dataTypes":{"a":"INT64"},...}`
payload, and a version object. Stop with `kill %1`.

- [ ] **Step 5: Commit**

```bash
git add include/KgService.h src/main.cpp
git commit -m "feat: start ExplorerBridge from main when explorer_bridge_enabled"
```

---

## PART B — Client (ladybug-explorer)

> Test command (run from `/hdd/Project/ladybug-explorer`): `node --test src/server/utils/__tests__/`
> Node's built-in runner — no new dependencies. ESLint is the existing lint gate.

### Task B1: Extract buildSchema(conn) into SchemaBuilder (TDD)

**Files:**
- Create: `src/server/utils/SchemaBuilder.js`
- Modify: `src/server/utils/Database.js:260-307`
- Test: `src/server/utils/__tests__/SchemaBuilder.test.js`

- [ ] **Step 1: Write a failing test using a fake connection**

Create `src/server/utils/__tests__/SchemaBuilder.test.js`:

```js
const test = require("node:test");
const assert = require("node:assert");
const { buildSchema } = require("../SchemaBuilder");

// Fake connection mimicking the native query()/getAll() surface used by buildSchema.
function fakeConn(responses) {
  return {
    query(cypher) {
      const key = Object.keys(responses).find((k) => cypher.includes(k));
      const rows = responses[key] || [];
      return Promise.resolve({ getAll: () => Promise.resolve(rows), close() {} });
    },
  };
}

test("buildSchema groups node and rel tables with properties", async () => {
  const conn = fakeConn({
    "show_tables": [
      { name: "Person", type: "NODE" },
      { name: "Knows", type: "REL" },
    ],
    "TABLE_INFO('Person')": [{ name: "id", type: "INT64", "primary key": true }],
    "TABLE_INFO('Knows')": [{ name: "since", type: "INT64", "primary key": false }],
    "SHOW_CONNECTION('Knows')": [
      { "source table name": "Person", "destination table name": "Person" },
    ],
  });
  const schema = await buildSchema(conn);
  assert.equal(schema.nodeTables.length, 1);
  assert.equal(schema.nodeTables[0].name, "Person");
  assert.equal(schema.nodeTables[0].properties[0].isPrimaryKey, true);
  assert.equal(schema.relTables.length, 1);
  assert.deepEqual(schema.relTables[0].connectivity, [{ src: "Person", dst: "Person" }]);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test src/server/utils/__tests__/SchemaBuilder.test.js`
Expected: FAIL — cannot find module `../SchemaBuilder`.

- [ ] **Step 3: Create SchemaBuilder by moving the logic out of Database.getSchema**

Create `src/server/utils/SchemaBuilder.js` (logic lifted verbatim from
`Database.js` `getSchema`, parameterized on `conn`):

```js
const TABLE_TYPES = { NODE: "NODE", REL: "REL" };

// Builds the explorer schema object from any connection exposing the native
// query()/getAll() surface (embedded Connection or ProxyConnection).
async function buildSchema(conn) {
  const result = await conn.query("CALL show_tables() RETURN *;");
  const tables = await result.getAll();
  if (result.close) result.close();
  const nodeTables = [];
  const relTables = [];
  for (const table of tables) {
    const properties = (
      await conn.query(`CALL TABLE_INFO('${table.name}') RETURN *;`).then((res) => res.getAll())
    ).map((property) => ({
      name: property.name,
      type: property.type,
      isPrimaryKey: property["primary key"],
    }));
    if (table.type === TABLE_TYPES.NODE) {
      delete table["type"];
      table.properties = properties;
      nodeTables.push(table);
    } else if (table.type === TABLE_TYPES.REL) {
      delete table["type"];
      properties.forEach((property) => { delete property.isPrimaryKey; });
      table.properties = properties;
      const connectivity = await conn
        .query(`CALL SHOW_CONNECTION('${table.name}') RETURN *;`)
        .then((res) => res.getAll());
      table.connectivity = [];
      connectivity.forEach((c) => {
        table.connectivity.push({
          src: c["source table name"],
          dst: c["destination table name"],
        });
      });
      relTables.push(table);
    }
  }
  nodeTables.sort((a, b) => a.name.localeCompare(b.name));
  relTables.sort((a, b) => a.name.localeCompare(b.name));
  return { nodeTables, relTables };
}

module.exports = { buildSchema };
```

- [ ] **Step 4: Make Database.getSchema delegate to buildSchema**

In `src/server/utils/Database.js`, add near the top:

```js
const { buildSchema } = require("./SchemaBuilder");
```

Replace the body of `async getSchema()` (lines ~260-307) with:

```js
  async getSchema() {
    const conn = this.getConnection();
    try {
      return await buildSchema(conn);
    } finally {
      this.releaseConnection(conn);
    }
  }
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test src/server/utils/__tests__/SchemaBuilder.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/server/utils/SchemaBuilder.js src/server/utils/Database.js src/server/utils/__tests__/SchemaBuilder.test.js
git commit -m "refactor(server): extract buildSchema(conn) into SchemaBuilder"
```

---

### Task B2: ProxyConnection + ProxyResult (TDD)

**Files:**
- Create: `src/server/utils/ProxyConnection.js`
- Test: `src/server/utils/__tests__/ProxyConnection.test.js`

- [ ] **Step 1: Write failing tests with an injected HTTP function**

Create `src/server/utils/__tests__/ProxyConnection.test.js`:

```js
const test = require("node:test");
const assert = require("node:assert");
const { ProxyConnection } = require("../ProxyConnection");

// Fake HTTP post: returns the canned bridge payload regardless of input.
function fakePost(payload) {
  return async () => ({ data: payload });
}

test("query exposes native-style result accessors", async () => {
  const conn = new ProxyConnection(fakePost({
    isMultiStatement: false,
    rows: [{ a: 1 }, { a: 2 }],
    dataTypes: { a: "INT64" },
  }));
  const res = await conn.query("RETURN 1 AS a;");
  assert.equal(res.getNumTuples(), 2);
  assert.deepEqual(await res.getAll(), [{ a: 1 }, { a: 2 }]);
  assert.deepEqual(await res.getColumnNames(), ["a"]);
  assert.deepEqual(await res.getColumnDataTypes(), ["INT64"]);
  assert.deepEqual(await res.getNext(), { a: 1 });
  assert.deepEqual(await res.getNext(), { a: 2 });
});

test("multi-statement query returns an array of results", async () => {
  const conn = new ProxyConnection(fakePost({
    isMultiStatement: true,
    results: [
      { rows: [{ a: 1 }], dataTypes: { a: "INT64" } },
      { rows: [{ b: 2 }], dataTypes: { b: "INT64" } },
    ],
  }));
  const res = await conn.query("RETURN 1; RETURN 2;");
  assert.ok(Array.isArray(res));
  assert.equal(res.length, 2);
  assert.equal(res[1].getNumTuples(), 1);
});

test("prepare/execute forwards params", async () => {
  let seen = null;
  const post = async (_path, body) => { seen = body; return { data: { isMultiStatement: false, rows: [], dataTypes: {} } }; };
  const conn = new ProxyConnection(post);
  const stmt = await conn.prepare("RETURN $x;");
  await conn.execute(stmt, { x: 5 });
  assert.deepEqual(seen.params, { x: 5 });
  assert.equal(seen.query, "RETURN $x;");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test src/server/utils/__tests__/ProxyConnection.test.js`
Expected: FAIL — cannot find module `../ProxyConnection`.

- [ ] **Step 3: Implement ProxyConnection and ProxyResult**

Create `src/server/utils/ProxyConnection.js`:

```js
// Mimics the subset of the native Ladybug Connection/QueryResult API that the
// explorer server routes use, but forwards Cypher to the remote bridge over HTTP.
// `post(path, body)` is injected (axios in production, a fake in tests) and must
// resolve to an object shaped like an axios response: { data }.

class ProxyResult {
  constructor(single) {
    this._rows = single.rows || [];
    this._dataTypes = single.dataTypes || {};
    this._cursor = 0;
  }
  getNumTuples() { return this._rows.length; }
  async getAll() { return this._rows; }
  async getNext() { return this._rows[this._cursor++]; }
  async getColumnNames() { return Object.keys(this._dataTypes); }
  async getColumnDataTypes() { return Object.values(this._dataTypes); }
  close() { /* no native resource to free */ }
}

class ProxyConnection {
  constructor(post) { this._post = post; }

  async _run(query, params) {
    const body = params && Object.keys(params).length ? { query, params } : { query };
    const res = await this._post("/cypher", body);
    const data = res.data;
    if (data.isMultiStatement) {
      return data.results.map((r) => new ProxyResult(r));
    }
    return new ProxyResult(data);
  }

  // Plain query. A progress callback (2nd arg) is accepted but ignored — there is
  // no streaming over the proxy.
  query(query) { return this._run(query); }

  // prepare/execute: the bridge re-prepares per call, so prepare just carries the
  // query text forward.
  async prepare(query) { return { query }; }
  execute(prepared, params) { return this._run(prepared.query, params); }
}

module.exports = { ProxyConnection, ProxyResult };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test src/server/utils/__tests__/ProxyConnection.test.js`
Expected: 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/utils/ProxyConnection.js src/server/utils/__tests__/ProxyConnection.test.js
git commit -m "feat(server): ProxyConnection/ProxyResult forwarding cypher over HTTP"
```

---

### Task B3: ProxyBackend (TDD)

**Files:**
- Create: `src/server/utils/ProxyBackend.js`
- Test: `src/server/utils/__tests__/ProxyBackend.test.js`

- [ ] **Step 1: Write failing tests**

Create `src/server/utils/__tests__/ProxyBackend.test.js`:

```js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test src/server/utils/__tests__/ProxyBackend.test.js`
Expected: FAIL — cannot find module `../ProxyBackend`.

- [ ] **Step 3: Implement ProxyBackend**

Create `src/server/utils/ProxyBackend.js`:

```js
const { ProxyConnection } = require("./ProxyConnection");
const { buildSchema } = require("./SchemaBuilder");

// Database-facade backend that talks to a remote Ladybug process over the bridge.
// `http` is { post(path, body), get(path) } — axios bound to the tunnel base URL
// in production, a fake in tests.
class ProxyBackend {
  constructor(meta, http) {
    this._meta = meta;            // { host, bridgePort, localPort, user }
    this._http = http;
    this._conn = new ProxyConnection((path, body) => http.post(path, body));
  }

  getAccessModeString() { return "READ_WRITE"; }
  getConnection() { return this._conn; }
  releaseConnection() { return true; }

  async getSchema() { return buildSchema(this._conn); }

  async getDbVersion() {
    const res = await this._http.get("/version");
    return { version: res.data.version, storageVersion: res.data.storageVersion };
  }

  getCurrentConfig() {
    return {
      mode: "proxy",
      isInMemory: false,
      host: this._meta.host,
      bridgePort: this._meta.bridgePort,
      user: this._meta.user,
    };
  }

  async reset() { throw new Error("Reset is not supported in proxy mode."); }
  async reconfigure() { throw new Error("Reconfigure is not supported in proxy mode."); }
}

module.exports = { ProxyBackend };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test src/server/utils/__tests__/ProxyBackend.test.js`
Expected: 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/utils/ProxyBackend.js src/server/utils/__tests__/ProxyBackend.test.js
git commit -m "feat(server): ProxyBackend exposing Database surface over the bridge"
```

---

### Task B4: Database façade with switchable backend

**Files:**
- Modify: `src/server/utils/Database.js`

This converts the exported singleton into a façade so routes (which `require` it
at module load) transparently use either the embedded backend (default) or a
proxy backend, without changing any route code.

- [ ] **Step 1: Rename the class and export a delegating façade**

In `src/server/utils/Database.js`:
1. Rename `class Database` → `class EmbeddedDatabase` (the existing class, unchanged otherwise).
2. Replace the final `module.exports = new Database();` with the façade below:

```js
// Façade: routes keep calling these methods; the active backend is the embedded
// DB by default and can be swapped to a proxy backend at runtime (DB menu).
class DatabaseFacade {
  constructor() {
    this._embedded = new EmbeddedDatabase();
    this._active = this._embedded;
  }
  // Backend management (used by DBConfig).
  get embedded() { return this._embedded; }
  get isProxy() { return this._active !== this._embedded; }
  useEmbedded() { this._active = this._embedded; }
  useProxy(backend) { this._active = backend; }

  // Delegated surface (everything the routes call).
  get lbug() { return this._embedded.lbug; }   // STORAGE_VERSION source for embedded paths
  getAccessModeString() { return this._active.getAccessModeString(); }
  getConnection() { return this._active.getConnection(); }
  releaseConnection(c) { return this._active.releaseConnection(c); }
  getSchema() { return this._active.getSchema(); }
  getDbVersion() { return this._active.getDbVersion(); }
  getCurrentConfig() { return this._active.getCurrentConfig(); }
  reconfigure(opts) { return this._active.reconfigure(opts); }
  reset() { return this._active.reset(); }
}

module.exports = new DatabaseFacade();
```

> The embedded class's constructor must still run at load time exactly as today
> (it opens the configured DB). Only the export wrapper changes.

- [ ] **Step 2: Verify nothing else references the class by name**

Run: `grep -rn "new Database(" src/server`
Expected: no matches outside `Database.js` (routes use the singleton instance).

- [ ] **Step 3: Smoke-test the embedded path still boots**

Run: `LBUG_IN_MEMORY=true node -e "const db=require('./src/server/utils/Database'); db.getSchema().then(s=>{console.log('schema ok', s.nodeTables.length); process.exit(0)}).catch(e=>{console.error(e);process.exit(1)})"`
Expected: prints `schema ok 0` (empty in-memory DB) and exits 0.

- [ ] **Step 4: Commit**

```bash
git add src/server/utils/Database.js
git commit -m "refactor(server): Database façade with switchable embedded/proxy backend"
```

---

### Task B5: SSHTunnel (ssh -L local port-forward)

**Files:**
- Create: `src/server/utils/SSHTunnel.js`

Modeled on the existing `SSHManager` invocation style. No unit test (it spawns
real `ssh`); verified during the manual E2E in Task B8.

- [ ] **Step 1: Read the existing SSHManager to match its ssh/sshpass style**

Run: `sed -n '1,80p' src/server/utils/SSHManager.js`
Expected: note how it builds `ssh`/`sshpass` argv, key vs. password handling, and
process spawning. Reuse the same conventions below.

- [ ] **Step 2: Implement SSHTunnel**

Create `src/server/utils/SSHTunnel.js`:

```js
const { spawn } = require("child_process");
const net = require("net");
const logger = require("./Logger");

// Manages a single `ssh -N -L <localPort>:127.0.0.1:<remotePort>` forward to the
// host running the Explorer bridge. Keeps the bridge port unexposed off-host.
class SSHTunnel {
  constructor() { this._proc = null; this._localPort = null; }

  isActive() { return this._proc !== null; }
  get localPort() { return this._localPort; }

  _findFreePort() {
    return new Promise((resolve, reject) => {
      const srv = net.createServer();
      srv.listen(0, "127.0.0.1", () => {
        const port = srv.address().port;
        srv.close(() => resolve(port));
      });
      srv.on("error", reject);
    });
  }

  // opts: { host, port=22, user, password?, privateKeyPath?, remotePort }
  async open(opts) {
    if (this._proc) this.close();
    const localPort = await this._findFreePort();
    const sshArgs = [
      "-N",
      "-o", "ExitOnForwardFailure=yes",
      "-o", "StrictHostKeyChecking=accept-new",
      "-L", `${localPort}:127.0.0.1:${opts.remotePort}`,
      "-p", String(opts.port || 22),
    ];
    if (opts.privateKeyPath) sshArgs.push("-i", opts.privateKeyPath);
    sshArgs.push(`${opts.user}@${opts.host}`);

    let cmd = "ssh";
    let args = sshArgs;
    if (opts.password) {
      // Password auth via sshpass, mirroring SSHManager.
      cmd = "sshpass";
      args = ["-p", opts.password, "ssh", ...sshArgs];
    }
    const proc = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
    proc.stderr.on("data", (d) => logger.warn(`ssh tunnel: ${d.toString().trim()}`));
    proc.on("exit", (code) => { if (this._proc === proc) { this._proc = null; logger.warn(`ssh tunnel exited (${code})`); } });
    this._proc = proc;
    this._localPort = localPort;

    // Wait until the local port accepts connections (max ~5s).
    await this._waitForPort(localPort, 5000);
    return localPort;
  }

  _waitForPort(port, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve, reject) => {
      const tryConnect = () => {
        const sock = net.connect(port, "127.0.0.1");
        sock.on("connect", () => { sock.destroy(); resolve(); });
        sock.on("error", () => {
          sock.destroy();
          if (Date.now() > deadline) reject(new Error("SSH tunnel did not become ready"));
          else setTimeout(tryConnect, 150);
        });
      };
      tryConnect();
    });
  }

  close() {
    if (this._proc) { this._proc.kill("SIGTERM"); this._proc = null; }
    this._localPort = null;
  }
}

module.exports = new SSHTunnel();
```

- [ ] **Step 3: Lint the new file**

Run: `npx eslint src/server/utils/SSHTunnel.js`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/server/utils/SSHTunnel.js
git commit -m "feat(server): SSHTunnel ssh -L local port-forward to bridge host"
```

---

### Task B6: DBConfig proxy branch + backend reporting

**Files:**
- Modify: `src/server/DBConfig.js`

- [ ] **Step 1: Build the proxy backend on `mode === "proxy"`**

In `src/server/DBConfig.js`, add requires near the top:

```js
const axios = require("axios");
const sshTunnel = require("./utils/SSHTunnel");
const { ProxyBackend } = require("./utils/ProxyBackend");
```

In `buildResponse()`, report proxy state when active:

```js
function buildResponse() {
  if (database.isProxy) {
    const cfg = database.getCurrentConfig();   // { mode:'proxy', host, bridgePort, user }
    return { ...cfg, backend: "proxy" };
  }
  const dbConfig = database.getCurrentConfig();
  const sshConfig = sshManager.getConfig();
  const mode = sshConfig ? "ssh" : (dbConfig.isInMemory ? "memory" : "file");
  return { ...dbConfig, mode, ssh: sshConfig, backend: "embedded" };
}
```

In the `POST /` handler, add a proxy branch before the existing
file/memory/ssh handling:

```js
  if (mode === "proxy") {
    const { host, port = 22, user, password, privateKeyPath, bridgePort } = req.body.proxy || {};
    if (!host || !user || !bridgePort) {
      return res.status(400).send({ error: "host, user and bridgePort are required for proxy mode." });
    }
    try {
      const localPort = await sshTunnel.open({ host, port, user, password, privateKeyPath, remotePort: bridgePort });
      const baseURL = `http://127.0.0.1:${localPort}`;
      const http = {
        post: (path, body) => axios.post(`${baseURL}${path}`, body),
        get: (path) => axios.get(`${baseURL}${path}`),
      };
      // Probe liveness before committing the switch.
      await http.get("/ping");
      const backend = new ProxyBackend({ host, bridgePort, localPort, user }, http);
      await backend.getSchema();   // surfaces an unreachable/incompatible bridge
      // Tear down any embedded SSH mount, then activate the proxy backend.
      sshManager.unmountAll();
      database.useProxy(backend);
      return res.send(buildResponse());
    } catch (err) {
      sshTunnel.close();
      return res.status(400).send({ error: friendlyError(err.message || String(err)) });
    }
  }
```

In the existing non-proxy path, ensure switching *away* from proxy is handled:
at the start of the `else` (file/memory/ssh) handling, add:

```js
    if (database.isProxy) { sshTunnel.close(); database.useEmbedded(); }
```

- [ ] **Step 2: Lint**

Run: `npx eslint src/server/DBConfig.js`
Expected: no errors.

- [ ] **Step 3: Smoke-test that a missing proxy field is rejected**

Run: `node -e "const r=require('./src/server/DBConfig'); console.log(typeof r)"`
Expected: prints `function` (the express router loads without throwing).

- [ ] **Step 4: Commit**

```bash
git add src/server/DBConfig.js
git commit -m "feat(server): DBConfig proxy mode branch (ssh tunnel + ProxyBackend)"
```

---

### Task B7: Report backend to the frontend (Mode/State + store)

**Files:**
- Modify: `src/server/Mode.js`
- Modify: `src/store/ModeStore.js`

- [ ] **Step 1: Include backend in the /api/mode response**

In `src/server/Mode.js`, add `backend` to the non-wasm response:

```js
    res.send({
      mode,
      isProduction,
      backend: database.isProxy ? "proxy" : "embedded",
    });
```

- [ ] **Step 2: Track backend in ModeStore**

In `src/store/ModeStore.js`:
- add to `state`: `backend: "embedded",`
- add a getter:

```js
    isProxy(state) {
      return state.backend === "proxy";
    },
```
- add an action:

```js
    setBackend(backend) {
      this.backend = backend;
    },
```

- [ ] **Step 3: Set backend where mode is fetched**

In `src/components/MainLayout.vue`, where it currently does
`this.modeStore.setMode(mode)` (around line 410), add right after:

```js
      this.modeStore.setBackend(response.data.backend || "embedded");
```

- [ ] **Step 4: Lint**

Run: `npx eslint src/server/Mode.js src/store/ModeStore.js src/components/MainLayout.vue`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/server/Mode.js src/store/ModeStore.js src/components/MainLayout.vue
git commit -m "feat: surface backend (embedded/proxy) to the frontend store"
```

---

### Task B8: Frontend — Proxy option, gating Import/Reset, manual E2E

**Files:**
- Modify: `src/components/DBView/DBConfigModal.vue`
- Modify: `src/components/MainLayout.vue`
- Modify: `src/components/SettingsView/SettingsMainView.vue`

- [ ] **Step 1: Add the Proxy radio + fields to the DB modal**

In `src/components/DBView/DBConfigModal.vue`, add a 4th radio after the SSH one
(inside `.db-options`):

```html
            <label class="db-option-card">
              <input
                v-model="mode"
                type="radio"
                value="proxy"
              >
              <span><i class="fa-solid fa-network-wired" />&nbsp; Proxy (remote ladybug process)</span>
            </label>
```

Add a fields block after the SSH block (mirrors SSH connection/auth, plus bridge
port). Add to `data()`: `proxy: defaultProxy(),` and define:

```js
const defaultProxy = () => ({
  host: "", port: 22, user: "",
  authType: "password", password: "", privateKeyPath: "",
  bridgePort: 7999,
});
```

```html
          <div
            v-else-if="mode === 'proxy'"
            class="db-fields"
          >
            <div class="db-ssh-section-label">Connection (SSH tunnel)</div>
            <div class="db-field-row"><label>Host</label>
              <input v-model="proxy.host" type="text" class="form-control db-input" placeholder="192.168.1.100"></div>
            <div class="db-field-row"><label>SSH Port</label>
              <input v-model.number="proxy.port" type="number" class="form-control db-input db-input--short" placeholder="22"></div>
            <div class="db-field-row"><label>User</label>
              <input v-model="proxy.user" type="text" class="form-control db-input" placeholder="username"></div>

            <div class="db-ssh-section-label db-ssh-section-label--mt">Authentication</div>
            <div class="db-field-row"><label>Auth type</label>
              <div class="db-auth-options">
                <label class="db-auth-option"><input v-model="proxy.authType" type="radio" value="password"> Password</label>
                <label class="db-auth-option"><input v-model="proxy.authType" type="radio" value="key"> Private key file</label>
              </div>
            </div>
            <div v-if="proxy.authType === 'password'" class="db-field-row"><label>Password</label>
              <input v-model="proxy.password" type="password" class="form-control db-input" autocomplete="current-password"></div>
            <div v-else class="db-field-row"><label>Key file</label>
              <input v-model="proxy.privateKeyPath" type="text" class="form-control db-input" placeholder="/home/user/.ssh/id_rsa"></div>

            <div class="db-ssh-section-label db-ssh-section-label--mt">Bridge</div>
            <div class="db-field-row"><label>Bridge port</label>
              <input v-model.number="proxy.bridgePort" type="number" class="form-control db-input db-input--short" placeholder="7999"></div>
            <div class="db-info-text db-info-text--mt">
              <i class="fa-solid fa-circle-info" />&nbsp;
              Connects to a process that owns the DB read-write and runs the Explorer bridge. Import and Reset are unavailable in this mode.
            </div>
          </div>
```

In `buildPayload()`, add a proxy branch at the top:

```js
      if (this.mode === "proxy") {
        const p = this.proxy;
        const proxyPayload = { host: p.host, port: p.port || 22, user: p.user, bridgePort: p.bridgePort || 7999 };
        if (p.authType === "password") proxyPayload.password = p.password;
        else proxyPayload.privateKeyPath = p.privateKeyPath;
        return { mode: "proxy", proxy: proxyPayload };
      }
```

In `showModal()`, pre-populate when current mode is proxy:

```js
        if (res.data.mode === "proxy") {
          this.proxy = { ...defaultProxy(), host: res.data.host || "", bridgePort: res.data.bridgePort || 7999, user: res.data.user || "" };
        }
```

And extend `currentSummary()`:

```js
      if (mode === "proxy") return `proxy ${this.currentConfig.user}@${this.currentConfig.host} (bridge :${this.currentConfig.bridgePort})`;
```

- [ ] **Step 2: Gate the Import nav item in proxy mode**

In `src/components/MainLayout.vue`, change the Import nav `v-if` (line ~107) from
`v-if="!modeStore.isReadOnly"` to:

```html
            v-if="!modeStore.isReadOnly && !modeStore.isProxy"
```

- [ ] **Step 3: Disable the Reset action in proxy mode**

In `src/components/SettingsView/SettingsMainView.vue`, find the database-reset
control (around the `databaseResetState*` data, line ~441) and the button/handler
that POSTs `/api/reset`. Guard the handler and disable the button:

- In the reset method, add a guard at the top:

```js
      if (this.modeStore.isProxy) {
        this.databaseResetStateText = "Reset is unavailable in proxy mode.";
        this.databaseResetStateClass = "danger";
        return;
      }
```

- Add `:disabled="modeStore.isProxy"` to the reset button element, and ensure the
  component imports/uses the mode store (it already reads other stores; if not,
  add `import { useModeStore } from "@/store/ModeStore";` and `modeStore: useModeStore()` in `setup`/`data` following the file's existing store pattern).

- [ ] **Step 4: Lint the frontend changes**

Run: `npm run eslint`
Expected: no errors (fix any reported).

- [ ] **Step 5: Manual end-to-end verification**

1. Build/start `ecoai-context-provider` with the bridge enabled against a real
   `kg.db` directory held **read-write** by that process.
2. Start the explorer: `npm run serve` (dev) — open the UI.
3. Open the DB menu → choose **Proxy**, fill host/user/auth + bridge port → Apply.
4. Confirm: the Schema view loads tables; a `MATCH (n) RETURN n LIMIT 25` renders
   the graph; clicking a node expands neighbors; a write query
   (`CREATE (:Foo {x:1})` if `Foo` exists, or a DDL) succeeds; the Import and
   Reset affordances are hidden/disabled.
5. Switch back to File/In-memory and confirm the embedded path still works and the
   tunnel is torn down.

Expected: all of the above behave as described; the owning process keeps the lock
throughout (no `Could not set lock on file`).

- [ ] **Step 6: Commit**

```bash
git add src/components/DBView/DBConfigModal.vue src/components/MainLayout.vue src/components/SettingsView/SettingsMainView.vue
git commit -m "feat(ui): proxy DB mode option; hide Import/Reset in proxy mode"
```

---

## Self-Review Notes (coverage map)

- Bridge transport (HTTP/cpp-httplib, find_package→FetchContent): Task A1, A6.
- Value serialization parity with node_util.cpp: Tasks A2–A4 (scalars, INT128/nested/node/rel, dates + result wrapper).
- Second connection on same Database: Task A5.
- /cypher, /version, /ping endpoints + error 400: Task A6.
- Default-off config wiring, no behavior change when disabled: Task A7.
- SSH tunnel (passphrase or key): Task B5; DBConfig wiring B6.
- Façade keeps routes unchanged; embedded default: Task B4; schema reuse B1; ProxyConnection/Backend B2–B3.
- Mutually-exclusive Proxy option in DB menu: Task B8.
- Import + Reset disabled in proxy mode: Tasks B7 (flag) + B8 (gating).
- Out of scope (import wizard, reset, local switching unchanged): respected throughout.

## Risks / implementer follow-ups

- **Ladybug C++ API drift:** the exact symbols for prepared-statement param
  binding, multi-statement result chaining, and the storage-version constant must
  be confirmed against the installed `lbug.hpp`/headers (notes inline in A6). The
  node binding `node_util.cpp`/`node_connection.cpp` is the authoritative
  reference for equivalents.
- **Param typing:** B2/A6 pass params as a JSON object; the bridge maps scalars to
  `lbug::common::Value`. Rich/typed params (the import path) are out of scope.
- **Date formatting parity:** `Value::toString()` for dates must be ISO-8601 to
  match the embedded JSON-stringified `Date`. Verify with the A4 date test and the
  manual E2E; if Ladybug renders a different format, adjust `valueToJson` date
  cases to reformat.
