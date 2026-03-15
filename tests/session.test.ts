/**
 * Unit tests for SessionManager (src/session.ts).
 */

import { SessionManager, _resetCounter } from '../src/session';
import { buildBackendConfig } from '../src/config';
import * as os from 'os';
import * as nodePath from 'path';
import * as fs from 'fs';

// Reset the session ID counter before each test so IDs are deterministic.
beforeEach(() => { _resetCounter(); });

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeConfig(port = 8000) {
  return buildBackendConfig({ type: 'vscode', host: '127.0.0.1', port });
}

// ── register ─────────────────────────────────────────────────────────────────

describe('SessionManager.register', () => {
  it('creates a session with status stopped', () => {
    const mgr = new SessionManager();
    const s = mgr.register(makeConfig());
    expect(s.id).toBe('s1');
    expect(s.status).toBe('stopped');
    expect(s.type).toBe('vscode');
    expect(s.port).toBe(8000);
  });

  it('auto-assigns a pathPrefix when none is given', () => {
    const mgr = new SessionManager();
    const s = mgr.register(makeConfig());
    expect(s.pathPrefix).toBe('/_session/s1');
  });

  it('preserves an explicit pathPrefix', () => {
    const mgr = new SessionManager();
    const cfg = buildBackendConfig({ type: 'vscode', port: 9000, pathPrefix: '/my/prefix' });
    const s = mgr.register(cfg);
    expect(s.pathPrefix).toBe('/my/prefix');
  });

  it('assigns incrementing IDs across multiple registrations', () => {
    const mgr = new SessionManager();
    const s1 = mgr.register(makeConfig(8001));
    const s2 = mgr.register(makeConfig(8002));
    expect(s1.id).toBe('s1');
    expect(s2.id).toBe('s2');
  });

  it('stores the session and returns it via get()', () => {
    const mgr = new SessionManager();
    const s = mgr.register(makeConfig());
    expect(mgr.get(s.id)).toBeDefined();
    expect(mgr.get(s.id)!.id).toBe(s.id);
  });
});

// ── list ─────────────────────────────────────────────────────────────────────

describe('SessionManager.list', () => {
  it('returns an empty array when no sessions registered', () => {
    expect(new SessionManager().list()).toEqual([]);
  });

  it('returns all registered sessions', () => {
    const mgr = new SessionManager();
    mgr.register(makeConfig(8001));
    mgr.register(makeConfig(8002));
    expect(mgr.list()).toHaveLength(2);
  });
});

// ── stop ─────────────────────────────────────────────────────────────────────

describe('SessionManager.stop', () => {
  it('throws when the session ID does not exist', () => {
    const mgr = new SessionManager();
    expect(() => mgr.stop('nonexistent')).toThrow('not found');
  });

  it('sets status to stopped without a managed process', () => {
    const mgr = new SessionManager();
    const s = mgr.register(makeConfig());
    // No managed process attached — stop() should not throw.
    mgr.stop(s.id);
    expect(mgr.get(s.id)!.status).toBe('stopped');
  });
});

// ── remove ───────────────────────────────────────────────────────────────────

describe('SessionManager.remove', () => {
  it('returns false for unknown session', () => {
    const mgr = new SessionManager();
    expect(mgr.remove('ghost')).toBe(false);
  });

  it('removes the session from the list', () => {
    const mgr = new SessionManager();
    const s = mgr.register(makeConfig());
    expect(mgr.remove(s.id)).toBe(true);
    expect(mgr.get(s.id)).toBeUndefined();
    expect(mgr.list()).toHaveLength(0);
  });
});

// ── stopAll ──────────────────────────────────────────────────────────────────

describe('SessionManager.stopAll', () => {
  it('does not throw when there are no sessions', () => {
    expect(() => new SessionManager().stopAll()).not.toThrow();
  });

  it('stops all sessions with managed processes attached', () => {
    const mgr = new SessionManager();
    const s1 = mgr.register(makeConfig(8001));
    const s2 = mgr.register(makeConfig(8002));

    // Attach fake managed process handles.
    const stop1 = jest.fn();
    const stop2 = jest.fn();
    mgr.get(s1.id)!.managed = { stop: stop1 } as never;
    mgr.get(s2.id)!.managed = { stop: stop2 } as never;

    mgr.stopAll();
    expect(stop1).toHaveBeenCalled();
    expect(stop2).toHaveBeenCalled();
  });
});

// ── toJSON ───────────────────────────────────────────────────────────────────

describe('SessionManager.toJSON', () => {
  it('returns serialisable info objects (no ChildProcess handles)', () => {
    const mgr = new SessionManager();
    mgr.register(makeConfig(8001));
    mgr.register(makeConfig(8002));

    const info = mgr.toJSON();
    expect(info).toHaveLength(2);
    for (const item of info) {
      expect(item).not.toHaveProperty('managed');
      expect(item).not.toHaveProperty('config');
      expect(typeof item.id).toBe('string');
      expect(typeof item.status).toBe('string');
    }
  });

  it('omits undefined optional fields', () => {
    const mgr = new SessionManager();
    mgr.register(makeConfig());
    const [info] = mgr.toJSON();
    expect(info).not.toHaveProperty('pid');
    expect(info).not.toHaveProperty('startedAt');
    expect(info).not.toHaveProperty('errorMessage');
  });

  it('includes accessKey for leduoPatrol sessions', () => {
    const mgr = new SessionManager();
    mgr.register(buildBackendConfig({ type: 'leduoPatrol', accessKey: 'fixed-key' }));
    const [info] = mgr.toJSON();
    expect(info.accessKey).toBe('fixed-key');
  });
});

// ── launch (error path only — no real process spawned) ───────────────────────

describe('SessionManager.launch — port conflict', () => {
  it('rejects with a clear error when another running session uses the same port', async () => {
    const mgr = new SessionManager();
    // s1 on port 8000, manually marked as running (simulates an active backend).
    const s1 = mgr.register(makeConfig(8000));
    s1.status = 'running';

    // s2 on the same port — launch should be rejected immediately, before any
    // real process is spawned.
    const s2 = mgr.register(makeConfig(8000));

    await expect(mgr.launch(s2.id)).rejects.toThrow(/port 8000.*already in use.*s1/i);
    // The conflicting session must be marked as error so the UI can report it.
    expect(mgr.get(s2.id)!.status).toBe('error');
    expect(mgr.get(s2.id)!.errorMessage).toMatch(/port 8000/i);
  });

  it('does not reject when two sessions use different ports', async () => {
    jest.resetModules();
    jest.mock('../src/backends', () => ({
      ...jest.requireActual('../src/backends'),
      startBackend: (cfg: import('../src/config').BackendConfig) =>
        Promise.resolve({
          process: { pid: 9999, killed: false, on: () => ({}) } as never,
          config: cfg,
          waitForExit: () => new Promise(() => { /* never */ }),
          stop: () => { /* noop */ },
        }),
    }));
    const { SessionManager: SM, _resetCounter: rc } = await import('../src/session');
    rc();
    const mgr = new SM();
    const s1 = mgr.register(makeConfig(8000));
    s1.status = 'running';
    const cfg2 = (await import('../src/config')).buildBackendConfig({ type: 'vscode', host: '127.0.0.1', port: 8001 });
    const s2 = mgr.register(cfg2);

    // Different port — should not throw a port-conflict error.
    await expect(mgr.launch(s2.id)).resolves.toBeUndefined();

    jest.resetModules();
    jest.restoreAllMocks();
  });
});

// ── persistence ──────────────────────────────────────────────────────────────

describe('SessionManager persistence', () => {
  let tmpDir: string;
  let savePath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'lvst-test-'));
    savePath = nodePath.join(tmpDir, 'sessions.json');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('saves sessions to disk on register', () => {
    const mgr = new SessionManager();
    mgr.setSavePath(savePath);
    mgr.register(makeConfig(9001));
    expect(fs.existsSync(savePath)).toBe(true);
    const data = JSON.parse(fs.readFileSync(savePath, 'utf-8'));
    expect(data).toHaveLength(1);
    expect(data[0].config.port).toBe(9001);
  });

  it('restores sessions from disk', () => {
    // Save from one manager
    const mgr1 = new SessionManager();
    mgr1.setSavePath(savePath);
    mgr1.register(makeConfig(9001));
    mgr1.register(makeConfig(9002));

    // Restore into a fresh manager
    _resetCounter();
    const mgr2 = new SessionManager();
    mgr2.setSavePath(savePath);
    const restored = mgr2.restore();
    expect(restored).toBe(2);
    expect(mgr2.list()).toHaveLength(2);
    expect(mgr2.list()[0].port).toBe(9001);
    expect(mgr2.list()[1].port).toBe(9002);
    expect(mgr2.list()[0].status).toBe('stopped');
  });

  it('skips duplicate sessions on restore', () => {
    // Save one session
    const mgr1 = new SessionManager();
    mgr1.setSavePath(savePath);
    mgr1.register(makeConfig(9001));

    // Pre-register the same type+host+port then restore
    _resetCounter();
    const mgr2 = new SessionManager();
    mgr2.setSavePath(savePath);
    mgr2.register(makeConfig(9001));
    const restored = mgr2.restore();
    expect(restored).toBe(0);
    expect(mgr2.list()).toHaveLength(1); // no duplicate
  });

  it('removes session from persistence on remove()', () => {
    const mgr = new SessionManager();
    mgr.setSavePath(savePath);
    const s = mgr.register(makeConfig(9001));
    mgr.register(makeConfig(9002));
    mgr.remove(s.id);
    const data = JSON.parse(fs.readFileSync(savePath, 'utf-8'));
    expect(data).toHaveLength(1);
    expect(data[0].config.port).toBe(9002);
  });

  it('returns 0 when save file does not exist', () => {
    const mgr = new SessionManager();
    mgr.setSavePath(nodePath.join(tmpDir, 'nonexistent.json'));
    expect(mgr.restore()).toBe(0);
  });

  it('returns 0 when save file contains invalid JSON', () => {
    fs.writeFileSync(savePath, '{{not json}}', 'utf-8');
    const mgr = new SessionManager();
    mgr.setSavePath(savePath);
    expect(mgr.restore()).toBe(0);
  });

  it('does not save when no savePath is set', () => {
    const mgr = new SessionManager();
    mgr.register(makeConfig(9001));
    expect(fs.existsSync(savePath)).toBe(false);
  });
});

describe('SessionManager.launch (mocked spawn)', () => {
  it('throws when the session ID does not exist', async () => {
    const mgr = new SessionManager();
    await expect(mgr.launch('ghost')).rejects.toThrow('not found');
  });

  it('sets status to error when startBackend rejects', async () => {
    // Override startBackend via module mocking (now async — return rejected promise).
    jest.resetModules();
    jest.mock('../src/backends', () => ({
      ...jest.requireActual('../src/backends'),
      startBackend: () => Promise.reject(new Error('spawn failed')),
    }));
    const { SessionManager: SM, _resetCounter: rc } = await import('../src/session');
    rc();
    const mgr = new SM();
    const cfg = buildBackendConfig({ type: 'vscode', port: 8000 });
    const s = mgr.register(cfg);

    await expect(mgr.launch(s.id)).rejects.toThrow('spawn failed');
    expect(mgr.get(s.id)!.status).toBe('error');
    expect(mgr.get(s.id)!.errorMessage).toBe('spawn failed');

    jest.resetModules();
    jest.restoreAllMocks();
  });

  it('launch(id, folder) stores the folder override on the session', async () => {
    jest.resetModules();
    jest.mock('../src/backends', () => ({
      ...jest.requireActual('../src/backends'),
      startBackend: (cfg: import('../src/config').BackendConfig) =>
        Promise.resolve({
          process: { pid: 1234, killed: false, on: () => ({}) } as never,
          config: cfg,
          waitForExit: () => new Promise(() => { /* never resolves in test */ }),
          stop: () => { /* noop */ },
        }),
    }));
    const { SessionManager: SM, _resetCounter: rc } = await import('../src/session');
    rc();
    const mgr = new SM();
    const cfg = buildBackendConfig({ type: 'vscode', port: 8000 });
    const s = mgr.register(cfg);

    await mgr.launch(s.id, '/home/user/project');

    const info = mgr.get(s.id)!;
    expect(info.folder).toBe('/home/user/project');
    expect(info.config.folder).toBe('/home/user/project');
    expect(info.status).toBe('running');

    jest.resetModules();
    jest.restoreAllMocks();
  });
});
