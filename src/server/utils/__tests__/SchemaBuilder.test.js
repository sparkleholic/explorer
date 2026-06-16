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
