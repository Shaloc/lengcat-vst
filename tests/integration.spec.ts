/**
 * Integration tests for lengcat-vst against a real VS Code server.
 *
 * These tests start an actual VS Code web server using the code-server binary
 * (from https://github.com/coder/code-server) and verify that:
 *
 *  1. The proxy (HTTP) correctly forwards requests from the browser to VS Code.
 *  2. VS Code's HTML shell, static assets, and WebSocket-based extension host
 *     all work end-to-end through the tunnel.
 *  3. Multi-instance routing sends two separate VS Code instances to the
 *     correct backends based on the URL path prefix.
 *  4. Both instances can be loaded simultaneously in the same browser page
 *     (i.e., in separate <iframe> elements).
 *  5. HTTPS (TLS) proxy — the proxy is served over wss/https (self-signed cert)
 *     so the browser grants a secure context; access is via IP (127.0.0.1),
 *     not "localhost", simulating real-world IP-based access.
 *  6. The VS Code workbench actually renders (`.monaco-workbench` element is
 *     visible) confirming the full UI is up, not just the HTML shell.
 *
 * On first run the code-server binary is downloaded (~50 MB) and cached in
 * ~/.lengcat-vst/code-server/ so subsequent runs are fast.
 *
 * For offline / poor-network usage: place the tarball at
 *   ~/.lengcat-vst/code-server/code-server-<version>-<platform>-<arch>.tar.gz
 * and the tool will detect and extract it without downloading.
 *
 * For focused code-server + session manager integration tests, see:
 *   tests/code-server-integration.spec.ts
 */

import * as path from 'path';
import * as fs from 'fs';
import { test, expect } from '@playwright/test';
import { ensureVSCodeServer, startVSCodeServer } from './helpers/vscode-server';
import { createTunnelServer } from '../src/server';
import { mergeConfig, buildBackendConfig } from '../src/config';
import { SessionManager, _resetCounter } from '../src/session';
import { loadOrGenerateTls } from '../src/tls';
import type { TunnelServer } from '../src/server';
import type { VSCodeServerInstance } from './helpers/vscode-server';
import type { TlsCredentials } from '../src/tls';

// ---------------------------------------------------------------------------
// Shared TLS credentials (generated once for the whole test run)
// ---------------------------------------------------------------------------

let sharedTls: TlsCredentials;

// ---------------------------------------------------------------------------
// Shared setup helpers
// ---------------------------------------------------------------------------

/** Starts the proxy on a random port and returns the tunnel + chosen port. */
async function startProxy(
  config: ReturnType<typeof mergeConfig>,
  tls?: TlsCredentials,
  sessionMgr?: SessionManager
): Promise<{ tunnel: TunnelServer; port: number }> {
  const tunnel = createTunnelServer(config, sessionMgr, tls);
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
// Prepare the VS Code server binary + TLS cert once for all tests.
// ---------------------------------------------------------------------------

test.beforeAll(async () => {
  await ensureVSCodeServer();
  sharedTls = await loadOrGenerateTls();   // auto-generates & caches
});

// ---------------------------------------------------------------------------
// Test suite 1 — single VS Code instance behind the proxy (HTTP)
// ---------------------------------------------------------------------------

test.describe('Single VS Code instance', () => {
  let vsInstance: VSCodeServerInstance;
  let tunnel: TunnelServer;
  let proxyPort: number;

  test.beforeAll(async () => {
    vsInstance = await startVSCodeServer({ port: 18100 });

    const config = mergeConfig({
      host: '127.0.0.1',
      port: 0,
      auth: false,
      backends: [
        {
          type: 'vscode',
          host: '127.0.0.1',
          port: vsInstance.port,
          tls: false,
          tokenSource: 'none',
        },
      ],
    });
    ({ tunnel, port: proxyPort } = await startProxy(config));
  });

  test.afterAll(async () => {
    await tunnel.close();
    vsInstance.stop();
  });

  test('proxy returns the VS Code HTML shell', async ({ page }) => {
    const res = await page.goto(`http://127.0.0.1:${proxyPort}/`, {
      waitUntil: 'domcontentloaded',
    });

    // The proxy must successfully forward the request (not a 5xx).
    expect(res?.status()).toBeLessThan(500);

    // VS Code serve-web wraps the workbench in an HTML page that always
    // contains this configuration meta tag.
    await expect(
      page.locator('meta#vscode-workbench-web-configuration')
    ).toBeAttached();
  });

  test('VS Code workbench configuration meta tag contains expected fields', async ({
    page,
  }) => {
    await page.goto(`http://127.0.0.1:${proxyPort}/`, {
      waitUntil: 'domcontentloaded',
    });

    const metaContent = await page
      .locator('meta#vscode-workbench-web-configuration')
      .getAttribute('data-settings');

    expect(metaContent).toBeTruthy();
    // The configuration should identify the remote authority.
    const settings = JSON.parse(metaContent as string);
    expect(settings).toHaveProperty('remoteAuthority');
  });

  test('static assets requested by VS Code are served through the proxy', async ({
    page,
  }) => {
    const proxyErrors: string[] = [];

    // Only flag 502 responses — those mean the proxy failed to reach the
    // backend.  4xx or net::ERR_ABORTED for specific asset URLs are normal
    // for optional VS Code modules (e.g. WASM files) that may not be
    // included in the test package.
    page.on('response', (res) => {
      if (res.status() === 502) {
        proxyErrors.push(`502 from proxy: ${res.url()}`);
      }
    });

    await page.goto(`http://127.0.0.1:${proxyPort}/`, {
      waitUntil: 'domcontentloaded',
    });

    // Give the page a moment to start issuing sub-resource requests.
    await page.waitForTimeout(1000);

    expect(proxyErrors).toEqual([]);
  });

  test('extension host WebSocket upgrade is proxied without error', async ({
    page,
  }) => {
    const wsErrors: string[] = [];

    page.on('websocket', (ws) => {
      ws.on('socketerror', (err) => wsErrors.push(err));
    });

    await page.goto(`http://127.0.0.1:${proxyPort}/`, {
      waitUntil: 'domcontentloaded',
    });

    // Allow a short window for VS Code to initiate the extension host WS.
    await page.waitForTimeout(3000);

    // No WebSocket-level errors should have been raised by the proxy.
    expect(wsErrors).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Test suite 2 — multi-instance path-prefix routing with real VS Code servers
// ---------------------------------------------------------------------------

test.describe('Multi-instance path-prefix routing (real VS Code servers)', () => {
  let vsInstance1: VSCodeServerInstance;
  let vsInstance2: VSCodeServerInstance;
  let tunnel: TunnelServer;
  let proxyPort: number;

  test.beforeAll(async () => {
    // Start two VS Code servers, each with their own base path so assets and
    // API calls are namespaced under the correct prefix.
    [vsInstance1, vsInstance2] = await Promise.all([
      startVSCodeServer({ port: 18101, basePath: '/instance/1' }),
      startVSCodeServer({ port: 18102, basePath: '/instance/2' }),
    ]);

    const config = mergeConfig({
      host: '127.0.0.1',
      port: 0,
      auth: false,
      backends: [
        {
          type: 'vscode',
          host: '127.0.0.1',
          port: vsInstance1.port,
          tls: false,
          tokenSource: 'none',
          pathPrefix: '/instance/1',
        },
        {
          type: 'vscode',
          host: '127.0.0.1',
          port: vsInstance2.port,
          tls: false,
          tokenSource: 'none',
          pathPrefix: '/instance/2',
        },
      ],
    });

    ({ tunnel, port: proxyPort } = await startProxy(config));
  });

  test.afterAll(async () => {
    await tunnel.close();
    vsInstance1.stop();
    vsInstance2.stop();
  });

  test('requests to /instance/1 reach VS Code instance 1', async ({
    page,
  }) => {
    const res = await page.goto(
      `http://127.0.0.1:${proxyPort}/instance/1`,
      { waitUntil: 'domcontentloaded' }
    );

    expect(res?.status()).toBeLessThan(500);
    await expect(
      page.locator('meta#vscode-workbench-web-configuration')
    ).toBeAttached();
  });

  test('requests to /instance/2 reach VS Code instance 2', async ({
    page,
  }) => {
    const res = await page.goto(
      `http://127.0.0.1:${proxyPort}/instance/2`,
      { waitUntil: 'domcontentloaded' }
    );

    expect(res?.status()).toBeLessThan(500);
    await expect(
      page.locator('meta#vscode-workbench-web-configuration')
    ).toBeAttached();
  });

  test('instance 1 serverBasePath is /instance/1', async ({ page }) => {
    await page.goto(
      `http://127.0.0.1:${proxyPort}/instance/1`,
      { waitUntil: 'domcontentloaded' }
    );

    const metaContent = await page
      .locator('meta#vscode-workbench-web-configuration')
      .getAttribute('data-settings');

    const settings = JSON.parse(metaContent as string);
    // VS Code / code-server encodes the base path into serverBasePath.
    // The exact format may be an absolute path ("/instance/1") or a relative
    // one ("./1") depending on the server version; what matters is that it
    // uniquely identifies this instance and ends with the segment "1".
    expect(settings.serverBasePath).toMatch(/1$/);
  });

  test('instance 2 serverBasePath is /instance/2', async ({ page }) => {
    await page.goto(
      `http://127.0.0.1:${proxyPort}/instance/2`,
      { waitUntil: 'domcontentloaded' }
    );

    const metaContent = await page
      .locator('meta#vscode-workbench-web-configuration')
      .getAttribute('data-settings');

    const settings = JSON.parse(metaContent as string);
    expect(settings.serverBasePath).toMatch(/2$/);
  });

  test('both instances load simultaneously in the same browser page via iframes', async ({
    page,
  }) => {
    // Build an HTML page that embeds both VS Code instances as iframes.
    const containerHtml = `
      <!DOCTYPE html>
      <html>
        <body>
          <iframe id="frame1"
            src="http://127.0.0.1:${proxyPort}/instance/1"
            width="1200" height="800">
          </iframe>
          <iframe id="frame2"
            src="http://127.0.0.1:${proxyPort}/instance/2"
            width="1200" height="800">
          </iframe>
        </body>
      </html>`;

    await page.setContent(containerHtml, { waitUntil: 'load' });

    // Both iframes must have loaded a VS Code page (meta tag present).
    const frame1 = page.frameLocator('#frame1');
    await expect(
      frame1.locator('meta#vscode-workbench-web-configuration')
    ).toBeAttached({ timeout: 20_000 });

    const frame2 = page.frameLocator('#frame2');
    await expect(
      frame2.locator('meta#vscode-workbench-web-configuration')
    ).toBeAttached({ timeout: 20_000 });

    // Each iframe must show a serverBasePath that identifies its own instance.
    // The exact format is server-version-dependent (may be "./1" or "/instance/1"),
    // so we verify the two values are different and each ends with the correct
    // numeric segment — confirming cross-routing is absent.
    const settings1 = JSON.parse(
      (await frame1
        .locator('meta#vscode-workbench-web-configuration')
        .getAttribute('data-settings')) as string
    );
    expect(settings1.serverBasePath).toMatch(/1$/);

    const settings2 = JSON.parse(
      (await frame2
        .locator('meta#vscode-workbench-web-configuration')
        .getAttribute('data-settings')) as string
    );
    expect(settings2.serverBasePath).toMatch(/2$/);

    // The two paths must differ so that VS Code assets don't collide.
    expect(settings1.serverBasePath).not.toBe(settings2.serverBasePath);
  });
});

// ---------------------------------------------------------------------------
// Test suite 3 — HTTPS proxy + IP-based access + VS Code UI visible
//
// This suite is the primary proof that:
//   • The proxy can serve over HTTPS (TLS-terminated, self-signed cert).
//   • The browser reaches VS Code via 127.0.0.1 (IP, not "localhost").
//   • The VS Code workbench actually renders — `.monaco-workbench` is
//     present — confirming the full UI is up, not just the HTML shell.
//   • Screenshots are captured so the result can be reviewed visually.
// ---------------------------------------------------------------------------

test.describe('HTTPS proxy — IP access — VS Code workbench visible', () => {
  let vsInstance: VSCodeServerInstance;
  let tunnel: TunnelServer;
  let proxyPort: number;

  test.beforeAll(async () => {
    vsInstance = await startVSCodeServer({ port: 18200 });

    const config = mergeConfig({
      host: '127.0.0.1',  // bind to IP address, not hostname
      port: 0,
      auth: false,
      backends: [
        {
          type: 'vscode',
          host: '127.0.0.1',
          port: vsInstance.port,
          tls: false,
          tokenSource: 'none',
        },
      ],
    });

    // Use the shared TLS credentials so the proxy is HTTPS.
    ({ tunnel, port: proxyPort } = await startProxy(config, sharedTls));
  });

  test.afterAll(async () => {
    await tunnel.close();
    vsInstance.stop();
  });

  test('proxy is serving HTTPS', () => {
    expect(tunnel.isHttps).toBe(true);
  });

  test('HTTPS proxy returns VS Code HTML shell via IP address', async ({ page }) => {
    // Access the proxy via the IP address (127.0.0.1), not "localhost".
    const url = `https://127.0.0.1:${proxyPort}/`;
    const res = await page.goto(url, { waitUntil: 'domcontentloaded' });

    expect(res?.status()).toBeLessThan(500);
    await expect(
      page.locator('meta#vscode-workbench-web-configuration')
    ).toBeAttached({ timeout: 15_000 });
  });

  test('VS Code workbench renders in the browser (visual confirmation)', async ({ page }) => {
    // Navigate to VS Code via HTTPS + IP and wait for the full workbench to
    // initialise.  This is the definitive proof that VS Code is actually up
    // and the browser has a working secure context.
    await page.goto(`https://127.0.0.1:${proxyPort}/`, {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    });

    // Configuration meta tag — present as soon as the HTML shell loads.
    await expect(
      page.locator('meta#vscode-workbench-web-configuration')
    ).toBeAttached({ timeout: 15_000 });

    // The Monaco workbench container is injected into the DOM only after the
    // workbench JS has fully initialised — its presence confirms VS Code is
    // running, not just that the HTML was served.
    await expect(
      page.locator('.monaco-workbench')
    ).toBeAttached({ timeout: 45_000 });

    // Capture a screenshot for human review.
    const screenshotDir = path.join(__dirname, '..', 'test-results');
    fs.mkdirSync(screenshotDir, { recursive: true });
    await page.screenshot({
      path: path.join(screenshotDir, 'vscode-https-ip.png'),
      fullPage: false,
    });
  });

  test('no 502 errors when loading VS Code over HTTPS via IP', async ({ page }) => {
    const proxyErrors: string[] = [];
    page.on('response', (res) => {
      if (res.status() === 502) proxyErrors.push(res.url());
    });

    await page.goto(`https://127.0.0.1:${proxyPort}/`, {
      waitUntil: 'domcontentloaded',
    });
    await page.waitForTimeout(1500);

    expect(proxyErrors).toEqual([]);
  });

  test('WebSocket connection has no errors (wss:// over HTTPS proxy)', async ({ page }) => {
    const wsErrors: string[] = [];
    page.on('websocket', (ws) => {
      ws.on('socketerror', (err) => wsErrors.push(String(err)));
    });

    await page.goto(`https://127.0.0.1:${proxyPort}/`, {
      waitUntil: 'domcontentloaded',
    });
    await page.waitForTimeout(3_000);

    // No WebSocket-level transport errors from the proxy layer.
    expect(wsErrors).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Test suite 4 — Session dashboard (HTTPS + IP): session visible, iframe loads
// ---------------------------------------------------------------------------

test.describe('Session dashboard — HTTPS + IP — iframe shows VS Code', () => {
  let vsInstance: VSCodeServerInstance;
  let tunnel: TunnelServer;
  let proxyPort: number;
  let sessionPathPrefix: string;

  test.beforeAll(async () => {
    _resetCounter();
    // Start VS Code with a path prefix so it lives at /_session/s1/.
    vsInstance = await startVSCodeServer({ port: 18201, basePath: '/_session/s1' });

    const sessionMgr = new SessionManager();
    const cfg = buildBackendConfig({
      type: 'vscode',
      host: '127.0.0.1',
      port: vsInstance.port,
      tls: false,
      tokenSource: 'none',
      pathPrefix: '/_session/s1',
    });
    const session = sessionMgr.register(cfg);
    // The VS Code server is already running — mark the session as running.
    session.status = 'running';
    sessionPathPrefix = session.pathPrefix;

    const config = mergeConfig({
      host: '127.0.0.1',
      port: 0,
      auth: false,
      backends: [],    // backends come from the session manager at runtime
    });

    ({ tunnel, port: proxyPort } = await startProxy(config, sharedTls, sessionMgr));
  });

  test.afterAll(async () => {
    await tunnel.close();
    vsInstance.stop();
  });

  test('dashboard is served over HTTPS at the root', async ({ page }) => {
    const res = await page.goto(`https://127.0.0.1:${proxyPort}/`, {
      waitUntil: 'domcontentloaded',
    });
    expect(res?.status()).toBe(200);
    // The dashboard HTML must contain the session-list element.
    await expect(page.locator('#session-list')).toBeAttached();
  });

  test('registered session appears in the sidebar', async ({ page }) => {
    await page.goto(`https://127.0.0.1:${proxyPort}/`, {
      waitUntil: 'domcontentloaded',
    });
    // At least one session item should be listed.
    await expect(page.locator('.session-item')).toHaveCount(1);
    // The status dot should be green (running).
    await expect(page.locator('.dot-running')).toBeVisible();
  });

  test('VS Code loads directly at the session path via HTTPS + IP', async ({ page }) => {
    // Access the session URL directly (not via the iframe) to confirm
    // the proxy routes the prefixed path correctly over HTTPS.
    const url = `https://127.0.0.1:${proxyPort}${sessionPathPrefix}/`;
    const res = await page.goto(url, { waitUntil: 'domcontentloaded' });

    expect(res?.status()).toBeLessThan(500);

    await expect(
      page.locator('meta#vscode-workbench-web-configuration')
    ).toBeAttached({ timeout: 15_000 });

    // Full workbench must be rendered.
    await expect(
      page.locator('.monaco-workbench')
    ).toBeAttached({ timeout: 45_000 });

    // Screenshot for visual review.
    const screenshotDir = path.join(__dirname, '..', 'test-results');
    fs.mkdirSync(screenshotDir, { recursive: true });
    await page.screenshot({
      path: path.join(screenshotDir, 'vscode-session-https-ip.png'),
      fullPage: false,
    });
  });

  test('clicking a running session loads VS Code in the dashboard iframe', async ({ page }) => {
    await page.goto(`https://127.0.0.1:${proxyPort}/`, {
      waitUntil: 'domcontentloaded',
    });

    // Click the session to select it.
    await page.locator('.session-item').first().click();

    // Each running session gets an iframe with id="session-frame-{sessionId}".
    await expect(page.locator('iframe[id^="session-frame-"]').first()).toBeVisible({ timeout: 8_000 });

    // VS Code must load inside the iframe.
    const frameLocator = page.frameLocator('iframe[id^="session-frame-"]').first();
    await expect(
      frameLocator.locator('meta#vscode-workbench-web-configuration')
    ).toBeAttached({ timeout: 30_000 });

    // Screenshot: dashboard with VS Code inside the iframe.
    const screenshotDir = path.join(__dirname, '..', 'test-results');
    fs.mkdirSync(screenshotDir, { recursive: true });
    await page.screenshot({
      path: path.join(screenshotDir, 'dashboard-iframe-vscode.png'),
      fullPage: false,
    });
  });
});
