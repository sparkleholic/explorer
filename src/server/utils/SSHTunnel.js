const { spawn, execSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");
const logger = require("./Logger");

// Manages a single `ssh -N -L <localPort>:127.0.0.1:<remotePort>` forward to the
// host running the Explorer bridge. Keeps the bridge port unexposed off-host:
// the backend talks HTTP to 127.0.0.1:<localPort> and ssh forwards it to the
// remote loopback bridge port.
class SSHTunnel {
  constructor() {
    this._proc = null;
    this._localPort = null;
    this._passFile = null;

    const cleanup = () => { this.close(); };
    process.on("exit", () => this.close());
    process.on("SIGINT", () => { cleanup(); process.exit(); });
    process.on("SIGTERM", () => { cleanup(); process.exit(); });
  }

  isActive() { return this._proc !== null; }
  get localPort() { return this._localPort; }

  _hasCmd(cmd) {
    try { execSync(`which ${cmd}`, { stdio: "pipe" }); return true; }
    catch { return false; }
  }

  _findFreePort() {
    return new Promise((resolve, reject) => {
      const srv = net.createServer();
      srv.unref();
      srv.on("error", reject);
      srv.listen(0, "127.0.0.1", () => {
        const port = srv.address().port;
        srv.close(() => resolve(port));
      });
    });
  }

  _waitForPort(port, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve, reject) => {
      const tryConnect = () => {
        const sock = net.connect(port, "127.0.0.1");
        sock.on("connect", () => { sock.destroy(); resolve(); });
        sock.on("error", () => {
          sock.destroy();
          if (Date.now() > deadline) reject(new Error("SSH tunnel did not become ready in time"));
          else setTimeout(tryConnect, 150);
        });
      };
      tryConnect();
    });
  }

  // opts: { host, port=22, user, password?, privateKeyPath?, remotePort }
  async open(opts) {
    const { host, port = 22, user, password, privateKeyPath, remotePort } = opts;
    if (!host || !user || !remotePort) {
      throw new Error("host, user and remotePort are required to open an SSH tunnel.");
    }
    if (!this._hasCmd("ssh")) {
      throw new Error("ssh is not installed. Please install OpenSSH client to use proxy mode.");
    }
    if (this._proc) this.close();

    const localPort = await this._findFreePort();

    const sshArgs = [
      "-N",
      "-o", "ExitOnForwardFailure=yes",
      "-o", "StrictHostKeyChecking=no",
      "-o", "UserKnownHostsFile=/dev/null",
      "-o", "ServerAliveInterval=15",
      "-p", String(port),
      "-L", `${localPort}:127.0.0.1:${remotePort}`,
    ];
    if (privateKeyPath) sshArgs.push("-i", privateKeyPath);
    sshArgs.push(`${user}@${host}`);

    let cmd = "ssh";
    let args = sshArgs;
    if (password) {
      if (!this._hasCmd("sshpass")) {
        throw new Error("sshpass is not installed. Install sshpass for password auth, or use a private key file.");
      }
      this._passFile = path.join(os.tmpdir(), `lbug-tunnel-pass-${Date.now()}`);
      fs.writeFileSync(this._passFile, password, { mode: 0o600 });
      cmd = "sshpass";
      args = ["-f", this._passFile, "ssh", ...sshArgs];
    }

    const proc = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
    proc.stderr.on("data", (d) => logger.warn(`ssh tunnel: ${d.toString().trim()}`));
    proc.on("exit", (code) => {
      if (this._proc === proc) {
        this._proc = null;
        this._localPort = null;
        logger.warn(`ssh tunnel exited (code ${code})`);
      }
    });
    this._proc = proc;
    this._localPort = localPort;

    try {
      await this._waitForPort(localPort, 8000);
    } catch (err) {
      this.close();
      throw err;
    }

    // The password file is no longer needed once ssh has authenticated/forwarded.
    if (this._passFile) {
      try { fs.unlinkSync(this._passFile); } catch { /* ignore */ }
      this._passFile = null;
    }

    logger.info(`SSH tunnel up: 127.0.0.1:${localPort} -> ${user}@${host}:[127.0.0.1:${remotePort}]`);
    return localPort;
  }

  close() {
    if (this._proc) {
      try { this._proc.kill("SIGTERM"); } catch { /* ignore */ }
      this._proc = null;
    }
    this._localPort = null;
    if (this._passFile) {
      try { fs.unlinkSync(this._passFile); } catch { /* ignore */ }
      this._passFile = null;
    }
  }
}

module.exports = new SSHTunnel();
