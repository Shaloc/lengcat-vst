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
import * as crypto from 'crypto';
import httpProxy from 'http-proxy';
import { BackendConfig, BackendType, TunnelConfig, buildBackendConfig } from './config';
import { backendOrigin } from './backends';
import { createAuthMiddleware } from './auth';
import { SessionManager } from './session';
import { renderDashboard, renderLoginPage } from './ui';
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

// ── Dashboard-password cookie helpers ────────────────────────────────────────
const SESSION_COOKIE_NAME = 'lvst_session';

/**
 * A random server-instance secret mixed into the session-token HMAC.
 * Generated once at startup so that session cookies are invalidated when
 * the proxy restarts (requiring re-authentication), and so that knowledge
 * of the dashboard password alone is not enough to forge a cookie.
 */
const _instanceSecret = crypto.randomBytes(32).toString('hex');

/**
 * Derives the expected session-cookie value from the given password.
 * Uses HMAC-SHA256 keyed on a per-instance random secret so that the
 * cookie cannot be forged even if the password is known.
 */
function computeSessionToken(password: string): string {
  return crypto
    .createHmac('sha256', _instanceSecret)
    .update(`lvst-session-v1:${password}`)
    .digest('hex');
}

/** Returns true when `submitted` equals `expected` in constant time. */
function timingSafeStringEqual(submitted: string, expected: string): boolean {
  const a = Buffer.from(submitted);
  const b = Buffer.from(expected);
  // Run timingSafeEqual even on length mismatch to avoid short-circuit
  // timing differences that could leak password length information.
  const padded = Buffer.alloc(Math.max(a.length, b.length));
  a.copy(padded, 0, 0, Math.min(a.length, padded.length));
  const paddedB = Buffer.alloc(padded.length);
  b.copy(paddedB, 0, 0, Math.min(b.length, paddedB.length));
  const equal = crypto.timingSafeEqual(padded, paddedB);
  return equal && a.length === b.length;
}

/** Extracts the value of a named cookie from the Cookie request header. */
function extractCookie(req: http.IncomingMessage, name: string): string | undefined {
  const header = req.headers['cookie'];
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      return part.slice(eq + 1).trim();
    }
  }
  return undefined;
}

/**
 * Returns true when the request carries a valid session cookie for
 * the given dashboard password.
 */
function isSessionAuthenticated(req: http.IncomingMessage, password: string): boolean {
  const cookie = extractCookie(req, SESSION_COOKIE_NAME);
  if (!cookie) return false;
  const expected = computeSessionToken(password);
  try {
    const a = Buffer.from(cookie, 'hex');
    const b = Buffer.from(expected, 'hex');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/**
 * Handles GET and POST /_login.
 *
 * GET  : serves the login page HTML.
 * POST : validates the submitted password; on success sets a session cookie
 *        and redirects to the `next` URL (or `/`); on failure re-renders the
 *        login page with an error message.
 */
async function handleLoginRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  config: TunnelConfig
): Promise<void> {
  if (req.method === 'POST') {
    let password = '';
    let next = '/';
    try {
      const raw = await readBody(req);
      const params = new URLSearchParams(raw);
      password = params.get('password') ?? '';
      const rawNext = params.get('next') ?? '/';
      // Only allow same-origin redirects (must start with /).
      next = rawNext.startsWith('/') ? rawNext : '/';
    } catch {
      // Fall through with empty password → will fail the check below.
    }

    if (timingSafeStringEqual(password, config.dashboardPassword!)) {
      const token = computeSessionToken(config.dashboardPassword!);
      const flags = [
        `${SESSION_COOKIE_NAME}=${token}`,
        'Path=/',
        'HttpOnly',
        'SameSite=Lax',
      ];
      if (config.https) flags.push('Secure');
      res.writeHead(302, {
        'Set-Cookie': flags.join('; '),
        'Location': next,
      });
      res.end();
    } else {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderLoginPage(true, next));
    }
    return;
  }

  // GET /_login
  const urlObj = new URL(req.url ?? '/_login', 'http://localhost');
  const next = urlObj.searchParams.get('next') ?? '/';
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(renderLoginPage(false, next));
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

// ── leduo-patrol content-script injection ─────────────────────────────────
// When leduo-patrol is loaded inside a lengcat-vst iframe, this script is
// injected into its HTML pages.  It turns filesystem-path elements into
// clickable links that send a postMessage to the dashboard, which then
// opens (or switches to) a VS Code session for that folder.
const LEDUO_PATROL_INJECTION_SCRIPT = `<script data-lvst-injected>
(function(){
  if(window.parent===window)return;
  function isAbsPath(t){
    t=t.trim();
    return t.length>=2&&t.startsWith('/')&&t.indexOf('/',1)>0&&!/\\s/.test(t)&&!t.includes('<');
  }
  function process(el){
    if(!el||!el.tagName)return;
    if(el.dataset&&el.dataset.lvstProcessed)return;
    if(/^(A|BUTTON|INPUT|TEXTAREA|SCRIPT|STYLE|SVG)$/.test(el.tagName))return;
    if(el.closest&&el.closest('a,button'))return;
    if(el.children&&el.children.length>0)return;
    var text=el.textContent||'';
    if(!isAbsPath(text))return;
    el.dataset.lvstProcessed='1';
    el.style.cursor='pointer';
    el.style.textDecoration='underline';
    el.style.textDecorationColor='rgba(137,180,250,0.5)';
    el.style.textUnderlineOffset='3px';
    el.title='Open in VS Code session';
    el.addEventListener('click',function(e){
      e.preventDefault();e.stopPropagation();
      window.parent.postMessage({type:'lvst:open-folder',folder:text.trim()},'*');
    });
  }
  function scan(root){
    if(!root||!root.querySelectorAll)return;
    root.querySelectorAll('*').forEach(process);
  }
  function init(){scan(document.body);
    new MutationObserver(function(ms){
      for(var i=0;i<ms.length;i++)
        for(var j=0;j<ms[i].addedNodes.length;j++){
          var n=ms[i].addedNodes[j];
          if(n.nodeType===1){process(n);scan(n);}
        }
    }).observe(document.body,{childList:true,subtree:true});
  }
  if(document.body)init();
  else document.addEventListener('DOMContentLoaded',init);
})();
</` + `script>`;

/** Returns a per-origin proxy instance, creating one on first use. */
function getOrCreateProxy(
  backend: BackendConfig,
  cache: Map<string, httpProxy>
): httpProxy {
  const origin = backendOrigin(backend);
  const isLeduoPatrol = backend.type === 'leduoPatrol';

  if (!cache.has(origin)) {
    const proxy = httpProxy.createProxyServer({
      target: origin,
      ws: true,
      changeOrigin: true,
      // Rewrite Location headers in redirects to point to the proxy URL
      // instead of the raw backend URL, preventing mixed-content errors when
      // the proxy is serving HTTPS and the backend redirects to an HTTP URL.
      autoRewrite: true,
      // Do not verify SSL cert of backend (useful for self-signed certs).
      secure: false,
      // For leduo-patrol backends, disable automatic response piping so we can
      // inject a content script into HTML responses.
      selfHandleResponse: isLeduoPatrol,
    });

    // For leduo-patrol, strip Accept-Encoding so the backend responds with
    // uncompressed HTML that we can safely modify for script injection.
    if (isLeduoPatrol) {
      proxy.on('proxyReq', (proxyReq: http.ClientRequest) => {
        proxyReq.removeHeader('Accept-Encoding');
      });
    }

    // ── HTTP response fixups ────────────────────────────────────────────────
    // Strip headers that would prevent VS Code from loading inside the
    // dashboard iframe.
    proxy.on('proxyRes', (proxyRes: http.IncomingMessage, _proxyReq: http.IncomingMessage, res: http.ServerResponse | net.Socket) => {
      // X-Frame-Options: DENY/SAMEORIGIN blocks iframe embedding entirely.
      delete proxyRes.headers['x-frame-options'];

      // Remove the 'frame-ancestors' CSP directive that would also block the
      // iframe, while preserving any other CSP directives.
      // Note: we split naively on ';'. This is reliable for VS Code's CSP
      // because its directives do not contain semicolons inside quoted values.
      const csp = proxyRes.headers['content-security-policy'];
      if (typeof csp === 'string') {
        if (isLeduoPatrol) {
          // Remove the entire CSP for leduo-patrol so the injected inline
          // script executes without being blocked by script-src restrictions.
          delete proxyRes.headers['content-security-policy'];
        } else {
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
      }

      // Allow VS Code's service worker to claim scope '/' even when the iframe
      // is loaded at a path prefix (e.g. /_session/s1/).  Without this header
      // the browser throws a SecurityError because the service-worker script
      // URL lives under the session prefix but the registration requests scope
      // '/'.  The Service-Worker-Allowed response header explicitly grants the
      // wider scope.
      proxyRes.headers['service-worker-allowed'] = '/';

      // ── leduo-patrol: inject content script into HTML responses ──────────
      if (isLeduoPatrol && res instanceof http.ServerResponse) {
        const ct = String(proxyRes.headers['content-type'] || '');
        if (ct.includes('text/html')) {
          const chunks: Buffer[] = [];
          proxyRes.on('data', (chunk: Buffer) => chunks.push(chunk));
          proxyRes.on('end', () => {
            let body = Buffer.concat(chunks).toString('utf-8');
            body = body.replace(/<\/body>/i, LEDUO_PATROL_INJECTION_SCRIPT + '</body>');
            const buf = Buffer.from(body, 'utf-8');
            // We're sending the full body at once, so use Content-Length and
            // remove Transfer-Encoding to avoid an HTTP parse error.
            delete proxyRes.headers['transfer-encoding'];
            proxyRes.headers['content-length'] = String(buf.length);
            res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
            res.end(buf);
          });
        } else {
          // Non-HTML response: pipe through unchanged.
          res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
          proxyRes.pipe(res);
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
 *   GET  /api/tls/cert              → download the active TLS certificate (PEM)
 */
async function handleUiRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  sessions: SessionManager,
  tls?: TlsCredentials
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

    const type = (body.type as BackendType | undefined) ?? 'vscode';
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

    const sessionToLaunch = sessions.get(id);
    if (!sessionToLaunch) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Session ${id} not found.` }));
      return;
    }

    // Launch asynchronously so the HTTP response is not blocked waiting for
    // the backend process to start (which can take many seconds).
    // The folder override is applied synchronously at the very start of
    // sessions.launch() before any await, so it is immediately visible.
    sessions.launch(id, folder).catch((err: Error) => {
      process.stderr.write(
        `[lengcat-vst] session ${id} launch failed: ${err.message}\n`
      );
    });

    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(sessions.get(id)));
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

  // Open folder — find an existing VS Code session for the given folder path,
  // or create (and launch) a new one with the next available port.
  // Used by the dashboard's postMessage bridge so that leduo-patrol iframes
  // can request "open this folder in VS Code" without knowing the session list.
  if (method === 'POST' && path === '/api/sessions/open-folder') {
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(await readBody(req)) as Record<string, unknown>;
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid JSON body.' }));
      return;
    }
    const folder = typeof body.folder === 'string' ? body.folder.trim() : '';
    if (!folder) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing "folder" field.' }));
      return;
    }

    // Look for an existing VS Code session already open at this folder.
    const existing = sessions.list().find(
      (s) => s.type === 'vscode' && s.folder === folder && s.status === 'running'
    );
    if (existing) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(sessions.get(existing.id)));
      return;
    }

    // Pick the next available port (starting from 8000).
    const usedPorts = new Set(sessions.list().map((s) => s.port));
    let port = 8000;
    while (usedPorts.has(port)) port++;

    const cfg = buildBackendConfig({
      type: 'vscode',
      host: '127.0.0.1',
      port,
      tls: false,
      tokenSource: 'none',
      folder,
    });
    const session = sessions.register(cfg);

    try {
      await sessions.launch(session.id);
    } catch {
      // Return the session record even if launch failed; status will be 'error'.
    }

    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(sessions.get(session.id)));
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

  // Export TLS certificate for installation in the system / browser trust store.
  // Downloading and trusting this certificate resolves Service Worker SSL errors
  // caused by the browser rejecting the self-signed certificate.
  if (method === 'GET' && path === '/api/tls/cert') {
    if (!tls) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No TLS certificate available (server is running over HTTP).' }));
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'application/x-pem-file',
      'Content-Disposition': 'attachment; filename="lengcat-vst-ca.pem"',
    });
    res.end(tls.cert);
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
    const rawPath = url.split('?')[0];

    // ── Dashboard-password gate ──────────────────────────────────────────────
    // The /_login route is always reachable so users can authenticate.
    // All other routes require a valid session cookie when a dashboard
    // password has been configured.
    if (config.dashboardPassword) {
      if (rawPath === '/_login') {
        void handleLoginRequest(req, res, config);
        return;
      }
      if (!isSessionAuthenticated(req, config.dashboardPassword)) {
        if (req.method === 'GET' || req.method === 'HEAD') {
          const next = encodeURIComponent(url);
          res.writeHead(302, { Location: `/_login?next=${next}` });
          res.end();
        } else {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized. Please log in at /_login.' }));
        }
        return;
      }
    }

    // ── Dashboard / session-management API ──
    // When a SessionManager is active, the root URL serves the dashboard and
    // the specific /api/sessions* and /api/tls/cert routes serve the REST API.
    // Legacy /_ui paths are also accepted.
    //
    // IMPORTANT: only the exact dashboard-API paths are intercepted here.
    // Any other /api/* path (e.g. /api/config or /api/state served by a
    // leduoPatrol backend) must fall through to the backend-proxy logic below.
    if (sessionMgr && (
      url === '/' ||
      url === '/_ui' || url === '/_ui/' || url.startsWith('/_ui/') ||
      rawPath === '/api/sessions' || rawPath.startsWith('/api/sessions/') ||
      rawPath === '/api/tls/cert'
    )) {
      void handleUiRequest(req, res, sessionMgr, tls);
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

    // Strip the path prefix so code-server (which always serves at '/') sees
    // paths from its own root.  This is standard reverse-proxy behaviour:
    // the client accesses /prefix/path, the backend sees /path.
    if (backend.pathPrefix && req.url?.startsWith(backend.pathPrefix)) {
      req.url = req.url.slice(backend.pathPrefix.length) || '/';
    }

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

  // Track open TCP connections so close() can destroy them immediately.
  // Without this, keep-alive connections held open by browsers prevent
  // server.close() from resolving until the client releases them.
  const openConnections = new Set<net.Socket>();
  server.on('connection', (socket: net.Socket) => {
    openConnections.add(socket);
    socket.once('close', () => openConnections.delete(socket));
  });
  // HTTPS servers emit 'secureConnection' for TLS sockets in addition to
  // 'connection' for the underlying TCP socket.  Track both to be safe.
  server.on('secureConnection' as 'connection', (socket: net.Socket) => {
    openConnections.add(socket);
    socket.once('close', () => openConnections.delete(socket));
  });

  // ── WebSocket / WSS upgrade handler ─────────────────────────────────────
  // Registered on the server so it handles both ws:// (HTTP server) and
  // wss:// (HTTPS server — TLS is already unwrapped by Node.js before the
  // upgrade event fires).
  server.on('upgrade', (req: http.IncomingMessage, socket: net.Socket, head: Buffer) => {
    const url = req.url ?? '/';

    // ── Dashboard-password gate for WebSocket upgrades ───────────────────
    // Browsers include cookies in WebSocket upgrade requests (same-origin),
    // so we can reuse the same cookie-based authentication here.
    if (config.dashboardPassword && !isSessionAuthenticated(req, config.dashboardPassword)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n');
      socket.destroy();
      return;
    }

    // Block WS upgrades to the internal dashboard / session-management paths
    // (they have no WebSocket API).  Other /api/* paths belong to the backend
    // and must be proxied through, not blocked.
    const wsRawPath = url.split('?')[0];
    if (sessionMgr && (
      url === '/' ||
      url.startsWith('/_ui/') ||
      wsRawPath === '/api/sessions' || wsRawPath.startsWith('/api/sessions/') ||
      wsRawPath === '/api/tls/cert'
    )) {
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

    // Strip path prefix for WebSocket upgrades, same as HTTP requests.
    if (backend.pathPrefix && req.url?.startsWith(backend.pathPrefix)) {
      req.url = req.url.slice(backend.pathPrefix.length) || '/';
    }

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
        // Destroy all lingering keep-alive connections so server.close()
        // resolves immediately instead of waiting for browsers to release
        // their persistent HTTP connections.
        for (const socket of openConnections) {
          socket.destroy();
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
