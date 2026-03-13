# AGENTS.md — lengcat-vst Project Guide

> This file is for AI agents (GitHub Copilot, Codex, etc.) that work on this repository.
> Read it in full before making any changes.

---

## What this project does

**lengcat-vst** is a Node.js reverse-proxy tunnel that lets you embed one or more
[VS Code serve-web](https://code.visualstudio.com/docs/remote/vscode-server) /
[code-server](https://github.com/coder/code-server) instances inside a single browser
page (dashboard), without exposing them to the public internet.

Key capabilities:
- Proxies HTTP and WebSocket traffic to one or more VS Code backends.
- Serves a session-management dashboard (`/`) with a sidebar listing all sessions.
- Each session has its own `<iframe>` in the dashboard; switching sessions shows/hides
  iframes using **`visibility: hidden`** (never `display: none`) to keep VS Code
  connected in the background.
- Sessions can be launched and stopped via the dashboard REST API (`/api/sessions`).
- Optional TLS (self-signed cert auto-generated via `selfsigned`) so browsers grant a
  secure context, which VS Code extensions require.
- The code-server binary is auto-downloaded from GitHub Releases on first use and
  cached in `~/.lengcat-vst/code-server/`.

---

## Repository layout

```
src/
  auth.ts        — proxy-secret authentication middleware
  backends.ts    — spawns code-server / custom VS Code executables
  config.ts      — CLI argument parsing & backend config types
  download.ts    — downloads and caches the code-server binary
  index.ts       — CLI entry-point (commander)
  server.ts      — HTTP/HTTPS tunnel server + WebSocket proxy
  session.ts     — SessionManager: register / launch / stop sessions
  tls.ts         — self-signed TLS cert generation/caching
  ui.ts          — renderDashboard() — the full dashboard HTML+CSS+JS

tests/
  auth.test.ts                      — unit: auth middleware
  backends.test.ts                  — unit: resolveExecutable, buildCodeServerArgs, backendOrigin
  config.test.ts                    — unit: mergeConfig, buildBackendConfig
  server.test.ts                    — unit: selectBackend, request/WS routing
  session.test.ts                   — unit: SessionManager (register/launch/stop/…)
  ui.test.ts                        — unit: renderDashboard() HTML content
  ui.spec.ts                        — Playwright: dashboard UI (mock backends)
  code-server-integration.spec.ts   — Playwright: real code-server end-to-end
  integration.spec.ts               — Playwright: full VS Code server end-to-end
  helpers/
    vscode-server.ts                — test helper: start/stop code-server instances
```

---

## Development commands

```bash
npm ci                  # install dependencies
npm run build           # compile TypeScript → dist/
npm test                # run Jest unit tests
npm run test:e2e        # run Playwright integration tests (downloads code-server ~50 MB on first run)
npm run lint            # ESLint
```

> **Before opening a pull request you MUST run both test suites and ensure they pass:**
> ```bash
> npm test && npm run test:e2e
> ```
> The CI workflow (`.github/workflows/ci.yml`) enforces this automatically on every PR.

---

## Critical design decisions (do NOT change without understanding them)

### 1. Iframe hiding: `visibility: hidden`, not `display: none`

Non-active session iframes are hidden with **`visibility: hidden`** and
`pointer-events: none`.  Using `display: none` collapses the iframe viewport to 0 × 0,
which causes VS Code's web client to detect a "hidden" window and fire the
`join.disconnectRemote` lifecycle hook — disconnecting from the code-server backend.
`visibility: hidden` keeps the rendered viewport dimensions intact so VS Code stays
connected in the background.

### 2. Path-prefix routing and stripping

The proxy strips each session's `pathPrefix` before forwarding to its code-server
backend.  code-server (coder/code-server) does NOT support a `--server-base-path` flag,
so it always serves at `/`.  VS Code's web client generates static-asset URLs relative
to its current page URL (which includes the session prefix in the iframe), so the
resulting URLs reach the proxy with the prefix intact, are routed correctly, the prefix
is stripped, and code-server serves them from `/`.

### 3. Port-conflict detection (session launch guard)

`SessionManager.launch()` checks whether any *other* running session already uses the
same `host:port` before spawning.  If so, it immediately sets `session.status = 'error'`
and throws a human-readable error.  This prevents silent EADDRINUSE failures where
code-server would exit instantly and leave the session looking stuck.

### 4. Shared `--user-data-dir`

All code-server sessions use `$HOME/.vscode-server/data` as `--user-data-dir` so that
existing VS Code Remote settings, keybindings, and extension state are immediately
available.  Each session still gets its own per-session `--extensions-dir` under
`~/.lengcat-vst/sessions/<host>-<port>/extensions` to avoid extension conflicts.

---

## Common pitfalls for agents

| Symptom | Root cause | Fix |
|---|---|---|
| Second session disconnects immediately | Iframe was hidden with `display:none` | Use `visibility:hidden` in `loadFrame()` |
| Service-worker registration fails for session sN | code-server for sN failed to start (port reuse) | Check `session.errorMessage`; fix port conflict |
| `#session-frame` selector in Playwright tests | Old single-iframe design; iframes now use `id="session-frame-{id}"` | Use `iframe[id^="session-frame-"]` |
| code-server exits immediately on launch | Port already in use (`EADDRINUSE`) | `SessionManager.launch()` now catches this proactively |
| Session shows status=error with no visible reason | `errorMessage` not shown in UI | The `#session-error-banner` and `.session-item-error` elements surface it |

---

## Pull-request checklist

Every PR **must** satisfy all of the following before requesting a review:

- [ ] `npm run lint` passes with zero errors.
- [ ] `npm test` (Jest unit tests) passes — all tests green.
- [ ] `npm run test:e2e` (Playwright integration tests) passes — all tests green.
- [ ] No regressions: do not delete or weaken existing tests.
- [ ] New behaviour is covered by at least one new test (unit or Playwright).
- [ ] Design decisions documented in this file are respected; deviations are
      explained in the PR description.
