/**
 * Authentication middleware for the local tunnel proxy.
 *
 * When `auth` is enabled in the TunnelConfig, every incoming HTTP request must
 * present the proxy secret either as a Bearer token in the Authorization header
 * or as the `token` query-string parameter.
 *
 * WebSocket upgrade requests are authenticated via the `token` query-string
 * parameter (browsers cannot set custom headers for WS connections).
 */

import { IncomingMessage, ServerResponse } from 'http';

/** A minimal express-compatible middleware type. */
type Next = (err?: Error) => void;
type Middleware = (req: IncomingMessage, res: ServerResponse, next: Next) => void;

/**
 * Extracts the provided token from a request.
 * Checks, in order:
 *   1. Authorization: Bearer <token> header
 *   2. `token` query-string parameter
 */
export function extractToken(req: IncomingMessage): string | undefined {
  const authHeader = req.headers['authorization'];
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice('Bearer '.length).trim();
  }

  const url = req.url ?? '';
  const qsIndex = url.indexOf('?');
  if (qsIndex !== -1) {
    const qs = new URLSearchParams(url.slice(qsIndex + 1));
    const tokenParam = qs.get('token');
    if (tokenParam) {
      return tokenParam;
    }
  }

  return undefined;
}

/**
 * Creates an authentication middleware.
 *
 * @param secret - The expected secret token.  Must not be empty.
 * @returns An express-compatible middleware that validates the token.
 */
export function createAuthMiddleware(secret: string): Middleware {
  if (!secret) {
    throw new Error('Auth secret must not be empty.');
  }

  return function authMiddleware(
    req: IncomingMessage,
    res: ServerResponse,
    next: Next
  ): void {
    const provided = extractToken(req);

    if (provided !== secret) {
      res.writeHead(401, {
        'Content-Type': 'application/json',
        'WWW-Authenticate': 'Bearer realm="lengcat-vst"',
      });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    next();
  };
}
