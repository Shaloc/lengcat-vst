/**
 * Integration tests for the TunnelServer.
 *
 * These tests spin up a real HTTP backend and proxy server to verify that:
 *  - HTTP requests are forwarded to the backend.
 *  - Authentication middleware works end-to-end.
 *  - The proxy returns 502 when the backend is unreachable.
 *  - Multi-instance path-prefix routing forwards to the correct backend.
 */

import * as http from 'http';
import { createTunnelServer, selectBackend } from '../src/server';
import { mergeConfig, buildBackendConfig } from '../src/config';

/** Makes a simple HTTP GET request and returns status + body. */
function httpGet(
  url: string,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options: http.RequestOptions = {
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers,
    };
    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', (chunk: Buffer) => (body += chunk.toString()));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

/** Starts a simple HTTP server that echoes back a fixed response. */
function startEchoServer(responseBody: string): Promise<{ server: http.Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(responseBody);
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({ server, port: addr.port });
    });
    server.once('error', reject);
  });
}

describe('TunnelServer (HTTP proxying)', () => {
  it('throws when no backends are configured', () => {
    const config = mergeConfig({ backends: [] });
    expect(() => createTunnelServer(config)).toThrow(
      'At least one backend must be configured.'
    );
  });

  it('forwards HTTP requests to the backend', async () => {
    const { server: echo, port: echoPort } = await startEchoServer('hello from backend');

    const config = mergeConfig({
      host: '127.0.0.1',
      port: 0, // let OS pick a free port
      auth: false,
      backends: [{ type: 'vscode', host: '127.0.0.1', port: echoPort, tls: false, tokenSource: 'none' }],
    });

    // Override listen to use a dynamic port
    const tunnelServer = createTunnelServer(config);
    await new Promise<void>((resolve, reject) => {
      tunnelServer.httpServer.once('error', reject);
      tunnelServer.httpServer.listen(0, '127.0.0.1', () => {
        tunnelServer.httpServer.off('error', reject);
        resolve();
      });
    });

    const addr = tunnelServer.httpServer.address() as { port: number };
    const result = await httpGet(`http://127.0.0.1:${addr.port}/`);

    expect(result.status).toBe(200);
    expect(result.body).toContain('hello from backend');

    await tunnelServer.close();
    await new Promise<void>((resolve) => echo.close(() => resolve()));
  });

  it('returns 401 when auth is enabled and no token is provided', async () => {
    const { server: echo, port: echoPort } = await startEchoServer('should not reach this');

    const config = mergeConfig({
      host: '127.0.0.1',
      port: 0,
      auth: true,
      proxySecret: 'supersecret',
      backends: [{ type: 'vscode', host: '127.0.0.1', port: echoPort, tls: false, tokenSource: 'none' }],
    });

    const tunnelServer = createTunnelServer(config);
    await new Promise<void>((resolve, reject) => {
      tunnelServer.httpServer.once('error', reject);
      tunnelServer.httpServer.listen(0, '127.0.0.1', () => {
        tunnelServer.httpServer.off('error', reject);
        resolve();
      });
    });

    const addr = tunnelServer.httpServer.address() as { port: number };

    const noTokenResult = await httpGet(`http://127.0.0.1:${addr.port}/`);
    expect(noTokenResult.status).toBe(401);

    const wrongTokenResult = await httpGet(`http://127.0.0.1:${addr.port}/`, {
      Authorization: 'Bearer wrongsecret',
    });
    expect(wrongTokenResult.status).toBe(401);

    const correctResult = await httpGet(`http://127.0.0.1:${addr.port}/`, {
      Authorization: 'Bearer supersecret',
    });
    expect(correctResult.status).toBe(200);
    expect(correctResult.body).toContain('should not reach this');

    await tunnelServer.close();
    await new Promise<void>((resolve) => echo.close(() => resolve()));
  });

  it('returns 502 when backend is unreachable', async () => {
    const config = mergeConfig({
      host: '127.0.0.1',
      port: 0,
      auth: false,
      // Use a port that (hopefully) nothing is listening on
      backends: [{ type: 'vscode', host: '127.0.0.1', port: 19999, tls: false, tokenSource: 'none' }],
    });

    const tunnelServer = createTunnelServer(config);
    await new Promise<void>((resolve, reject) => {
      tunnelServer.httpServer.once('error', reject);
      tunnelServer.httpServer.listen(0, '127.0.0.1', () => {
        tunnelServer.httpServer.off('error', reject);
        resolve();
      });
    });

    const addr = tunnelServer.httpServer.address() as { port: number };
    const result = await httpGet(`http://127.0.0.1:${addr.port}/`);

    expect(result.status).toBe(502);

    await tunnelServer.close();
  });
});

// ---------------------------------------------------------------------------
// selectBackend — unit tests for path-prefix routing logic
// ---------------------------------------------------------------------------

describe('selectBackend', () => {
  const b1 = buildBackendConfig({ type: 'vscode', port: 8001 });
  const b2 = buildBackendConfig({ type: 'vscode', port: 8002, pathPrefix: '/instance/1' });
  const b3 = buildBackendConfig({ type: 'vscode', port: 8003, pathPrefix: '/instance/2' });

  it('returns the first backend when no pathPrefix is set', () => {
    expect(selectBackend('/', [b1])).toBe(b1);
    expect(selectBackend('/any/path', [b1])).toBe(b1);
  });

  it('selects backend by exact prefix match', () => {
    expect(selectBackend('/instance/1', [b1, b2, b3])).toBe(b2);
    expect(selectBackend('/instance/2', [b1, b2, b3])).toBe(b3);
  });

  it('selects backend by prefix + slash', () => {
    expect(selectBackend('/instance/1/', [b1, b2, b3])).toBe(b2);
    expect(selectBackend('/instance/1/some/file.js', [b1, b2, b3])).toBe(b2);
  });

  it('selects backend by prefix + query string', () => {
    expect(selectBackend('/instance/2?token=x', [b1, b2, b3])).toBe(b3);
  });

  it('falls back to the first backend when no prefix matches', () => {
    expect(selectBackend('/unknown/path', [b1, b2, b3])).toBe(b1);
    expect(selectBackend('/', [b1, b2, b3])).toBe(b1);
  });
});

// ---------------------------------------------------------------------------
// Multi-instance HTTP routing — end-to-end
// ---------------------------------------------------------------------------

describe('TunnelServer (multi-instance path-prefix routing)', () => {
  it('routes requests to different backends based on path prefix', async () => {
    const { server: echo1, port: port1 } = await startEchoServer('backend-one');
    const { server: echo2, port: port2 } = await startEchoServer('backend-two');

    const config = mergeConfig({
      host: '127.0.0.1',
      port: 0,
      auth: false,
      backends: [
        { type: 'vscode', host: '127.0.0.1', port: port1, tls: false, tokenSource: 'none', pathPrefix: '/instance/1' },
        { type: 'vscode', host: '127.0.0.1', port: port2, tls: false, tokenSource: 'none', pathPrefix: '/instance/2' },
      ],
    });

    const tunnelServer = createTunnelServer(config);
    await new Promise<void>((resolve, reject) => {
      tunnelServer.httpServer.once('error', reject);
      tunnelServer.httpServer.listen(0, '127.0.0.1', () => {
        tunnelServer.httpServer.off('error', reject);
        resolve();
      });
    });

    const addr = tunnelServer.httpServer.address() as { port: number };

    const r1 = await httpGet(`http://127.0.0.1:${addr.port}/instance/1/`);
    expect(r1.status).toBe(200);
    expect(r1.body).toContain('backend-one');

    const r2 = await httpGet(`http://127.0.0.1:${addr.port}/instance/2/`);
    expect(r2.status).toBe(200);
    expect(r2.body).toContain('backend-two');

    // Requests to /instance/1 must NOT reach backend-two.
    expect(r1.body).not.toContain('backend-two');
    expect(r2.body).not.toContain('backend-one');

    await tunnelServer.close();
    await new Promise<void>((resolve) => echo1.close(() => resolve()));
    await new Promise<void>((resolve) => echo2.close(() => resolve()));
  });

  it('falls back to the first backend when no prefix matches', async () => {
    const { server: echo1, port: port1 } = await startEchoServer('default-backend');
    const { server: echo2, port: port2 } = await startEchoServer('prefixed-backend');

    const config = mergeConfig({
      host: '127.0.0.1',
      port: 0,
      auth: false,
      backends: [
        // First backend has no prefix → acts as default.
        { type: 'vscode', host: '127.0.0.1', port: port1, tls: false, tokenSource: 'none' },
        { type: 'vscode', host: '127.0.0.1', port: port2, tls: false, tokenSource: 'none', pathPrefix: '/special' },
      ],
    });

    const tunnelServer = createTunnelServer(config);
    await new Promise<void>((resolve, reject) => {
      tunnelServer.httpServer.once('error', reject);
      tunnelServer.httpServer.listen(0, '127.0.0.1', () => {
        tunnelServer.httpServer.off('error', reject);
        resolve();
      });
    });

    const addr = tunnelServer.httpServer.address() as { port: number };

    const fallback = await httpGet(`http://127.0.0.1:${addr.port}/`);
    expect(fallback.body).toContain('default-backend');

    const prefixed = await httpGet(`http://127.0.0.1:${addr.port}/special/`);
    expect(prefixed.body).toContain('prefixed-backend');

    await tunnelServer.close();
    await new Promise<void>((resolve) => echo1.close(() => resolve()));
    await new Promise<void>((resolve) => echo2.close(() => resolve()));
  });
});

// ---------------------------------------------------------------------------
// Session Manager dashboard and REST API (/api/* (and / for dashboard))
// ---------------------------------------------------------------------------

import { SessionManager, _resetCounter } from '../src/session';

/** Makes an HTTP request and returns status + body. */
function httpRequest(
  method: string,
  url: string,
  body?: string,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const reqHeaders: Record<string, string> = { ...headers };
    if (body !== undefined) reqHeaders['Content-Type'] = 'application/json';

    const options: http.RequestOptions = {
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method,
      headers: reqHeaders,
    };
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => (data += chunk.toString()));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** Creates a TunnelServer backed by a SessionManager on a random port. */
async function startUiServer(sessions?: SessionManager): Promise<{ tunnel: ReturnType<typeof createTunnelServer>; port: number; mgr: SessionManager }> {
  const mgr = sessions ?? new SessionManager();
  const config = mergeConfig({ host: '127.0.0.1', port: 0, auth: false, backends: [{ type: 'vscode' as const, port: 8000 }] });
  const tunnel = createTunnelServer(config, mgr);
  await new Promise<void>((resolve, reject) => {
    tunnel.httpServer.once('error', reject);
    tunnel.httpServer.listen(0, '127.0.0.1', () => { tunnel.httpServer.off('error', reject); resolve(); });
  });
  const addr = tunnel.httpServer.address() as { port: number };
  return { tunnel, port: addr.port, mgr };
}

describe('TunnelServer (/ dashboard and /api/* API)', () => {
  beforeEach(() => { _resetCounter(); });

  it('serves the HTML dashboard at GET /', async () => {
    const { tunnel, port } = await startUiServer();
    const r = await httpGet(`http://127.0.0.1:${port}/`);
    expect(r.status).toBe(200);
    expect(r.body).toContain('lengcat-vst');
    expect(r.body).toContain('session-list');
    await tunnel.close();
  });

  it('backward-compat: /_ui alias also serves the dashboard', async () => {
    const { tunnel, port } = await startUiServer();
    const r = await httpGet(`http://127.0.0.1:${port}/_ui`);
    expect(r.status).toBe(200);
    expect(r.body).toContain('<!DOCTYPE html>');
    await tunnel.close();
  });

  it('GET /api/sessions returns an empty array initially', async () => {
    const { tunnel, port } = await startUiServer();
    const r = await httpGet(`http://127.0.0.1:${port}/api/sessions`);
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toEqual([]);
    await tunnel.close();
  });

  it('GET /api/sessions returns pre-registered sessions', async () => {
    const mgr = new SessionManager();
    mgr.register(buildBackendConfig({ type: 'vscode', port: 8000 }));
    const { tunnel, port } = await startUiServer(mgr);
    const r = await httpGet(`http://127.0.0.1:${port}/api/sessions`);
    const sessions = JSON.parse(r.body) as { id: string; type: string; status: string }[];
    expect(sessions).toHaveLength(1);
    expect(sessions[0].type).toBe('vscode');
    expect(sessions[0].status).toBe('stopped');
    await tunnel.close();
  });

  it('POST /api/sessions creates a new session (launch=false)', async () => {
    const { tunnel, port, mgr } = await startUiServer();
    const r = await httpRequest('POST', `http://127.0.0.1:${port}/api/sessions`,
      JSON.stringify({ type: 'vscode', port: 9001, launch: false }));
    expect(r.status).toBe(201);
    const session = JSON.parse(r.body) as { id: string; status: string; type: string };
    expect(session.type).toBe('vscode');
    expect(session.status).toBe('stopped');
    expect(mgr.list()).toHaveLength(1);
    await tunnel.close();
  });

  it('POST /api/sessions with invalid JSON returns 400', async () => {
    const { tunnel, port } = await startUiServer();
    const r = await httpRequest('POST', `http://127.0.0.1:${port}/api/sessions`, 'not-json');
    expect(r.status).toBe(400);
    await tunnel.close();
  });

  it('DELETE /api/sessions/:id removes the session', async () => {
    const mgr = new SessionManager();
    const s = mgr.register(buildBackendConfig({ type: 'vscode', port: 8000 }));
    const { tunnel, port } = await startUiServer(mgr);
    const r = await httpRequest('DELETE', `http://127.0.0.1:${port}/api/sessions/${s.id}`);
    expect(r.status).toBe(204);
    expect(mgr.list()).toHaveLength(0);
    await tunnel.close();
  });

  it('DELETE /api/sessions/:id with unknown id returns 404', async () => {
    const { tunnel, port } = await startUiServer();
    const r = await httpRequest('DELETE', `http://127.0.0.1:${port}/api/sessions/ghost`);
    expect(r.status).toBe(404);
    await tunnel.close();
  });

  it('POST /api/sessions/:id/stop returns 404 for unknown session', async () => {
    const { tunnel, port } = await startUiServer();
    const r = await httpRequest('POST', `http://127.0.0.1:${port}/api/sessions/ghost/stop`);
    expect(r.status).toBe(404);
    await tunnel.close();
  });

  it('POST /api/sessions/:id/launch returns 404 for unknown session', async () => {
    const { tunnel, port } = await startUiServer();
    const r = await httpRequest('POST', `http://127.0.0.1:${port}/api/sessions/ghost/launch`);
    expect(r.status).toBe(404);
    await tunnel.close();
  });

  it('returns 503 for session paths when no sessions are running', async () => {
    const mgr = new SessionManager();
    // Register a session but don't launch it → status stays 'stopped'
    const s = mgr.register(buildBackendConfig({ type: 'vscode', port: 8000 }));
    const { tunnel, port } = await startUiServer(mgr);
    // The root '/' now serves the dashboard; a session-prefix path returns 503.
    const dashboardRes = await httpGet(`http://127.0.0.1:${port}/`);
    expect(dashboardRes.status).toBe(200);
    const sessionRes = await httpGet(`http://127.0.0.1:${port}${s.pathPrefix}/`);
    expect(sessionRes.status).toBe(503);
    await tunnel.close();
  });

  it('unknown /api path returns 404', async () => {
    const { tunnel, port } = await startUiServer();
    const r = await httpGet(`http://127.0.0.1:${port}/api/unknown`);
    expect(r.status).toBe(404);
    await tunnel.close();
  });

  it('GET /api/tls/cert returns 404 when server has no TLS credentials', async () => {
    const { tunnel, port } = await startUiServer();
    const r = await httpGet(`http://127.0.0.1:${port}/api/tls/cert`);
    expect(r.status).toBe(404);
    const body = JSON.parse(r.body) as { error: string };
    expect(body.error).toMatch(/No TLS certificate/i);
    await tunnel.close();
  });

  it('GET /api/tls/cert returns the PEM certificate when TLS is configured', async () => {
    const mgr = new SessionManager();
    const config = mergeConfig({ host: '127.0.0.1', port: 0, auth: false, backends: [{ type: 'vscode' as const, port: 8000 }] });
    const { loadOrGenerateTls } = await import('../src/tls');
    const tlsCreds = await loadOrGenerateTls();
    const tunnel = createTunnelServer(config, mgr, tlsCreds);
    await new Promise<void>((resolve, reject) => {
      tunnel.httpServer.once('error', reject);
      tunnel.httpServer.listen(0, '127.0.0.1', () => { tunnel.httpServer.off('error', reject); resolve(); });
    });
    const addr = tunnel.httpServer.address() as { port: number };

    // Make an HTTPS request with the self-signed cert as the trusted CA,
    // validating the TLS connection before checking the certificate endpoint.
    const status = await new Promise<number>((resolve, reject) => {
      const req = https.request(
        { hostname: '127.0.0.1', port: addr.port, path: '/api/tls/cert', ca: tlsCreds.cert },
        (res) => { res.resume(); resolve(res.statusCode ?? 0); }
      );
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(200);
    await tunnel.close();
  });

  it('POST /api/sessions persists folder and extensionHostOnly', async () => {
    const { tunnel, port } = await startUiServer();
    const r = await httpRequest(
      'POST',
      `http://127.0.0.1:${port}/api/sessions`,
      JSON.stringify({ type: 'vscode', port: 9002, launch: false, folder: '/home/user/proj', extensionHostOnly: true })
    );
    expect(r.status).toBe(201);
    const s = JSON.parse(r.body) as { folder?: string; extensionHostOnly?: boolean };
    expect(s.folder).toBe('/home/user/proj');
    expect(s.extensionHostOnly).toBe(true);
    await tunnel.close();
  });

  it('POST /api/sessions/:id/launch with folder body overrides session folder', async () => {
    const mgr = new SessionManager();
    mgr.register(buildBackendConfig({ type: 'vscode', port: 8000 }));
    const s = mgr.list()[0];
    const { tunnel, port } = await startUiServer(mgr);
    // Launch should fail (no real process) but the folder should be recorded.
    await httpRequest(
      'POST',
      `http://127.0.0.1:${port}/api/sessions/${s.id}/launch`,
      JSON.stringify({ folder: '/my/folder' })
    );
    // Regardless of launch success, the session folder should be set.
    expect(mgr.get(s.id)?.folder).toBe('/my/folder');
    await tunnel.close();
  });
});

// ---------------------------------------------------------------------------
// HTTPS server — createTunnelServer with TLS credentials
// ---------------------------------------------------------------------------

import * as https from 'https';

describe('TunnelServer (HTTPS)', () => {
  it('createTunnelServer with TLS credentials returns isHttps=true', async () => {
    const { server: echo, port: echoPort } = await startEchoServer('secure');

    const config = mergeConfig({
      host: '127.0.0.1',
      port: 0,
      auth: false,
      backends: [{ type: 'vscode', host: '127.0.0.1', port: echoPort, tls: false, tokenSource: 'none' }],
    });

    // Lazy-load the TLS generation only for this test (avoids slowing others).
    const { loadOrGenerateTls } = await import('../src/tls');
    const tlsCreds = await loadOrGenerateTls();

    const tunnelServer = createTunnelServer(config, undefined, tlsCreds);
    expect(tunnelServer.isHttps).toBe(true);
    expect(tunnelServer.httpServer).toBeInstanceOf(https.Server);

    await new Promise<void>((resolve, reject) => {
      tunnelServer.httpServer.once('error', reject);
      tunnelServer.httpServer.listen(0, '127.0.0.1', () => {
        tunnelServer.httpServer.off('error', reject);
        resolve();
      });
    });

    const addr = tunnelServer.httpServer.address() as { port: number };

    // Make an HTTPS request using the self-signed cert as the trusted CA.
    // This validates the certificate rather than skipping verification.
    const status = await new Promise<number>((resolve, reject) => {
      const req = https.request(
        { hostname: '127.0.0.1', port: addr.port, path: '/', ca: tlsCreds.cert },
        (res) => { res.resume(); resolve(res.statusCode ?? 0); }
      );
      req.on('error', reject);
      req.end();
    });

    // The proxy should forward to the echo backend → 200.
    expect(status).toBe(200);

    await tunnelServer.close();
    await new Promise<void>((resolve) => echo.close(() => resolve()));
  });

  it('createTunnelServer without TLS returns isHttps=false', () => {
    const config = mergeConfig({
      host: '127.0.0.1', port: 0, auth: false,
      backends: [{ type: 'vscode', host: '127.0.0.1', port: 8000, tls: false, tokenSource: 'none' }],
    });
    const tunnel = createTunnelServer(config);
    expect(tunnel.isHttps).toBe(false);
    expect(tunnel.httpServer).toBeInstanceOf(http.Server);
  });
});

// ---------------------------------------------------------------------------
// Proxy header fixups — X-Frame-Options and CSP
// ---------------------------------------------------------------------------

describe('TunnelServer (proxy header fixups)', () => {
  /** Starts a server that sends back the given response headers. */
  function startHeaderEchoServer(
    responseHeaders: Record<string, string>
  ): Promise<{ server: http.Server; port: number }> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/plain', ...responseHeaders });
        res.end('ok');
      });
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as { port: number };
        resolve({ server, port: addr.port });
      });
      server.once('error', reject);
    });
  }

  /** Makes an HTTP GET and returns the status + selected response headers. */
  function httpGetHeaders(
    url: string
  ): Promise<{ status: number; headers: Record<string, string | string[]> }> {
    return new Promise((resolve, reject) => {
      const parsed = new URL(url);
      const req = http.request(
        { hostname: parsed.hostname, port: parsed.port, path: parsed.pathname },
        (res) => {
          res.resume();
          resolve({ status: res.statusCode ?? 0, headers: res.headers as Record<string, string> });
        }
      );
      req.on('error', reject);
      req.end();
    });
  }

  it('strips X-Frame-Options from proxied responses', async () => {
    const { server: backend, port: backendPort } = await startHeaderEchoServer({
      'x-frame-options': 'DENY',
    });

    const config = mergeConfig({
      host: '127.0.0.1', port: 0, auth: false,
      backends: [{ type: 'vscode', host: '127.0.0.1', port: backendPort, tls: false, tokenSource: 'none' }],
    });

    const tunnel = createTunnelServer(config);
    await new Promise<void>((resolve, reject) => {
      tunnel.httpServer.once('error', reject);
      tunnel.httpServer.listen(0, '127.0.0.1', () => { tunnel.httpServer.off('error', reject); resolve(); });
    });
    const { port } = tunnel.httpServer.address() as { port: number };

    const { headers } = await httpGetHeaders(`http://127.0.0.1:${port}/`);
    expect(headers['x-frame-options']).toBeUndefined();

    await tunnel.close();
    await new Promise<void>((resolve) => backend.close(() => resolve()));
  });

  it('removes frame-ancestors from Content-Security-Policy', async () => {
    const { server: backend, port: backendPort } = await startHeaderEchoServer({
      'content-security-policy': "default-src 'self'; frame-ancestors 'none'; script-src 'self'",
    });

    const config = mergeConfig({
      host: '127.0.0.1', port: 0, auth: false,
      backends: [{ type: 'vscode', host: '127.0.0.1', port: backendPort, tls: false, tokenSource: 'none' }],
    });

    const tunnel = createTunnelServer(config);
    await new Promise<void>((resolve, reject) => {
      tunnel.httpServer.once('error', reject);
      tunnel.httpServer.listen(0, '127.0.0.1', () => { tunnel.httpServer.off('error', reject); resolve(); });
    });
    const { port } = tunnel.httpServer.address() as { port: number };

    const { headers } = await httpGetHeaders(`http://127.0.0.1:${port}/`);
    const csp = headers['content-security-policy'] as string | undefined;
    // frame-ancestors must be gone.
    expect(csp).not.toMatch(/frame-ancestors/i);
    // Other directives must survive.
    expect(csp).toMatch(/default-src/);
    expect(csp).toMatch(/script-src/);

    await tunnel.close();
    await new Promise<void>((resolve) => backend.close(() => resolve()));
  });

  it('adds Service-Worker-Allowed: / to proxied responses', async () => {
    const { server: backend, port: backendPort } = await startHeaderEchoServer({});

    const config = mergeConfig({
      host: '127.0.0.1', port: 0, auth: false,
      backends: [{ type: 'vscode', host: '127.0.0.1', port: backendPort, tls: false, tokenSource: 'none' }],
    });

    const tunnel = createTunnelServer(config);
    await new Promise<void>((resolve, reject) => {
      tunnel.httpServer.once('error', reject);
      tunnel.httpServer.listen(0, '127.0.0.1', () => { tunnel.httpServer.off('error', reject); resolve(); });
    });
    const { port } = tunnel.httpServer.address() as { port: number };

    const { headers } = await httpGetHeaders(`http://127.0.0.1:${port}/`);
    expect(headers['service-worker-allowed']).toBe('/');

    await tunnel.close();
    await new Promise<void>((resolve) => backend.close(() => resolve()));
  });
});
