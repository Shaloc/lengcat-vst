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
      backends: [{ type: 'vscodium', host: '127.0.0.1', port: echoPort, tls: false, tokenSource: 'none' }],
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
      backends: [{ type: 'vscodium', host: '127.0.0.1', port: echoPort, tls: false, tokenSource: 'none' }],
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
      backends: [{ type: 'vscodium', host: '127.0.0.1', port: 19999, tls: false, tokenSource: 'none' }],
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
