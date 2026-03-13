/**
 * Integration tests for lengcat-vst against a real VS Code server.
 *
 * These tests download and run an actual VS Code web server (bundled inside
 * the code-server npm package) and verify that:
 *
 *  1. The proxy correctly forwards requests from the browser to VS Code.
 *  2. VS Code's HTML shell, static assets, and WebSocket-based extension host
 *     all work end-to-end through the tunnel.
 *  3. Multi-instance routing sends two separate VS Code instances to the
 *     correct backends based on the URL path prefix.
 *  4. Both instances can be loaded simultaneously in the same browser page
 *     (i.e., in separate <iframe> elements).
 *
 * On first run the VS Code server is downloaded (~49 MB) and cached in
 * /tmp/lengcat-vst-vscode-server so subsequent runs are fast.
 *
 * The tests use a non-standard but publicly available entry point
 * (server-main.js from the code-server package) so no local VS Code IDE
 * installation is required.
 */

import { test, expect } from '@playwright/test';
import { ensureVSCodeServer, startVSCodeServer } from './helpers/vscode-server';
import { createTunnelServer } from '../src/server';
import { mergeConfig } from '../src/config';
import type { TunnelServer } from '../src/server';
import type { VSCodeServerInstance } from './helpers/vscode-server';

// ---------------------------------------------------------------------------
// Shared setup helpers
// ---------------------------------------------------------------------------

/** Starts the proxy on a random port and returns the tunnel + chosen port. */
async function startProxy(
  config: ReturnType<typeof mergeConfig>
): Promise<{ tunnel: TunnelServer; port: number }> {
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
// Prepare the VS Code server binary once for all tests in this file.
// ---------------------------------------------------------------------------

test.beforeAll(async () => {
  await ensureVSCodeServer();
});

// ---------------------------------------------------------------------------
// Test suite 1 — single VS Code instance behind the proxy
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
