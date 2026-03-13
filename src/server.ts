/**
 * Local HTTP + WebSocket reverse proxy for VS Code serve-web backends.
 *
 * Creates a Node.js HTTP server that:
 *  - Forwards all HTTP requests to the configured backend VS Code server.
 *  - Upgrades WebSocket connections and proxies them to the backend.
 *  - Optionally applies authentication via createAuthMiddleware().
 *  - Supports multiple backend instances via path-prefix-based routing,
 *    enabling several VS Code instances to be served from a single proxy
 *    (and embedded on the same browser page in separate iframes).
 */

import * as http from 'http';
import * as net from 'net';
import httpProxy from 'http-proxy';
import { BackendConfig, TunnelConfig } from './config';
import { backendOrigin } from './backends';
import { createAuthMiddleware } from './auth';

export interface TunnelServer {
  /** The underlying Node.js HTTP server. */
  httpServer: http.Server;
  /** Start listening on the configured host/port. */
  listen(): Promise<void>;
  /** Gracefully close the server and proxy. */
  close(): Promise<void>;
}

/**
 * Selects the backend that should handle the given request URL.
 *
 * Backends with a `pathPrefix` are checked in order; the first whose prefix
 * matches the URL wins.  If no prefixed backend matches, the first backend in
 * the list is returned as the default (backwards-compatible behaviour for
 * single-backend configurations).
 */
export function selectBackend(url: string, backends: BackendConfig[]): BackendConfig {
  for (const backend of backends) {
    if (!backend.pathPrefix) continue;
    const prefix = backend.pathPrefix;
    if (url === prefix || url.startsWith(prefix + '/') || url.startsWith(prefix + '?')) {
      return backend;
    }
  }
  return backends[0];
}

/**
 * Creates a TunnelServer for the given configuration.
 *
 * When multiple backends are configured each backend should have a unique
 * `pathPrefix` so that incoming requests can be routed to the correct
 * instance.  This enables running multiple VS Code instances and embedding
 * them on the same browser page (e.g. in separate iframes).
 */
export function createTunnelServer(config: TunnelConfig): TunnelServer {
  if (config.backends.length === 0) {
    throw new Error('At least one backend must be configured.');
  }

  // Build one proxy instance per unique backend origin so that each backend
  // gets its own connection pool and error handler.
  const proxyMap = new Map<BackendConfig, httpProxy>();
  for (const backend of config.backends) {
    const proxy = httpProxy.createProxyServer({
      target: backendOrigin(backend),
      ws: true,
      changeOrigin: true,
      // Do not verify SSL cert of backend (useful for self-signed certs in
      // development environments).
      secure: false,
    });

    proxy.on('error', (err, _req, res) => {
      // res may be a ServerResponse or a Socket (for WS errors)
      if (res instanceof http.ServerResponse) {
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
        }
        res.end(JSON.stringify({ error: 'Bad Gateway', detail: err.message }));
      } else if (res instanceof net.Socket) {
        res.destroy();
      }
    });

    proxyMap.set(backend, proxy);
  }

  const authMiddleware =
    config.auth && config.proxySecret
      ? createAuthMiddleware(config.proxySecret)
      : null;

  const server = http.createServer((req, res) => {
    const backend = selectBackend(req.url ?? '/', config.backends);
    const proxy = proxyMap.get(backend)!;

    if (authMiddleware) {
      authMiddleware(req, res, (err) => {
        if (err) {
          res.writeHead(500);
          res.end();
          return;
        }
        proxy.web(req, res);
      });
    } else {
      proxy.web(req, res);
    }
  });

  // Proxy WebSocket upgrade requests.
  server.on('upgrade', (req, socket, head) => {
    const backend = selectBackend(req.url ?? '/', config.backends);
    const proxy = proxyMap.get(backend)!;

    if (authMiddleware) {
      // Authenticate WS upgrades via the token query-string parameter.
      const fakeRes = new http.ServerResponse(req);
      authMiddleware(req, fakeRes, (err) => {
        if (err || (fakeRes as { statusCode?: number }).statusCode === 401) {
          socket.write(
            'HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n'
          );
          socket.destroy();
          return;
        }
        proxy.ws(req, socket, head);
      });
    } else {
      proxy.ws(req, socket, head);
    }
  });

  return {
    httpServer: server,
    listen(): Promise<void> {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(config.port, config.host, () => {
          server.off('error', reject);
          resolve();
        });
      });
    },
    close(): Promise<void> {
      return new Promise((resolve, reject) => {
        for (const proxy of proxyMap.values()) {
          proxy.close();
        }
        server.close((err) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      });
    },
  };
}
