/**
 * Local HTTP + WebSocket reverse proxy for VS Code serve-web backends.
 *
 * Creates a Node.js HTTP server that:
 *  - Forwards all HTTP requests to the configured backend VS Code server.
 *  - Upgrades WebSocket connections and proxies them to the backend.
 *  - Optionally applies authentication via createAuthMiddleware().
 */

import * as http from 'http';
import * as net from 'net';
import httpProxy from 'http-proxy';
import { TunnelConfig } from './config';
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
 * Creates a TunnelServer for the given configuration.
 *
 * Only the first backend is used for proxying.  Multi-backend routing is a
 * future enhancement.
 */
export function createTunnelServer(config: TunnelConfig): TunnelServer {
  if (config.backends.length === 0) {
    throw new Error('At least one backend must be configured.');
  }

  const backend = config.backends[0];
  const target = backendOrigin(backend);

  const proxy = httpProxy.createProxyServer({
    target,
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

  const authMiddleware =
    config.auth && config.proxySecret
      ? createAuthMiddleware(config.proxySecret)
      : null;

  const server = http.createServer((req, res) => {
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
        proxy.close();
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
