<template>
  <div
    ref="modal"
    class="modal"
    tabindex="-1"
  >
    <div class="modal-dialog modal-lg">
      <div class="modal-content bg-transparent border-0">
        <div class="db-modal-body">
          <h2>Database</h2>
          <hr>

          <!-- Current connection summary -->
          <div
            v-if="currentConfig"
            class="db-current"
          >
            <span class="db-label">Current</span>
            <code class="db-path">{{ currentSummary }}</code>
          </div>

          <!-- Mode selection -->
          <div class="db-options">
            <label class="db-option-card">
              <input
                v-model="mode"
                type="radio"
                value="file"
              >
              <span><i class="fa-solid fa-hard-drive" />&nbsp; File-based</span>
            </label>
            <label class="db-option-card">
              <input
                v-model="mode"
                type="radio"
                value="memory"
              >
              <span><i class="fa-solid fa-memory" />&nbsp; In-memory</span>
            </label>
            <label class="db-option-card">
              <input
                v-model="mode"
                type="radio"
                value="ssh"
              >
              <span><i class="fa-solid fa-server" />&nbsp; Remote (SSH)</span>
            </label>
            <label class="db-option-card">
              <input
                v-model="mode"
                type="radio"
                value="proxy"
              >
              <span><i class="fa-solid fa-network-wired" />&nbsp; Proxy (remote ladybug process)</span>
            </label>
          </div>

          <!-- File-based fields -->
          <div
            v-if="mode === 'file'"
            class="db-fields"
          >
            <div class="db-field-row">
              <label>Directory</label>
              <input
                v-model="dbDir"
                type="text"
                class="form-control db-input"
                placeholder="/path/to/database/directory"
              >
            </div>
            <div class="db-field-row">
              <label>File name</label>
              <input
                v-model="dbFile"
                type="text"
                class="form-control db-input"
                placeholder="database.kz"
              >
            </div>
          </div>

          <!-- In-memory info -->
          <div
            v-else-if="mode === 'memory'"
            class="db-info-text"
          >
            <i class="fa-solid fa-circle-info" />&nbsp;
            Data will not be persisted. All changes are lost when the server restarts.
          </div>

          <!-- SSH fields -->
          <div
            v-else-if="mode === 'ssh'"
            class="db-fields"
          >
            <div class="db-ssh-section-label">
              Connection
            </div>
            <div class="db-field-row">
              <label>Host</label>
              <input
                v-model="ssh.host"
                type="text"
                class="form-control db-input"
                placeholder="192.168.1.100 or hostname"
              >
            </div>
            <div class="db-field-row">
              <label>Port</label>
              <input
                v-model.number="ssh.port"
                type="number"
                class="form-control db-input db-input--short"
                placeholder="22"
                min="1"
                max="65535"
              >
            </div>
            <div class="db-field-row">
              <label>User</label>
              <input
                v-model="ssh.user"
                type="text"
                class="form-control db-input"
                placeholder="username"
              >
            </div>

            <div class="db-ssh-section-label db-ssh-section-label--mt">
              Authentication
            </div>
            <div class="db-field-row">
              <label>Auth type</label>
              <div class="db-auth-options">
                <label class="db-auth-option">
                  <input
                    v-model="ssh.authType"
                    type="radio"
                    value="password"
                  >
                  Password
                </label>
                <label class="db-auth-option">
                  <input
                    v-model="ssh.authType"
                    type="radio"
                    value="key"
                  >
                  Private key file
                </label>
              </div>
            </div>
            <div
              v-if="ssh.authType === 'password'"
              class="db-field-row"
            >
              <label>Password</label>
              <input
                v-model="ssh.password"
                type="password"
                class="form-control db-input"
                placeholder="SSH password"
                autocomplete="current-password"
              >
            </div>
            <div
              v-else
              class="db-field-row"
            >
              <label>Key file</label>
              <input
                v-model="ssh.privateKeyPath"
                type="text"
                class="form-control db-input"
                placeholder="/home/user/.ssh/id_rsa"
              >
            </div>

            <div class="db-ssh-section-label db-ssh-section-label--mt">
              Remote database
            </div>
            <div class="db-field-row">
              <label>Directory</label>
              <input
                v-model="ssh.remoteDir"
                type="text"
                class="form-control db-input"
                placeholder="/path/to/database/directory"
              >
            </div>
            <div class="db-field-row">
              <label>File name</label>
              <input
                v-model="ssh.remoteFile"
                type="text"
                class="form-control db-input"
                placeholder="database.kz"
              >
            </div>
            <div class="db-info-text db-info-text--mt">
              <i class="fa-solid fa-circle-info" />&nbsp;
              Requires <code>sshfs</code> on the server.
              Password auth additionally requires <code>sshpass</code>.
            </div>
          </div>

          <!-- Proxy fields -->
          <div
            v-else-if="mode === 'proxy'"
            class="db-fields"
          >
            <div class="db-ssh-section-label">
              Connection
            </div>
            <div class="db-field-row">
              <label>Type</label>
              <div class="db-auth-options">
                <label class="db-auth-option">
                  <input
                    v-model="proxy.connection"
                    type="radio"
                    value="direct"
                  >
                  Direct (no SSH)
                </label>
                <label class="db-auth-option">
                  <input
                    v-model="proxy.connection"
                    type="radio"
                    value="ssh"
                  >
                  SSH tunnel
                </label>
              </div>
            </div>
            <div class="db-field-row">
              <label>Host</label>
              <input
                v-model="proxy.host"
                type="text"
                class="form-control db-input"
                placeholder="127.0.0.1 or hostname"
              >
            </div>

            <template v-if="proxy.connection === 'ssh'">
              <div class="db-field-row">
                <label>SSH Port</label>
                <input
                  v-model.number="proxy.port"
                  type="number"
                  class="form-control db-input db-input--short"
                  placeholder="22"
                  min="1"
                  max="65535"
                >
              </div>
              <div class="db-field-row">
                <label>User</label>
                <input
                  v-model="proxy.user"
                  type="text"
                  class="form-control db-input"
                  placeholder="username"
                >
              </div>

              <div class="db-ssh-section-label db-ssh-section-label--mt">
                Authentication
              </div>
              <div class="db-field-row">
                <label>Auth type</label>
                <div class="db-auth-options">
                  <label class="db-auth-option">
                    <input
                      v-model="proxy.authType"
                      type="radio"
                      value="password"
                    >
                    Password
                  </label>
                  <label class="db-auth-option">
                    <input
                      v-model="proxy.authType"
                      type="radio"
                      value="key"
                    >
                    Private key file
                  </label>
                </div>
              </div>
              <div
                v-if="proxy.authType === 'password'"
                class="db-field-row"
              >
                <label>Password</label>
                <input
                  v-model="proxy.password"
                  type="password"
                  class="form-control db-input"
                  placeholder="SSH password"
                  autocomplete="current-password"
                >
              </div>
              <div
                v-else
                class="db-field-row"
              >
                <label>Key file</label>
                <input
                  v-model="proxy.privateKeyPath"
                  type="text"
                  class="form-control db-input"
                  placeholder="/home/user/.ssh/id_rsa"
                >
              </div>
            </template>

            <div class="db-ssh-section-label db-ssh-section-label--mt">
              Bridge
            </div>
            <div class="db-field-row">
              <label>Bridge port</label>
              <input
                v-model.number="proxy.bridgePort"
                type="number"
                class="form-control db-input db-input--short"
                placeholder="7999"
                min="1"
                max="65535"
              >
            </div>
            <div class="db-info-text db-info-text--mt">
              <i class="fa-solid fa-circle-info" />&nbsp;
              <template v-if="proxy.connection === 'direct'">
                Direct: connects straight to the bridge at host:port. Use for the same PC or a trusted network (the bridge must be reachable at that address).
              </template>
              <template v-else>
                SSH tunnel: forwards to the bridge over SSH; use for remote hosts where the bridge is bound to loopback.
              </template>
              Import and Reset are unavailable in this mode.
            </div>
          </div>

          <div
            v-if="errorMessage"
            class="db-error"
          >
            <i class="fa-solid fa-triangle-exclamation" />&nbsp; {{ errorMessage }}
          </div>
        </div>

        <div class="modal-footer db-modal-footer d-flex justify-content-end">
          <button
            type="button"
            class="btn btn-outline-secondary rounded-pill px-4 py-2"
            @click="hideModal()"
          >
            Cancel
          </button>
          <button
            type="button"
            class="btn-apply rounded-pill"
            :disabled="isApplying"
            @click="apply()"
          >
            <span
              v-if="isApplying"
              class="spinner-border spinner-border-sm me-1"
              role="status"
            />
            {{ isApplying ? 'Applying…' : 'Apply' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script lang="js">
import { Modal } from 'bootstrap';
import Axios from "@/utils/AxiosWrapper";

const defaultSSH = () => ({
  host: "",
  port: 22,
  user: "",
  authType: "password",
  password: "",
  privateKeyPath: "",
  remoteDir: "",
  remoteFile: "",
});

const defaultProxy = () => ({
  connection: "ssh",
  host: "",
  port: 22,
  user: "",
  authType: "password",
  password: "",
  privateKeyPath: "",
  bridgePort: 7999,
});

export default {
  name: "DBConfigModal",
  emits: ["reload-schema"],
  data: () => ({
    modal: null,
    currentConfig: null,
    mode: "file",
    dbDir: "",
    dbFile: "",
    ssh: defaultSSH(),
    proxy: defaultProxy(),
    isApplying: false,
    errorMessage: "",
  }),
  computed: {
    currentSummary() {
      if (!this.currentConfig) return "";
      const { mode, ssh, isInMemory, dbPath } = this.currentConfig;
      if (mode === "ssh" && ssh) {
        return `${ssh.user}@${ssh.host}:${ssh.remoteDir}`;
      }
      if (mode === "proxy") {
        const c = this.currentConfig;
        if (c.connection === "direct") {
          return `direct ${c.host}:${c.bridgePort}`;
        }
        return `proxy ${c.user}@${c.host} (bridge :${c.bridgePort})`;
      }
      if (isInMemory) return "In-memory";
      return dbPath;
    },
  },
  mounted() {
    this.modal = new Modal(this.$refs.modal);
    this.$refs.modal.addEventListener("hidden.bs.modal", this.onHide);
  },
  beforeUnmount() {
    this.$refs.modal.removeEventListener("hidden.bs.modal", this.onHide);
    this.modal.dispose();
  },
  methods: {
    async showModal() {
      this.errorMessage = "";
      try {
        const res = await Axios.get("/api/db");
        this.currentConfig = res.data;
        this.mode = res.data.mode || (res.data.isInMemory ? "memory" : "file");
        this.dbDir = res.data.dbDir || "";
        this.dbFile = res.data.dbFile || "";
        // Pre-populate SSH fields (password is never returned from server)
        const s = res.data.ssh;
        this.ssh = s
          ? { ...defaultSSH(), host: s.host, port: s.port, user: s.user, authType: s.authType, remoteDir: s.remoteDir, privateKeyPath: s.privateKeyPath || "" }
          : defaultSSH();
        if (res.data.mode === "proxy") {
          this.proxy = {
            ...defaultProxy(),
            connection: res.data.connection || "ssh",
            host: res.data.host || "",
            user: res.data.user || "",
            bridgePort: res.data.bridgePort || 7999,
          };
        }
      } catch {
        this.currentConfig = null;
      }
      this.modal.show();
    },
    hideModal() {
      this.modal.hide();
    },
    onHide() {
      this.errorMessage = "";
      this.isApplying = false;
    },
    buildPayload() {
      if (this.mode === "proxy") {
        const p = this.proxy;
        if (p.connection === "direct") {
          return {
            mode: "proxy",
            proxy: { connection: "direct", host: p.host, bridgePort: p.bridgePort || 7999 },
          };
        }
        const proxyPayload = {
          connection: "ssh",
          host: p.host,
          port: p.port || 22,
          user: p.user,
          bridgePort: p.bridgePort || 7999,
        };
        if (p.authType === "password") proxyPayload.password = p.password;
        else proxyPayload.privateKeyPath = p.privateKeyPath;
        return { mode: "proxy", proxy: proxyPayload };
      }
      if (this.mode === "memory") {
        return { mode: "memory" };
      }
      if (this.mode === "ssh") {
        const s = this.ssh;
        const sshPayload = {
          host: s.host,
          port: s.port || 22,
          user: s.user,
          remoteDir: s.remoteDir,
          remoteFile: s.remoteFile || "database.kz",
        };
        if (s.authType === "password") {
          sshPayload.password = s.password;
        } else {
          sshPayload.privateKeyPath = s.privateKeyPath;
        }
        return { mode: "ssh", ssh: sshPayload };
      }
      return { mode: "file", dbDir: this.dbDir, dbFile: this.dbFile || "database.kz" };
    },
    async apply() {
      this.errorMessage = "";
      this.isApplying = true;
      try {
        await Axios.post("/api/db", this.buildPayload());
        this.$emit("reload-schema");
        this.hideModal();
      } catch (err) {
        this.errorMessage = err.response?.data?.error || err.message || "Failed to apply configuration.";
      } finally {
        this.isApplying = false;
      }
    },
  },
};
</script>

<style lang="scss" scoped>
.db-modal-body {
  border-radius: 1rem 1rem 0 0;
  background-color: var(--bs-body-bg-secondary);
  border: 1px solid var(--bs-body-inactive);
  padding: 2rem;

  h2 {
    font-weight: 500;
    font-size: 1.5rem;
  }

  hr {
    height: 1px;
    margin: 1rem 0;
    background-color: var(--bs-body-inactive);
    border: none;
  }
}

.db-current {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  background-color: var(--bs-body-bg);
  border-radius: 0.5rem;
  padding: 0.6rem 1rem;
  margin-bottom: 1.5rem;
  font-size: 0.875rem;
}

.db-label {
  color: var(--bs-body-inactive);
  white-space: nowrap;
}

.db-path {
  color: var(--bs-body-text);
  word-break: break-all;
}

.db-options {
  display: flex;
  gap: 1rem;
  margin-bottom: 1.5rem;
  flex-wrap: wrap;
}

.db-option-card {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  background-color: var(--bs-body-bg);
  border: 1px solid var(--bs-body-inactive);
  border-radius: 0.5rem;
  padding: 0.6rem 1.2rem;
  cursor: pointer;
  font-size: 0.875rem;

  input[type="radio"] {
    accent-color: var(--bs-body-bg-accent);
  }
}

.db-fields {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.db-ssh-section-label {
  font-size: 0.75rem;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--bs-body-inactive);
  padding-top: 0.25rem;

  &--mt {
    margin-top: 0.5rem;
  }
}

.db-field-row {
  display: flex;
  align-items: center;
  gap: 1rem;

  label {
    min-width: 90px;
    font-size: 0.875rem;
    font-weight: 300;
    color: var(--bs-body-text);
  }
}

.db-input {
  background-color: var(--bs-body-bg);
  border: 1px solid var(--bs-body-inactive);
  color: var(--bs-body-text);
  font-size: 0.875rem;
  border-radius: 0.5rem;

  &--short {
    max-width: 100px;
  }
}

.db-auth-options {
  display: flex;
  gap: 1.5rem;
}

.db-auth-option {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.875rem;
  font-weight: 300;
  cursor: pointer;

  input[type="radio"] {
    accent-color: var(--bs-body-bg-accent);
  }
}

.db-info-text {
  font-size: 0.875rem;
  color: var(--bs-body-inactive);
  padding: 0.5rem 0;

  &--mt {
    margin-top: 0.25rem;
  }

  code {
    font-size: 0.8rem;
    color: var(--bs-body-text);
  }
}

.db-error {
  margin-top: 1rem;
  font-size: 0.875rem;
  color: #dc3545;
}

.db-modal-footer {
  background-color: var(--bs-body-bg-secondary);
  border: 1px solid var(--bs-body-inactive);
  border-top: none;
  border-radius: 0 0 1rem 1rem;
  display: flex;
  gap: 0.75rem;
}

.btn-apply {
  background-color: var(--bs-body-bg-accent);
  color: white;
  padding: 0.5rem 1.5rem;
  border: 0;
  border-radius: 9999px;

  &:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
}
</style>
