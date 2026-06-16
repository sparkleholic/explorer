const express = require("express");
const fs = require("fs");
const router = express.Router();
const database = require("./utils/Database");
const sshManager = require("./utils/SSHManager");
const logger = require("./utils/Logger");
const axios = require("axios");
const sshTunnel = require("./utils/SSHTunnel");
const { ProxyBackend } = require("./utils/ProxyBackend");

function friendlyError(msg) {
  // Native addon wraps messages as "[Error: ...]" — strip the wrapper.
  const clean = (msg || "").replace(/^\[Error:\s*/, "").replace(/\]$/, "").trim();
  const m = clean.match(/Database file version: (\d+), Current build storage version: (\d+)/);
  if (m) {
    const [, fileVer, buildVer] = m;
    const direction = Number(fileVer) > Number(buildVer) ? "newer" : "older";
    return (
      `Storage version mismatch: the database was created with Ladybug storage v${fileVer}, ` +
      `but this build uses v${buildVer}. ` +
      `The database is ${direction} than this version of Ladybug Explorer and cannot be opened. ` +
      `Use a matching version of Ladybug Explorer to access this database.`
    );
  }
  return clean || msg;
}

function buildResponse() {
  if (database.isProxy) {
    const cfg = database.getCurrentConfig();   // { mode:'proxy', host, bridgePort, user, ... }
    return { ...cfg, backend: "proxy" };
  }
  const dbConfig = database.getCurrentConfig();
  const sshConfig = sshManager.getConfig();
  const mode = sshConfig ? "ssh" : (dbConfig.isInMemory ? "memory" : "file");
  return { ...dbConfig, mode, ssh: sshConfig, backend: "embedded" };
}

async function rollback(prevConfig) {
  try {
    await database.reconfigure({
      dbDir: prevConfig.dbDir,
      dbFile: prevConfig.dbFile,
      inMemory: prevConfig.isInMemory,
    });
  } catch (err) {
    logger.error(`DB rollback failed: ${err.message}`);
  }
}

router.get("/", (_, res) => {
  try {
    res.send(buildResponse());
  } catch (err) {
    res.status(500).send({ error: err.message });
  }
});

router.post("/", async (req, res) => {
  const { mode, dbDir, dbFile, ssh, proxy } = req.body;

  // Validate directory existence before touching the current DB.
  if (mode === "file") {
    if (!dbDir) {
      return res.status(400).send({ error: "Directory path is required." });
    }
    if (!fs.existsSync(dbDir) || !fs.statSync(dbDir).isDirectory()) {
      return res.status(400).send({ error: `Directory does not exist: ${dbDir}` });
    }
  }

  // Proxy mode: connect to a remote process that owns the DB read-write and runs
  // the Explorer bridge, reached through an SSH local port-forward. Mutually
  // exclusive with the local file/memory/ssh options.
  if (mode === "proxy") {
    const { host, port = 22, user, password, privateKeyPath, bridgePort } = proxy || {};
    if (!host || !user || !bridgePort) {
      return res.status(400).send({ error: "host, user and bridgePort are required for proxy mode." });
    }
    try {
      const localPort = await sshTunnel.open({ host, port, user, password, privateKeyPath, remotePort: bridgePort });
      const baseURL = `http://127.0.0.1:${localPort}`;
      const http = {
        post: (p, body) => axios.post(`${baseURL}${p}`, body, { timeout: 30000 }),
        get: (p) => axios.get(`${baseURL}${p}`, { timeout: 30000 }),
      };
      // Probe liveness before committing the switch.
      await http.get("/ping");
      const backend = new ProxyBackend({ host, bridgePort, localPort, user }, http);
      await backend.getSchema();   // surfaces an unreachable/incompatible bridge
      // Leaving the local SSH mount (if any) and activate the proxy backend.
      sshManager.unmountAll();
      database.useProxy(backend);
      return res.send(buildResponse());
    } catch (err) {
      sshTunnel.close();
      return res.status(400).send({ error: friendlyError((err && err.message) || String(err)) });
    }
  }

  const prevConfig = database.getCurrentConfig();
  const prevSSHActive = sshManager.isActive();

  try {
    if (database.isProxy) { sshTunnel.close(); database.useEmbedded(); }
    if (mode === "ssh") {
      const { host, port = 22, user, password, privateKeyPath, remoteDir, remoteFile } = ssh;
      const mountPoint = sshManager.mount({ host, port, user, password, privateKeyPath, remoteDir });
      await database.reconfigure({ dbDir: mountPoint, dbFile: remoteFile || "database.kz", inMemory: false });
    } else {
      sshManager.unmountAll();
      await database.reconfigure({ dbDir, dbFile, inMemory: mode === "memory" });
    }
  } catch (err) {
    // reconfigure itself failed — SSH mount or DB open error.
    if (mode === "ssh" && sshManager.isActive()) sshManager.unmountAll();
    return res.status(400).send({ error: friendlyError(err.message) });
  }

  // Probe the new DB with a schema query to catch silent open failures
  // (e.g. incompatible DB format). Roll back and return 400 if it fails.
  try {
    await database.getSchema();
  } catch (err) {
    if (mode === "ssh") sshManager.unmountAll();
    await rollback(prevConfig);
    if (prevSSHActive) {
      logger.warn("Previous SSH mount could not be restored after failed DB switch.");
    }
    return res.status(400).send({ error: friendlyError(err.message) });
  }

  res.send(buildResponse());
});

module.exports = router;
