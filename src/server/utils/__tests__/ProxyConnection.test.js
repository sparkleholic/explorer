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
