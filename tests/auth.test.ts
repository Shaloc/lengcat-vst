import { extractToken, createAuthMiddleware } from '../src/auth';
import { IncomingMessage, ServerResponse } from 'http';
import { Socket } from 'net';

function makeReq(options: { authHeader?: string; url?: string }): IncomingMessage {
  const socket = new Socket();
  const req = new IncomingMessage(socket);
  req.url = options.url ?? '/';
  if (options.authHeader) {
    req.headers['authorization'] = options.authHeader;
  }
  return req;
}

describe('extractToken', () => {
  it('extracts Bearer token from Authorization header', () => {
    const req = makeReq({ authHeader: 'Bearer mysecret' });
    expect(extractToken(req)).toBe('mysecret');
  });

  it('extracts token from query string', () => {
    const req = makeReq({ url: '/?token=qs-secret' });
    expect(extractToken(req)).toBe('qs-secret');
  });

  it('prefers Authorization header over query string', () => {
    const req = makeReq({ authHeader: 'Bearer header-token', url: '/?token=qs-token' });
    expect(extractToken(req)).toBe('header-token');
  });

  it('returns undefined when no token present', () => {
    const req = makeReq({});
    expect(extractToken(req)).toBeUndefined();
  });

  it('returns undefined for non-Bearer Authorization header', () => {
    const req = makeReq({ authHeader: 'Basic dXNlcjpwYXNz' });
    expect(extractToken(req)).toBeUndefined();
  });
});

describe('createAuthMiddleware', () => {
  it('throws when given an empty secret', () => {
    expect(() => createAuthMiddleware('')).toThrow('Auth secret must not be empty.');
  });

  it('calls next() for valid Bearer token', () => {
    const middleware = createAuthMiddleware('correct');
    const req = makeReq({ authHeader: 'Bearer correct' });
    const socket = new Socket();
    const res = new ServerResponse(req);
    res.assignSocket(socket);

    const next = jest.fn();
    middleware(req, res, next);
    expect(next).toHaveBeenCalledWith();
  });

  it('calls next() for valid query-string token', () => {
    const middleware = createAuthMiddleware('correct');
    const req = makeReq({ url: '/?token=correct' });
    const socket = new Socket();
    const res = new ServerResponse(req);
    res.assignSocket(socket);

    const next = jest.fn();
    middleware(req, res, next);
    expect(next).toHaveBeenCalledWith();
  });

  it('returns 401 for wrong token', () => {
    const middleware = createAuthMiddleware('correct');
    const req = makeReq({ authHeader: 'Bearer wrong' });

    let statusCode = 0;
    let body = '';

    const socket = new Socket();
    const res = new ServerResponse(req);
    res.assignSocket(socket);
    const origWriteHead = res.writeHead.bind(res);
    res.writeHead = (code: number) => {
      statusCode = code;
      return origWriteHead(code);
    };
    res.end = ((data?: unknown) => {
      body = String(data ?? '');
      return res;
    }) as typeof res.end;

    const next = jest.fn();
    middleware(req, res, next);

    expect(statusCode).toBe(401);
    expect(body).toContain('Unauthorized');
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 when no token provided', () => {
    const middleware = createAuthMiddleware('correct');
    const req = makeReq({});

    let statusCode = 0;
    const socket = new Socket();
    const res = new ServerResponse(req);
    res.assignSocket(socket);
    const origWriteHead = res.writeHead.bind(res);
    res.writeHead = (code: number) => {
      statusCode = code;
      return origWriteHead(code);
    };
    res.end = (() => res) as typeof res.end;

    const next = jest.fn();
    middleware(req, res, next);

    expect(statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });
});
