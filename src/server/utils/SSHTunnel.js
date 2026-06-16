const fs = require("fs");
const net = require("net");
const { Client } = require("ssh2");
const logger = require("./Logger");

// Opens an in-process SSH local port-forward to the host running the Explorer
// bridge, using the pure-Node `ssh2` library (no system ssh/sshpass). The backend
// then speaks HTTP to 127.0.0.1:<localPort>, and ssh2 forwards each connection to
// the remote loopback bridge port — keeping the bridge port unexposed off-host.
//
// The ssh2 Client constructor is injectable (`opts.Client`) so the behaviour can
// be unit-tested without a real SSH server.
class SSHTunnel {
  constructor(opts = {}) {
    this._ClientCtor = opts.Client || Client;
    this._client = null;
    this._server = null;
    this._localPort = null;
  }

  isActive() { return this._client !== null; }
  get localPort() { return this._localPort; }

  // opts: { host, port=22, user, password?, privateKeyPath?, remotePort }
  open(opts) {
    const { host, port = 22, user, password, privateKeyPath, remotePort } = opts || {};
    if (!host || !user || !remotePort) {
      return Promise.reject(new Error("host, user and remotePort are required to open an SSH tunnel."));
    }

    const connectCfg = { host, port: Number(port) || 22, username: user, readyTimeout: 15000 };
    if (privateKeyPath) {
      try {
        connectCfg.privateKey = fs.readFileSync(privateKeyPath);
      } catch (err) {
        return Promise.reject(new Error(`Cannot read private key file '${privateKeyPath}': ${err.message}`));
      }
    } else if (password) {
      connectCfg.password = password;
    } else {
      return Promise.reject(new Error("Either a password or a private key file is required for SSH."));
    }

    if (this._client) this.close();

    return new Promise((resolve, reject) => {
      const client = new this._ClientCtor();
      let settled = false;

      const fail = (err) => {
        if (settled) return;
        settled = true;
        this.close();
        try { client.end(); } catch { /* ignore */ }
        reject(err instanceof Error ? err : new Error(String(err)));
      };

      client.on("error", (err) => {
        fail(new Error(`SSH connection failed: ${err.message}`));
      });

      client.on("ready", () => {
        const server = net.createServer((socket) => {
          client.forwardOut("127.0.0.1", socket.remotePort || 0, "127.0.0.1", remotePort, (err, stream) => {
            if (err) {
              logger.warn(`SSH forward failed: ${err.message}`);
              socket.destroy();
              return;
            }
            socket.pipe(stream).pipe(socket);
            socket.on("error", () => stream.destroy());
            stream.on("error", () => socket.destroy());
          });
        });
        server.on("error", (err) => fail(new Error(`Local forward listener failed: ${err.message}`)));
        server.listen(0, "127.0.0.1", () => {
          if (settled) { server.close(); return; }
          settled = true;
          this._client = client;
          this._server = server;
          this._localPort = server.address().port;
          logger.info(`SSH tunnel up: 127.0.0.1:${this._localPort} -> ${user}@${host}:[127.0.0.1:${remotePort}]`);
          resolve(this._localPort);
        });
      });

      try {
        client.connect(connectCfg);
      } catch (err) {
        fail(new Error(`SSH connection failed: ${err.message}`));
      }
    });
  }

  close() {
    if (this._server) { try { this._server.close(); } catch { /* ignore */ } this._server = null; }
    if (this._client) { try { this._client.end(); } catch { /* ignore */ } this._client = null; }
    this._localPort = null;
  }
}

const singleton = new SSHTunnel();
singleton.SSHTunnel = SSHTunnel;
process.on("exit", () => singleton.close());
process.on("SIGINT", () => { singleton.close(); process.exit(); });
process.on("SIGTERM", () => { singleton.close(); process.exit(); });

module.exports = singleton;
