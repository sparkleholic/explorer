const express = require("express");
const fs = require("fs");
const router = express.Router();
const database = require("./utils/Database");
const sshManager = require("./utils/SSHManager");
const logger = require("./utils/Logger");

function friendlyQueryError(msg) {
  const m = msg && msg.match(/Database file version: (\d+), Current build storage version: (\d+)/);
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
  return `Database opened but is not queryable: ${msg}`;
}

function buildResponse() {
  const dbConfig = database.getCurrentConfig();
  const sshConfig = sshManager.getConfig();
  const mode = sshConfig ? "ssh" : (dbConfig.isInMemory ? "memory" : "file");
  return { ...dbConfig, mode, ssh: sshConfig };
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
  const { mode, dbDir, dbFile, ssh } = req.body;

  // Validate directory existence before touching the current DB.
  if (mode === "file") {
    if (!dbDir) {
      return res.status(400).send({ error: "Directory path is required." });
    }
    if (!fs.existsSync(dbDir) || !fs.statSync(dbDir).isDirectory()) {
      return res.status(400).send({ error: `Directory does not exist: ${dbDir}` });
    }
  }

  const prevConfig = database.getCurrentConfig();
  const prevSSHActive = sshManager.isActive();

  try {
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
    return res.status(400).send({ error: err.message });
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
    return res.status(400).send({ error: friendlyQueryError(err.message) });
  }

  res.send(buildResponse());
});

module.exports = router;
