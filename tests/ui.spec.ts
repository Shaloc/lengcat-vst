/**
 * Playwright UI tests for the lengcat-vst proxy.
 *
 * These tests use lightweight mock HTTP backends to verify that the proxy
 * correctly serves content and handles multi-instance path-prefix routing —
 * all without requiring a real VS Code installation.
 *
 * For integration tests that exercise a genuine VS Code server see
 * integration.spec.ts.
 */

import { test, expect } from '@playwright/test';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { createTunnelServer } from '../src/server';
import { mergeConfig, buildBackendConfig } from '../src/config';
import { SessionManager } from '../src/session';
import type { TunnelServer } from '../src/server';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface MockBackend {
  server: http.Server;
  port: number;
  close(): Promise<void>;
}

/**
 * Starts a minimal HTTP server that returns a simple HTML page containing
 * `label` in an <h1>.  Every request path receives a 200 response so the
 * mock can also handle static-asset requests that a browser may make after
 * loading the page.
 */
function startMockBackend(label: string): Promise<MockBackend> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((_req, res) => {
      const html = `<!DOCTYPE html><html><head><title>${label}</title></head><body><h1>${label}</h1></body></html>`;
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      resolve({
        server,
        port,
        close: () => new Promise<void>((res) => server.close(() => res())),
      });
    });
    server.once('error', reject);
  });
}

/** Starts the proxy on a random port and returns both the server and the port. */
async function startProxy(config: ReturnType<typeof mergeConfig>): Promise<{
  tunnel: TunnelServer;
  port: number;
}> {
  const tunnel = createTunnelServer(config);
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
// Tests — single backend
// ---------------------------------------------------------------------------

test.describe('Single-backend proxy', () => {
  let backend: MockBackend;
  let tunnel: TunnelServer;
  let proxyPort: number;

  test.beforeAll(async () => {
    backend = await startMockBackend('Hello from backend');
    const config = mergeConfig({
      host: '127.0.0.1',
      port: 0,
      auth: false,
      backends: [
        {
          type: 'vscode',
          host: '127.0.0.1',
          port: backend.port,
          tls: false,
          tokenSource: 'none',
        },
      ],
    });
    ({ tunnel, port: proxyPort } = await startProxy(config));
  });

  test.afterAll(async () => {
    await tunnel.close();
    await backend.close();
  });

  test('page loads and contains backend content', async ({ page }) => {
    await page.goto(`http://127.0.0.1:${proxyPort}/`);
    await expect(page.locator('h1')).toContainText('Hello from backend');
  });

  test('page title is set by backend', async ({ page }) => {
    await page.goto(`http://127.0.0.1:${proxyPort}/`);
    await expect(page).toHaveTitle('Hello from backend');
  });
});

// ---------------------------------------------------------------------------
// Tests — proxy auth
// ---------------------------------------------------------------------------

test.describe('Proxy authentication', () => {
  let backend: MockBackend;
  let tunnel: TunnelServer;
  let proxyPort: number;

  test.beforeAll(async () => {
    backend = await startMockBackend('Protected content');
    const config = mergeConfig({
      host: '127.0.0.1',
      port: 0,
      auth: true,
      proxySecret: 'testsecret',
      backends: [
        {
          type: 'vscode',
          host: '127.0.0.1',
          port: backend.port,
          tls: false,
          tokenSource: 'none',
        },
      ],
    });
    ({ tunnel, port: proxyPort } = await startProxy(config));
  });

  test.afterAll(async () => {
    await tunnel.close();
    await backend.close();
  });

  test('redirects or shows 401 without token', async ({ page }) => {
    const res = await page.goto(`http://127.0.0.1:${proxyPort}/`);
    expect(res?.status()).toBe(401);
  });

  test('shows backend content with valid token in query string', async ({
    page,
  }) => {
    await page.goto(
      `http://127.0.0.1:${proxyPort}/?token=testsecret`
    );
    await expect(page.locator('h1')).toContainText('Protected content');
  });
});

// ---------------------------------------------------------------------------
// Tests — multi-instance path-prefix routing
// ---------------------------------------------------------------------------

test.describe('Multi-instance path-prefix routing', () => {
  let backend1: MockBackend;
  let backend2: MockBackend;
  let tunnel: TunnelServer;
  let proxyPort: number;

  test.beforeAll(async () => {
    backend1 = await startMockBackend('Instance One');
    backend2 = await startMockBackend('Instance Two');

    const config = mergeConfig({
      host: '127.0.0.1',
      port: 0,
      auth: false,
      backends: [
        {
          type: 'vscode',
          host: '127.0.0.1',
          port: backend1.port,
          tls: false,
          tokenSource: 'none',
          pathPrefix: '/instance/1',
        },
        {
          type: 'vscode',
          host: '127.0.0.1',
          port: backend2.port,
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
    await backend1.close();
    await backend2.close();
  });

  test('routes /instance/1 to the first backend', async ({ page }) => {
    await page.goto(`http://127.0.0.1:${proxyPort}/instance/1`);
    await expect(page.locator('h1')).toContainText('Instance One');
  });

  test('routes /instance/2 to the second backend', async ({ page }) => {
    await page.goto(`http://127.0.0.1:${proxyPort}/instance/2`);
    await expect(page.locator('h1')).toContainText('Instance Two');
  });

  test('instances have independent content (no cross-routing)', async ({
    page,
  }) => {
    await page.goto(`http://127.0.0.1:${proxyPort}/instance/1`);
    await expect(page.locator('h1')).not.toContainText('Instance Two');

    await page.goto(`http://127.0.0.1:${proxyPort}/instance/2`);
    await expect(page.locator('h1')).not.toContainText('Instance One');
  });

  test('both instances are accessible on the same browser page via iframes', async ({
    page,
  }) => {
    // Serve a container page that embeds both instances as iframes.  We
    // serve the HTML directly from a data: URL to avoid needing an extra
    // HTTP server.
    const containerHtml = `
      <!DOCTYPE html><html><body>
        <iframe id="f1" src="http://127.0.0.1:${proxyPort}/instance/1" width="800" height="400"></iframe>
        <iframe id="f2" src="http://127.0.0.1:${proxyPort}/instance/2" width="800" height="400"></iframe>
      </body></html>
    `;

    await page.setContent(containerHtml, { waitUntil: 'load' });

    // Both iframes should be present in the DOM.
    const frames = page.frames();
    expect(frames.length).toBeGreaterThanOrEqual(3); // main + 2 iframes

    // Verify each iframe loaded the correct backend.
    const frame1 = page.frameLocator('#f1');
    await expect(frame1.locator('h1')).toContainText('Instance One');

    const frame2 = page.frameLocator('#f2');
    await expect(frame2.locator('h1')).toContainText('Instance Two');
  });
});

// ---------------------------------------------------------------------------
// Tests — session error display
// ---------------------------------------------------------------------------

test.describe('Session error display', () => {
  let backend: MockBackend;
  let tunnel: TunnelServer;
  let proxyPort: number;

  test.beforeAll(async () => {
    backend = await startMockBackend('Healthy backend');
    const sessionMgr = new SessionManager();

    // Register a session in 'error' state to verify the UI surfaces the error.
    const cfg = buildBackendConfig({
      type: 'vscode',
      host: '127.0.0.1',
      port: backend.port,
      tls: false,
      tokenSource: 'none',
    });
    const s = sessionMgr.register(cfg);
    s.status = 'error';
    s.errorMessage = 'Port 8000 is already in use by session s1.';

    const config = mergeConfig({
      host: '127.0.0.1',
      port: 0,
      auth: false,
      backends: [],
    });
    const localTunnel = createTunnelServer(config, sessionMgr);
    await new Promise<void>((resolve, reject) => {
      localTunnel.httpServer.once('error', reject);
      localTunnel.httpServer.listen(0, '127.0.0.1', () => {
        localTunnel.httpServer.off('error', reject);
        resolve();
      });
    });
    const { port } = localTunnel.httpServer.address() as { port: number };
    tunnel = localTunnel;
    proxyPort = port;
  });

  test.afterAll(async () => {
    await tunnel.close();
    await backend.close();
  });

  test('session-error-banner is initially hidden', async ({ page }) => {
    await page.goto(`http://127.0.0.1:${proxyPort}/`, { waitUntil: 'networkidle' });
    const banner = page.locator('#session-error-banner');
    await expect(banner).toBeAttached();
    // No session selected yet — banner should not be visible.
    await expect(banner).toBeHidden();
  });

  test('clicking an errored session shows the error banner with message', async ({ page }) => {
    await page.goto(`http://127.0.0.1:${proxyPort}/`, { waitUntil: 'networkidle' });
    // Click the errored session item.
    await page.locator('.session-item').first().click();
    // Banner should now be visible and contain the error message.
    const banner = page.locator('#session-error-banner');
    await expect(banner).toBeVisible({ timeout: 3_000 });
    await expect(banner).toContainText('Port 8000 is already in use');
  });

  test('errored session item shows a truncated error line', async ({ page }) => {
    await page.goto(`http://127.0.0.1:${proxyPort}/`, { waitUntil: 'networkidle' });
    // The session item should contain the ⚠ error line.
    await expect(page.locator('.session-item-error').first()).toBeAttached();
  });
});

// ---------------------------------------------------------------------------
// Tests — multi-session iframe switching (visibility:hidden, not display:none)
// ---------------------------------------------------------------------------

test.describe('Multi-session iframe switching', () => {
  let backend1: MockBackend;
  let backend2: MockBackend;
  let tunnel: TunnelServer;
  let proxyPort: number;
  let sessionMgr: SessionManager;

  test.beforeAll(async () => {
    backend1 = await startMockBackend('Session A Content');
    backend2 = await startMockBackend('Session B Content');
    sessionMgr = new SessionManager();

    const cfgA = buildBackendConfig({
      type: 'vscode',
      host: '127.0.0.1',
      port: backend1.port,
      tls: false,
      tokenSource: 'none',
    });
    const cfgB = buildBackendConfig({
      type: 'vscode',
      host: '127.0.0.1',
      port: backend2.port,
      tls: false,
      tokenSource: 'none',
    });
    const sA = sessionMgr.register(cfgA);
    sA.status = 'running';
    const sB = sessionMgr.register(cfgB);
    sB.status = 'running';

    const config = mergeConfig({
      host: '127.0.0.1',
      port: 0,
      auth: false,
      backends: [],
    });
    const localTunnel = createTunnelServer(config, sessionMgr);
    await new Promise<void>((resolve, reject) => {
      localTunnel.httpServer.once('error', reject);
      localTunnel.httpServer.listen(0, '127.0.0.1', () => {
        localTunnel.httpServer.off('error', reject);
        resolve();
      });
    });
    const { port } = localTunnel.httpServer.address() as { port: number };
    tunnel = localTunnel;
    proxyPort = port;
  });

  test.afterAll(async () => {
    await tunnel.close();
    await backend1.close();
    await backend2.close();
  });

  test('clicking first session shows its iframe (visible)', async ({ page }) => {
    await page.goto(`http://127.0.0.1:${proxyPort}/`, { waitUntil: 'networkidle' });
    await page.locator('.session-item').nth(0).click();
    // iframe for session A must exist and be visible.
    const iframe = page.locator('iframe[id^="session-frame-"]').first();
    await expect(iframe).toBeAttached({ timeout: 5_000 });
    await expect(iframe).toBeVisible({ timeout: 5_000 });
  });

  test('switching to second session hides first iframe with visibility:hidden (not display:none)', async ({ page }) => {
    await page.goto(`http://127.0.0.1:${proxyPort}/`, { waitUntil: 'networkidle' });

    // Select session A to create its iframe.
    await page.locator('.session-item').nth(0).click();
    await page.locator('iframe[id^="session-frame-"]').first().waitFor({ state: 'attached', timeout: 5_000 });

    // Switch to session B and wait until its iframe is also in the DOM.
    await page.locator('.session-item').nth(1).click();
    const iframes = page.locator('iframe[id^="session-frame-"]');
    await expect(iframes).toHaveCount(2, { timeout: 5_000 });

    // The first iframe (session A) must be hidden via visibility:hidden,
    // NOT removed from the DOM (so VS Code stays connected).
    const firstIframe = iframes.first();
    await expect(firstIframe).toBeAttached();
    // visibility:hidden means the element is in the DOM but not visible.
    const isVisible = await firstIframe.isVisible();
    expect(isVisible).toBe(false);

    // Confirm the first iframe is NOT hidden with display:none
    // (display:none would also make isVisible() false, but we verify the
    // CSS property to ensure we're using the correct hiding mechanism).
    const visibility = await firstIframe.evaluate(
      (el) => window.getComputedStyle(el).visibility
    );
    expect(visibility).toBe('hidden');
  });

  test('switching back to first session restores its iframe (visible)', async ({ page }) => {
    await page.goto(`http://127.0.0.1:${proxyPort}/`, { waitUntil: 'networkidle' });

    // Select A to create its iframe, then switch to B (creates B's iframe).
    await page.locator('.session-item').nth(0).click();
    await page.locator('iframe[id^="session-frame-"]').first().waitFor({ state: 'attached', timeout: 5_000 });
    await page.locator('.session-item').nth(1).click();
    // Wait for B's iframe to exist before switching back.
    await expect(page.locator('iframe[id^="session-frame-"]')).toHaveCount(2, { timeout: 5_000 });

    // Switch back to A — its iframe should become visible again.
    await page.locator('.session-item').nth(0).click();
    // The first iframe should be visible again.
    const firstIframe = page.locator('iframe[id^="session-frame-"]').first();
    await expect(firstIframe).toBeVisible({ timeout: 3_000 });
  });
});

// ---------------------------------------------------------------------------
// Tests — dashboard screenshots
// ---------------------------------------------------------------------------

test.describe('Dashboard screenshots', () => {
  let tunnel: TunnelServer;
  let proxyPort: number;

  test.beforeAll(async () => {
    const sessionMgr = new SessionManager();
    // Register a session so the sidebar is populated.
    sessionMgr.register(buildBackendConfig({
      type: 'vscode',
      host: '127.0.0.1',
      port: 8000,
      tls: false,
      tokenSource: 'none',
    }));

    const config = mergeConfig({
      host: '127.0.0.1',
      port: 0,
      auth: false,
      backends: [],
    });

    const localTunnel = createTunnelServer(config, sessionMgr);
    await new Promise<void>((resolve, reject) => {
      localTunnel.httpServer.once('error', reject);
      localTunnel.httpServer.listen(0, '127.0.0.1', () => {
        localTunnel.httpServer.off('error', reject);
        resolve();
      });
    });
    const { port } = localTunnel.httpServer.address() as { port: number };
    tunnel = localTunnel;
    proxyPort = port;
  });

  test.afterAll(async () => {
    await tunnel.close();
  });

  /** Shared helper: ensure the test-results dir exists and return its path. */
  function screenshotDir(): string {
    const dir = path.join(__dirname, '..', 'test-results');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  test('screenshot: session dashboard sidebar', async ({ page }) => {
    await page.goto(`http://127.0.0.1:${proxyPort}/`);
    await expect(page.locator('#session-list')).toBeAttached();
    await page.screenshot({
      path: path.join(screenshotDir(), 'dashboard-sidebar.png'),
      fullPage: false,
    });
  });

  test('screenshot: new session dialog', async ({ page }) => {
    const jsErrors: string[] = [];
    page.on('pageerror', (err) => jsErrors.push(err.message));
    await page.goto(`http://127.0.0.1:${proxyPort}/`, { waitUntil: 'networkidle' });
    await expect(page.locator('#sidebar-header')).toBeVisible();
    // Ensure JS errors haven't occurred before clicking.
    expect(jsErrors).toEqual([]);
    await page.locator('#btn-new-session').click();
    // The modal backdrop removes the 'hidden' class when the button is clicked.
    await page.waitForFunction(() => {
      const el = document.getElementById('modal-backdrop');
      return el && !el.classList.contains('hidden');
    }, { timeout: 5000 });
    await page.screenshot({
      path: path.join(screenshotDir(), 'dashboard-new-session-dialog.png'),
      fullPage: false,
    });
  });
});
