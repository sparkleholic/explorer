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
