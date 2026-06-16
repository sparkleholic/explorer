const test = require("node:test");
const assert = require("node:assert");
const { EventEmitter } = require("events");
const { SSHTunnel } = require("../SSHTunnel");

// Fake ssh2 Client that authenticates successfully.
class FakeReadyClient extends EventEmitter {
  connect() { setImmediate(() => this.emit("ready")); }
  forwardOut(srcIp, srcPort, dstIp, dstPort, cb) { cb(null, new EventEmitter()); }
  end() {}
}

// Fake ssh2 Client that fails authentication (structured ssh2-style error).
class FakeAuthFailClient extends EventEmitter {
  connect() {
    setImmediate(() => this.emit("error", new Error("All configured authentication methods failed")));
  }
  end() {}
}

test("open() resolves a local port once ssh is ready", async () => {
  const t = new SSHTunnel({ Client: FakeReadyClient });
  const localPort = await t.open({ host: "h", port: 22, user: "u", password: "p", remotePort: 7999 });
  assert.equal(typeof localPort, "number");
  assert.ok(localPort > 0);
  assert.equal(t.isActive(), true);
  t.close();
  assert.equal(t.isActive(), false);
});

test("open() rejects with the ssh2 error message on auth failure (not a generic timeout)", async () => {
  const t = new SSHTunnel({ Client: FakeAuthFailClient });
  await assert.rejects(
    () => t.open({ host: "h", user: "u", password: "p", remotePort: 7999 }),
    /authentication methods failed/
  );
  assert.equal(t.isActive(), false);
});

test("open() rejects when no password or key is provided", async () => {
  const t = new SSHTunnel({ Client: FakeReadyClient });
  await assert.rejects(
    () => t.open({ host: "h", user: "u", remotePort: 7999 }),
    /password or a private key/
  );
});
