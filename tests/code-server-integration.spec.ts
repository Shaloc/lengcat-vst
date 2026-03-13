/**
 * Playwright integration tests that verify the full code-server integration.
 *
 * These tests confirm that:
 *
 *   1. The code-server binary (https://github.com/coder/code-server) is
 *      installed (or auto-installed) via ensureCodeServer().
 *   2. code-server starts and serves the VS Code web UI through the
 *      lengcat-vst reverse proxy.
 *   3. The VS Code workbench configuration meta-tag is present in the HTML
 *      returned through the proxy (proves the full VS Code shell loads).
 *   4. The session manager dashboard lists the running session and shows
 *      the correct status.
 *   5. Clicking a session in the sidebar loads VS Code inside the
 *      dashboard iframe.
 *   6. The session manager can launch a backend by calling its API directly
 *      (exercises the startBackend → ensureCodeServer → code-server path).
 *
 * Screenshots are saved to test-results/ after each suite for visual review.
 *
 * ── Offline / poor-network note ─────────────────────────────────────────────
 * If the test machine cannot reach GitHub, place the code-server tarball in:
 *   ~/.lengcat-vst/code-server/code-server-<version>-<platform>-<arch>.tar.gz
 * The tool will detect and extract it automatically.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import * as path from 'path';
import * as fs from 'fs';
import { test, expect } from '@playwright/test';
import {
  ensureVSCodeServer,
  startVSCodeServer,
} from './helpers/vscode-server';
import { createTunnelServer } from '../src/server';
import { mergeConfig, buildBackendConfig } from '../src/config';
import { SessionManager, _resetCounter } from '../src/session';
import { installedCodeServerVersion, CODE_SERVER_CACHE_DIR } from '../src/download';
import type { TunnelServer } from '../src/server';
import type { VSCodeServerInstance } from './helpers/vscode-server';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function screenshotDir(): string {
  const dir = path.join(__dirname, '..', 'test-results');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function startProxy(
  config: ReturnType<typeof mergeConfig>,
  sessionMgr?: SessionManager
): Promise<{ tunnel: TunnelServer; port: number }> {
  const tunnel = createTunnelServer(config, sessionMgr);
  await new Promise<void>((resolve, reject) => {
    tunnel.httpServer.once('error', reject);
    tunnel.httpServer.listen(0, '127.0.0.1', () => {
      tunnel.httpServer.off('error', reject);
      resolve();
    });
  });
  const { port } = tunnel.httpServer.address() as { port: number };
  return { tunnel, port };
}

// ---------------------------------------------------------------------------
// Global setup — download the code-server binary once for all suites.
// ---------------------------------------------------------------------------

test.beforeAll(async () => {
  // This is the onboarding step: ensure the binary exists before any test
  // tries to use it.  On first run this downloads ~50 MB from GitHub and
  // caches it in CODE_SERVER_CACHE_DIR; subsequent runs are instant.
  await ensureVSCodeServer();
});

// ---------------------------------------------------------------------------
// Suite 1 — code-server binary is installed and reported correctly
// ---------------------------------------------------------------------------

test.describe('code-server binary installation', () => {
  test('binary is present in the cache directory after ensureVSCodeServer', () => {
    const version = installedCodeServerVersion();
    expect(version).toBeTruthy();
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test('cache directory exists and contains the binary', () => {
    expect(fs.existsSync(CODE_SERVER_CACHE_DIR)).toBe(true);
    const version = installedCodeServerVersion()!;
    const entries = fs.readdirSync(CODE_SERVER_CACHE_DIR);
    // Expect a directory named code-server-<version>-<platform>-<arch>
    const hasExtractedDir = entries.some(
      (e) => e.startsWith(`code-server-${version}`) && !e.endsWith('.tar.gz')
    );
    expect(hasExtractedDir).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Suite 2 — code-server serves VS Code through the lengcat-vst proxy
// ---------------------------------------------------------------------------

test.describe('code-server serves VS Code through proxy', () => {
  let vsInstance: VSCodeServerInstance;
  let tunnel: TunnelServer;
  let proxyPort: number;

  test.beforeAll(async () => {
    _resetCounter();
    vsInstance = await startVSCodeServer({ port: 18500 });

    const config = mergeConfig({
      host: '127.0.0.1',
      port: 0,
      auth: false,
      backends: [{
        type: 'vscode',
        host: '127.0.0.1',
        port: vsInstance.port,
        tls: false,
        tokenSource: 'none',
      }],
    });
    ({ tunnel, port: proxyPort } = await startProxy(config));
  });

  test.afterAll(async () => {
    vsInstance.stop();
    await tunnel.close();
  });

  test('proxy returns a successful HTTP response', async ({ page }) => {
    const res = await page.goto(`http://127.0.0.1:${proxyPort}/`, {
      waitUntil: 'domcontentloaded',
    });
    expect(res?.status()).toBeLessThan(500);
  });

  test('VS Code workbench configuration meta-tag is present in the HTML', async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto(`http://127.0.0.1:${proxyPort}/`, { waitUntil: 'domcontentloaded' });
    await expect(
      page.locator('meta#vscode-workbench-web-configuration')
    ).toBeAttached({ timeout: 30_000 });
  });

  test('no 502 gateway errors from the proxy', async ({ page }) => {
    const errors502: string[] = [];
    page.on('response', (r) => { if (r.status() === 502) errors502.push(r.url()); });
    await page.goto(`http://127.0.0.1:${proxyPort}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1_000);
    expect(errors502).toEqual([]);
  });

  test('screenshot: VS Code loaded through proxy', async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto(`http://127.0.0.1:${proxyPort}/`, { waitUntil: 'domcontentloaded' });
    await expect(
      page.locator('meta#vscode-workbench-web-configuration')
    ).toBeAttached({ timeout: 30_000 });
    await page.screenshot({
      path: path.join(screenshotDir(), 'code-server-via-proxy.png'),
    });
  });
});

// ---------------------------------------------------------------------------
// Suite 3 — session manager dashboard manages a code-server session
// ---------------------------------------------------------------------------

test.describe('session manager dashboard manages code-server', () => {
  let vsInstance: VSCodeServerInstance;
  let tunnel: TunnelServer;
  let proxyPort: number;
  let sessionId: string;

  test.beforeAll(async () => {
    _resetCounter();
    // Start code-server with a path prefix so it lives under /_session/cs1/.
    vsInstance = await startVSCodeServer({
      port: 18501,
      basePath: '/_session/cs1',
    });

    const sessionMgr = new SessionManager();
    const cfg = buildBackendConfig({
      type: 'vscode',
      host: '127.0.0.1',
      port: vsInstance.port,
      tls: false,
      tokenSource: 'none',
      pathPrefix: '/_session/cs1',
    });
    const session = sessionMgr.register(cfg);
    // The server is already running externally — mark it as running.
    session.status = 'running';
    sessionId = session.id;

    const config = mergeConfig({
      host: '127.0.0.1',
      port: 0,
      auth: false,
      backends: [],
    });
    ({ tunnel, port: proxyPort } = await startProxy(config, sessionMgr));
  });

  test.afterAll(async () => {
    vsInstance.stop();
    await tunnel.close();
  });

  test('dashboard loads and shows the running code-server session', async ({ page }) => {
    await page.goto(`http://127.0.0.1:${proxyPort}/`, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#session-list')).toBeAttached();
    await expect(page.locator('.session-item')).toHaveCount(1);
    await expect(page.locator('.dot-running')).toBeVisible();
  });

  test('screenshot: dashboard sidebar with running code-server session', async ({ page }) => {
    await page.goto(`http://127.0.0.1:${proxyPort}/`, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('.session-item')).toHaveCount(1);
    await expect(page.locator('.dot-running')).toBeVisible();
    await page.screenshot({
      path: path.join(screenshotDir(), 'session-manager-code-server.png'),
    });
  });

  test('VS Code is accessible at the session path prefix through the proxy', async ({ page }) => {
    test.setTimeout(90_000);
    const sessionUrl = `http://127.0.0.1:${proxyPort}/_session/cs1/`;
    const res = await page.goto(sessionUrl, { waitUntil: 'domcontentloaded' });
    expect(res?.status()).toBeLessThan(500);
    await expect(
      page.locator('meta#vscode-workbench-web-configuration')
    ).toBeAttached({ timeout: 30_000 });
  });

  test('clicking session in sidebar loads VS Code in the dashboard iframe', async ({ page }) => {
    test.setTimeout(90_000);
    await page.goto(`http://127.0.0.1:${proxyPort}/`, { waitUntil: 'domcontentloaded' });
    await page.locator('.session-item').first().click();
    await expect(page.locator('#session-frame')).toBeVisible({ timeout: 8_000 });

    const frame = page.frameLocator('#session-frame');
    await expect(
      frame.locator('meta#vscode-workbench-web-configuration')
    ).toBeAttached({ timeout: 30_000 });

    await page.screenshot({
      path: path.join(screenshotDir(), 'session-manager-iframe-code-server.png'),
    });
  });

  test('REST API returns the session in the session list', async ({ request }) => {
    const res = await request.get(`http://127.0.0.1:${proxyPort}/api/sessions`);
    expect(res.status()).toBe(200);
    const sessions = await res.json() as Array<{ id: string; status: string; type: string }>;
    expect(Array.isArray(sessions)).toBe(true);
    const our = sessions.find((s) => s.id === sessionId);
    expect(our).toBeDefined();
    expect(our?.status).toBe('running');
    expect(our?.type).toBe('vscode');
  });
});

// ---------------------------------------------------------------------------
// Suite 4 — session manager launches code-server via startBackend
// ---------------------------------------------------------------------------
// This suite exercises the full production code path:
//   SessionManager.launch → startBackend → ensureCodeServer → spawn code-server

test.describe('session manager launches code-server automatically', () => {
  let tunnel: TunnelServer;
  let proxyPort: number;
  let sessionMgr: SessionManager;
  let launchedSessionId: string;
  let launchedSessionPath: string;

  test.beforeAll(async () => {
    _resetCounter();
    sessionMgr = new SessionManager();
    // Register a stopped session on a free port.
    const cfg = buildBackendConfig({
      type: 'vscode',
      host: '127.0.0.1',
      port: 18502,
      tls: false,
      tokenSource: 'none',
    });
    const session = sessionMgr.register(cfg);
    launchedSessionId = session.id;
    launchedSessionPath = session.pathPrefix ?? '';

    const config = mergeConfig({
      host: '127.0.0.1',
      port: 0,
      auth: false,
      backends: [],
    });
    ({ tunnel, port: proxyPort } = await startProxy(config, sessionMgr));
  });

  test.afterAll(async () => {
    sessionMgr.stopAll();
    await tunnel.close();
  });

  test('session starts as stopped', async ({ request }) => {
    const res = await request.get(`http://127.0.0.1:${proxyPort}/api/sessions`);
    const sessions = await res.json() as Array<{ id: string; status: string }>;
    const our = sessions.find((s) => s.id === launchedSessionId);
    expect(our?.status).toBe('stopped');
  });

  test('session manager can launch code-server and it becomes running', async ({ request }) => {
    // Increase timeout: the first launch may need to start code-server.
    test.setTimeout(120_000);

    const launchRes = await request.post(
      `http://127.0.0.1:${proxyPort}/api/sessions/${launchedSessionId}/launch`
    );
    // /launch now responds 202 Accepted immediately and runs in the background.
    expect(launchRes.status()).toBe(202);

    // Poll until the session is running (max 60 s).
    const deadline = Date.now() + 60_000;
    let status = 'stopped';
    while (Date.now() < deadline) {
      const listRes = await request.get(`http://127.0.0.1:${proxyPort}/api/sessions`);
      const sessions = await listRes.json() as Array<{ id: string; status: string }>;
      status = sessions.find((s) => s.id === launchedSessionId)?.status ?? 'stopped';
      if (status === 'running') break;
      await new Promise<void>((r) => setTimeout(r, 1_000));
    }
    expect(status).toBe('running');
  });

  test('VS Code is accessible through the proxy after launch', async ({ page }) => {
    test.setTimeout(90_000);
    // Navigate to the session's path prefix, not the dashboard root.
    // (With a SessionManager active, the root '/' serves the dashboard.)
    const sessionPath = launchedSessionPath.replace(/\/$/, '');
    const sessionUrl = `http://127.0.0.1:${proxyPort}${sessionPath}/`;
    await page.goto(sessionUrl, { waitUntil: 'domcontentloaded' });
    await expect(
      page.locator('meta#vscode-workbench-web-configuration')
    ).toBeAttached({ timeout: 30_000 });
  });

  test('dashboard shows the launched session as running', async ({ page }) => {
    // Navigate to dashboard root which polls for session status every 3 s.
    await page.goto(`http://127.0.0.1:${proxyPort}/`, { waitUntil: 'domcontentloaded' });
    // Allow up to 10 s for the first dashboard poll to render the running dot.
    await expect(page.locator('.dot-running')).toBeVisible({ timeout: 10_000 });
    await page.screenshot({
      path: path.join(screenshotDir(), 'session-auto-launched.png'),
    });
  });
});
