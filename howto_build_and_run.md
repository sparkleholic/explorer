# How to Build and Run Ladybug Explorer

## Prerequisites

- [Node.js v20](https://nodejs.org/dist/latest-v20.x/)
- [JDK 11+](https://jdk.java.net/11/) — required only for building Ladybug from source
- C++ toolchain — required only for building Ladybug from source
- [Python 3](https://www.python.org/) — required only for generating grammar files
- [Git](https://git-scm.com/)

---

## Option A: Development Server (from source)

```bash
# 1. Install Node.js dependencies
npm i

# 2. Download and compile Ladybug from source
git submodule update --init --recursive
npm run build-lbug

# 3. Generate grammar files
npm run generate-grammar

# 4. Fetch sample datasets
npm run fetch-datasets

# 5. Start the dev server with hot-reloading
LBUG_DIR=/path/to/db/dir LBUG_FILE=database.kz npm run serve
```

Access at: http://localhost:8080

---

## Option B: Production Build (local)

```bash
# 1. Follow steps 1-4 from Option A, then:
npm run build

# 2. Serve the production build
LBUG_DIR=/path/to/db/dir LBUG_FILE=database.kz npm run serve-prod
```

Access at: http://localhost:8000

---

## Option C: Docker (recommended, no source build needed)

### Using a pre-built image

```bash
docker run -p 8000:8000 \
           -v /path/to/db/dir:/database \
           -e LBUG_FILE=database.kz \
           --rm lbugdb/explorer:latest
```

### Building the Docker image locally

```bash
docker build -t lbugdb/explorer:latest .
docker run -p 8000:8000 \
           -v /path/to/db/dir:/database \
           -e LBUG_FILE=database.kz \
           --rm lbugdb/explorer:latest
```

### Starting with an empty database (no local files needed)

```bash
docker run -p 8000:8000 --rm lbugdb/explorer:latest
```

Then open the **Datasets** tab to load a bundled sample dataset.

Access at: http://localhost:8000

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `LBUG_DIR` | — | Directory containing the database file |
| `LBUG_FILE` | `database.kz` | Database file name |
| `MODE` | `READ_WRITE` | Set to `READ_ONLY` to disable writes |
| `LBUG_BUFFER_POOL_SIZE` | 80% of RAM | Buffer pool size in bytes |
| `LBUG_IN_MEMORY` | `false` | Set to `true` for in-memory mode (changes not persisted) |
| `LBUG_WASM` | `false` | Set to `true` to run queries in-browser via WebAssembly |

---

## DB Menu

The **DB** sidebar menu lets you switch the active database at runtime without restarting the server. Three modes are available:

| Mode | Description |
|---|---|
| File-based | Open a database file on the local filesystem |
| In-memory | Temporary database; all data is lost on restart |
| Remote (SSH) | Mount a database from a remote machine over SSH |

### Remote (SSH) requirements

The SSH mode uses `sshfs` to mount the remote directory on the server machine and opens the database from the mount point directly (full read-write, live sync).

**On the server machine running Ladybug Explorer:**

#### Linux

| Dependency | Required when | Install |
|---|---|---|
| `sshfs` | Always (SSH mode) | `sudo apt install sshfs` / `sudo dnf install fuse-sshfs` |
| `/dev/fuse` | Always (SSH mode) | Kernel FUSE module — present by default on most distributions |
| `sshpass` | Password auth only | `sudo apt install sshpass` / `sudo dnf install sshpass` |

#### macOS

macOS does not support FUSE natively. A third-party kernel extension is required.

1. Install [macFUSE](https://osxfuse.github.io/) (kernel extension):
   ```bash
   brew install --cask macfuse
   ```
   After installation, go to **System Settings → Privacy & Security** and allow the macFUSE kernel extension. A reboot may be required.
   > On Apple Silicon (M1/M2/M3), disabling SIP may be required. See the [macFUSE documentation](https://github.com/osxfuse/osxfuse/wiki/FAQ).

2. Install `sshfs`:
   ```bash
   brew install gromgit/fuse/sshfs-mac
   ```

3. Install `sshpass` (password auth only):
   ```bash
   brew install hudochenkov/sshpass/sshpass
   ```

Private key authentication does not require `sshpass`.

**On the remote machine:**

Only an SSH daemon (`sshd`) is required. No additional software needs to be installed.

**Docker:**

The container needs access to `/dev/fuse` and the `SYS_ADMIN` capability:

```bash
docker run -p 8000:8000 \
           --cap-add SYS_ADMIN \
           --device /dev/fuse \
           --rm lbugdb/explorer:latest
```

`sshfs` and (optionally) `sshpass` must also be present in the container image.

---

## Other Useful Commands

```bash
# Lint
npm run eslint

# Lint with auto-fix
npm run eslint-fix

# Clean all build artifacts and submodules
npm run clean

# Update the Docker image to the latest version
docker pull lbugdb/explorer:latest
```
