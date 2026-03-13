/**
 * Integration tests for the TunnelServer.
 *
 * These tests spin up a real HTTP backend and proxy server to verify that:
 *  - HTTP requests are forwarded to the backend.
 *  - Authentication middleware works end-to-end.
 *  - The proxy returns 502 when the backend is unreachable.
 */

import * as http from 'http';
import { createTunnelServer } from '../src/server';
import { mergeConfig } from '../src/config';

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
