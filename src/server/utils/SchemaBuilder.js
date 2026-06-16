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
