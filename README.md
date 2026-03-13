# lengcat-vst

A private local HTTP reverse proxy that gives your browser safe, zero-cloud access to VS Code / VSCodium / Lingma / Qoder web servers (`serve-web` mode).

## Features

- **Reverse HTTP + WebSocket proxy** — all traffic (including the VS Code extension-host WebSocket) is forwarded transparently.
- **Multi-instance support** — run several VS Code instances behind a single proxy port, each reachable at its own URL path prefix (e.g. `/instance/1`, `/instance/2`). Embed them side-by-side in the same browser page using `<iframe>` elements.
- **Optional proxy authentication** — protect the proxy with a Bearer token so only you can reach your editor.
- **Supports all major VS Code variants** — `vscode` (`code`), `vscodium` (`codium`), `lingma`, `qoder`, or any custom binary.
- **No public internet exposure** — the proxy only listens on `127.0.0.1` by default.

---

## Quick start

```bash
# Install
npm install -g lengcat-vst

# Start a VS Code serve-web backend, then proxy it on port 3000
lengcat-vst --backend-type vscode --backend-port 8000

# Open http://127.0.0.1:3000 in your browser
```

---

## Multi-instance (several editors in one browser page)

Start two VS Code backends on different ports **with different base paths**:

```bash
# Terminal 1 — instance 1 on port 8001 with base path /instance/1
code serve-web --host 127.0.0.1 --port 8001 --server-base-path /instance/1 --without-connection-token

# Terminal 2 — instance 2 on port 8002 with base path /instance/2
code serve-web --host 127.0.0.1 --port 8002 --server-base-path /instance/2 --without-connection-token
```

Create a JSON config file (`config.json`):

```json
{
  "host": "127.0.0.1",
  "port": 3000,
  "backends": [
    { "type": "vscode", "host": "127.0.0.1", "port": 8001, "tls": false, "tokenSource": "none", "pathPrefix": "/instance/1" },
    { "type": "vscode", "host": "127.0.0.1", "port": 8002, "tls": false, "tokenSource": "none", "pathPrefix": "/instance/2" }
  ]
}
```

Start the proxy:

```bash
lengcat-vst --config config.json
```

Now open:
- `http://127.0.0.1:3000/instance/1` → editor 1
- `http://127.0.0.1:3000/instance/2` → editor 2

Or embed both in one HTML page:

```html
<iframe src="http://127.0.0.1:3000/instance/1" width="1200" height="800"></iframe>
<iframe src="http://127.0.0.1:3000/instance/2" width="1200" height="800"></iframe>
```

---

## CLI reference

```
lengcat-vst [options]

Options:
  --config <path>            Path to JSON config file
  --port <port>              Local proxy listen port  (default: 3000)
  --host <host>              Local proxy bind address (default: 127.0.0.1)
  --backend-type <type>      vscode | vscodium | lingma | qoder | custom (default: vscodium)
  --backend-host <host>      Backend server host      (default: localhost)
  --backend-port <port>      Backend server port
  --path-prefix <prefix>     Path prefix for multi-instance routing (e.g. /instance/1)
  --token <secret>           Enable proxy auth; provide the secret token
  --backend-token <token>    Fixed connection token for the VS Code backend
```

---

## Configuration file schema

All fields are optional; missing values fall back to defaults.

```jsonc
{
  "host": "127.0.0.1",      // proxy bind address
  "port": 3000,             // proxy listen port
  "auth": false,            // require a proxy token?
  "proxySecret": "",        // token required when auth=true
  "backends": [
    {
      "type": "vscode",     // vscode | vscodium | lingma | qoder | custom
      "host": "localhost",
      "port": 8000,
      "tls": false,
      "tokenSource": "none",   // none | fixed | auto
      "token": "",             // used when tokenSource=fixed
      "executable": "",        // used when type=custom
      "pathPrefix": "/instance/1"  // enables multi-instance routing
    }
  ]
}
```

Default ports by backend type:

| Type | Default port |
|------|-------------|
| `vscode` | 8000 |
| `vscodium` | 8000 |
| `lingma` | 8080 |
| `qoder` | 8080 |
| `custom` | 8000 |

---

## Development

```bash
# Install dependencies
npm install

# Build TypeScript
npm run build

# Run unit tests (Jest)
npm test

# Run UI tests (Playwright, mock backends — fast)
npm run test:e2e -- tests/ui.spec.ts

# Run integration tests (Playwright, real VS Code server — downloads ~49 MB on first run)
npm run test:e2e -- tests/integration.spec.ts

# Lint
npm run lint
```

### Test architecture

| Test file | What it tests | Speed |
|-----------|--------------|-------|
| `tests/*.test.ts` | Unit/integration tests (Jest, no browser) | Fast |
| `tests/ui.spec.ts` | Proxy routing in a real browser with lightweight mock backends (Playwright) | Fast |
| `tests/integration.spec.ts` | End-to-end tests with a genuine VS Code server and Playwright | Slower (first run downloads ~49 MB) |

The VS Code server used in integration tests comes from the [`code-server`](https://github.com/coder/code-server) npm package and is cached in `/tmp/lengcat-vst-vscode-server` after the first run.

