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
 *  - Serves a session-management dashboard at GET /_ui when a SessionManager
 *    is provided, with a REST API at /_ui/api/* for managing sessions.
 */

import * as http from 'http';
import * as https from 'https';
import * as net from 'net';
import httpProxy from 'http-proxy';
import { BackendConfig, BackendType, TunnelConfig, buildBackendConfig } from './config';
import { backendOrigin } from './backends';
import { createAuthMiddleware } from './auth';
import { SessionManager } from './session';
import { renderDashboard } from './ui';
import type { TlsCredentials } from './tls';

export interface TunnelServer {
  /** The underlying Node.js HTTP (or HTTPS) server. */
  httpServer: http.Server | https.Server;
  /** Start listening on the configured host/port. */
  listen(): Promise<void>;
  /** Gracefully close the server and proxy. */
  close(): Promise<void>;
  /** True when the server is serving over TLS (HTTPS / WSS). */
  isHttps: boolean;
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

/** Returns a per-origin proxy instance, creating one on first use. */
function getOrCreateProxy(
  backend: BackendConfig,
  cache: Map<string, httpProxy>
): httpProxy {
  const origin = backendOrigin(backend);
  if (!cache.has(origin)) {
    const proxy = httpProxy.createProxyServer({
      target: origin,
      ws: true,
      changeOrigin: true,
      // Do not verify SSL cert of backend (useful for self-signed certs).
      secure: false,
    });

    // ── HTTP response fixups ────────────────────────────────────────────────
    // Strip headers that would prevent VS Code from loading inside the
    // dashboard iframe.
    proxy.on('proxyRes', (proxyRes: http.IncomingMessage) => {
      // X-Frame-Options: DENY/SAMEORIGIN blocks iframe embedding entirely.
      delete proxyRes.headers['x-frame-options'];

      // Remove the 'frame-ancestors' CSP directive that would also block the
      // iframe, while preserving any other CSP directives.
      // Note: we split naively on ';'. This is reliable for VS Code's CSP
      // because its directives do not contain semicolons inside quoted values.
      const csp = proxyRes.headers['content-security-policy'];
      if (typeof csp === 'string') {
        const stripped = csp
          .split(';')
          .filter((d) => !/^\s*frame-ancestors\b/i.test(d))
          .join(';')
          .trim()
          .replace(/;$/, '');
        if (stripped) {
          proxyRes.headers['content-security-policy'] = stripped;
        } else {
          delete proxyRes.headers['content-security-policy'];
        }
      }
    });

    // ── WebSocket upgrade fixup ─────────────────────────────────────────────
    // VS Code's server validates the Origin header on WebSocket upgrades.
    // The browser sends the proxy's origin (e.g. http://192.168.1.10:3000)
    // which VS Code doesn't recognise, causing it to reject the upgrade and
    // producing a status-1006 close on the client side.  Replacing Origin
    // with the backend's own origin makes VS Code treat the connection as
    // coming from itself and accept it.
    proxy.on('proxyReqWs', (proxyReq: http.ClientRequest) => {
      proxyReq.setHeader('Origin', origin);
    });

    // ── Error handling ──────────────────────────────────────────────────────
    proxy.on('error', (err: Error, _req: http.IncomingMessage, res: http.ServerResponse | net.Socket) => {
      if (res instanceof http.ServerResponse) {
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
        }
        res.end(JSON.stringify({ error: 'Bad Gateway', detail: err.message }));
      } else if (res instanceof net.Socket) {
        // The WebSocket upgrade to the backend failed before the browser
        // received a 101.  Send an HTTP 502 so the browser gets a clean
        // error instead of a raw socket close (which shows as WS 1006).
        if (res.writable) {
          res.write(
            'HTTP/1.1 502 Bad Gateway\r\n' +
            'Content-Length: 0\r\n' +
            'Connection: close\r\n\r\n'
          );
        }
        res.destroy();
      }
    });

    cache.set(origin, proxy);
  }
  return cache.get(origin)!;
}

/** Reads the full request body and resolves with the raw string. */
function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

/** Strips the query string from a URL, returning only the path. */
function urlPath(url: string): string {
  const q = url.indexOf('?');
  return q === -1 ? url : url.slice(0, q);
}

/**
 * Handles requests to the dashboard and session-management API.
 *
 * The dashboard is served at the root so that opening the proxy URL in a
 * browser immediately shows the session manager.  The legacy /_ui path is
 * kept as an alias for backwards compatibility.
 *
 * Routes:
 *   GET  /                          → session-management dashboard HTML (alias: /_ui)
 *   GET  /api/sessions              → list all sessions (JSON)
 *   POST /api/sessions              → create (and optionally launch) a session
 *   POST /api/sessions/:id/launch   → launch a stopped/errored session
 *   POST /api/sessions/:id/stop     → stop a running session
 *   DELETE /api/sessions/:id        → remove a session
 */
async function handleUiRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  sessions: SessionManager
): Promise<void> {
  const method = req.method ?? 'GET';
  const rawPath = urlPath(req.url ?? '');

  // Normalise legacy /_ui prefix → /  so all matching below uses clean paths.
  const path = rawPath === '/_ui' || rawPath === '/_ui/'
    ? '/'
    : rawPath.startsWith('/_ui/api/')
      ? rawPath.replace('/_ui/api/', '/api/')
      : rawPath;

  // Dashboard (root or legacy /_ui)
  if (method === 'GET' && (path === '/' || path === '/_ui' || path === '/_ui/')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderDashboard());
    return;
  }

  // List sessions
  if (method === 'GET' && path === '/api/sessions') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(sessions.toJSON()));
    return;
  }

  // Create session
  if (method === 'POST' && path === '/api/sessions') {
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(await readBody(req)) as Record<string, unknown>;
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON body.' }));
      return;
    }

    const type = (body.type as BackendType | undefined) ?? 'vscodium';
    const port = typeof body.port === 'number' ? body.port : parseInt(String(body.port ?? '8000'), 10);
    const host = typeof body.host === 'string' ? body.host : '127.0.0.1';
    const tokenSource = (body.tokenSource as string | undefined) ?? 'none';
    const token = typeof body.token === 'string' ? body.token : undefined;
    const executable = typeof body.executable === 'string' ? body.executable : undefined;
    const folder = typeof body.folder === 'string' && body.folder ? body.folder : undefined;
    const extensionHostOnly = body.extensionHostOnly === true;
    const shouldLaunch = body.launch !== false;

    const config = buildBackendConfig({
      type,
      host,
      port,
      tls: false,
      tokenSource: tokenSource as 'none' | 'fixed' | 'auto',
      token,
      executable,
      folder,
      extensionHostOnly,
    });

    const session = sessions.register(config);

    if (shouldLaunch) {
      try {
        await sessions.launch(session.id);
      } catch {
        // Return the session record even if launch failed; status will be 'error'.
      }
    }

    res.writeHead(201, { 'Content-Type': 'application/json' });
    const info = sessions.get(session.id);
    res.end(JSON.stringify(info));
    return;
  }

  // Launch session
  // Accepts an optional JSON body: { folder?: string }
  const launchMatch = /^\/api\/sessions\/([^/]+)\/launch$/.exec(path);
  if (method === 'POST' && launchMatch) {
    const id = launchMatch[1];
    let folder: string | undefined;
    try {
      const raw = await readBody(req);
      if (raw.trim()) {
        const body = JSON.parse(raw) as Record<string, unknown>;
        folder = typeof body.folder === 'string' && body.folder ? body.folder : undefined;
      }
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON body.' }));
      return;
    }
    try {
      await sessions.launch(id, folder);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(sessions.get(id)));
    } catch (err) {
      const msg = (err as Error).message;
      const status = msg.includes('not found') ? 404 : 500;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: msg }));
    }
    return;
  }

  // Stop session
  const stopMatch = /^\/api\/sessions\/([^/]+)\/stop$/.exec(path);
  if (method === 'POST' && stopMatch) {
    const id = stopMatch[1];
    try {
      sessions.stop(id);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(sessions.get(id)));
    } catch (err) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
    return;
  }

  // Remove session
  const removeMatch = /^\/api\/sessions\/([^/]+)$/.exec(path);
  if (method === 'DELETE' && removeMatch) {
    const id = removeMatch[1];
    const removed = sessions.remove(id);
    if (removed) {
      res.writeHead(204);
      res.end();
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Session ${id} not found.` }));
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found.' }));
}

/**
 * Creates a TunnelServer for the given configuration.
 *
 * When multiple backends are configured each backend should have a unique
 * `pathPrefix` so that incoming requests can be routed to the correct
 * instance.  This enables running multiple VS Code instances and embedding
 * them on the same browser page (e.g. in separate iframes).
 *
 * @param config        Tunnel configuration.
 * @param sessionMgr    Optional SessionManager.  When provided the proxy
 *                      uses its live session list for routing and serves the
 *                      session-management dashboard at /_ui.
 * @param tls           Optional TLS credentials.  When supplied the server
 *                      listens over HTTPS/WSS so that browsers grant the page
 *                      a secure context (required by some VS Code extensions).
 */
export function createTunnelServer(
  config: TunnelConfig,
  sessionMgr?: SessionManager,
  tls?: TlsCredentials
): TunnelServer {
  if (config.backends.length === 0 && !sessionMgr) {
    throw new Error('At least one backend must be configured.');
  }

  // Per-origin proxy cache — proxies are created on first use so that
  // sessions added at runtime (via the dashboard) are handled automatically.
  const proxyCache = new Map<string, httpProxy>();

  const authMiddleware =
    config.auth && config.proxySecret
      ? createAuthMiddleware(config.proxySecret)
      : null;

  /** Returns the current list of routable backends. */
  function activeBackends(): BackendConfig[] {
    if (sessionMgr) {
      return sessionMgr
        .list()
        .filter((s) => s.status === 'running')
        .map((s) => s.config);
    }
    return config.backends;
  }

  // ── Request handler (shared between HTTP and HTTPS) ─────────────────────
  const requestHandler = (req: http.IncomingMessage, res: http.ServerResponse): void => {
    const url = req.url ?? '/';

    // ── Dashboard / session-management API ──
    // When a SessionManager is active, the root URL serves the dashboard and
    // /api/* serves the REST API.  Legacy /_ui paths are also accepted.
    if (sessionMgr && (
      url === '/' ||
      url === '/_ui' || url === '/_ui/' || url.startsWith('/_ui/') ||
      url.startsWith('/api/')
    )) {
      void handleUiRequest(req, res, sessionMgr);
      return;
    }

    const backends = activeBackends();
    if (backends.length === 0) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No running sessions.' }));
      return;
    }

    const backend = selectBackend(url, backends);
    const proxy = getOrCreateProxy(backend, proxyCache);

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
  };

  // ── Create HTTP or HTTPS server ──────────────────────────────────────────
  const server: http.Server | https.Server = tls
    ? https.createServer({ cert: tls.cert, key: tls.key }, requestHandler)
    : http.createServer(requestHandler);

  // ── WebSocket / WSS upgrade handler ─────────────────────────────────────
  // Registered on the server so it handles both ws:// (HTTP server) and
  // wss:// (HTTPS server — TLS is already unwrapped by Node.js before the
  // upgrade event fires).
  server.on('upgrade', (req: http.IncomingMessage, socket: net.Socket, head: Buffer) => {
    const url = req.url ?? '/';

    // Block WS upgrades to UI/API paths (they are not proxied).
    if (sessionMgr && (url === '/' || url.startsWith('/_ui/') || url.startsWith('/api/'))) {
      socket.write('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n');
      socket.destroy();
      return;
    }

    const backends = activeBackends();
    if (backends.length === 0) {
      socket.destroy();
      return;
    }

    const backend = selectBackend(url, backends);
    const proxy = getOrCreateProxy(backend, proxyCache);

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
    isHttps: !!tls,
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
        for (const proxy of proxyCache.values()) {
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
