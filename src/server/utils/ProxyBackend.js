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
      connection: this._meta.connection || "ssh",
      host: this._meta.host,
      bridgePort: this._meta.bridgePort,
      user: this._meta.user,
    };
  }

  async reset() { throw new Error("Reset is not supported in proxy mode."); }
  async reconfigure() { throw new Error("Reconfigure is not supported in proxy mode."); }
}

module.exports = { ProxyBackend };
