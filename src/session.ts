/**
 * Session management for the lengcat-vst tunnel proxy.
 *
 * A "session" represents a single VS Code serve-web backend instance.
 * Sessions can be:
 *   - "external"  — the backend was started by the user; we just proxy it.
 *   - "managed"   — the backend is started and stopped by the SessionManager.
 *
 * When the proxy is started with --launch, each configured backend is
 * registered as a managed session and launched automatically.  The web
 * dashboard (/_ui/) can also create new managed sessions at runtime.
 */

import { EventEmitter } from 'events';
import { BackendConfig, BackendType } from './config';
import { startBackend, ManagedBackend } from './backends';

export type SessionStatus = 'stopped' | 'starting' | 'running' | 'error';

/** Public session data (safe to serialise to JSON). */
export interface SessionInfo {
  id: string;
  type: BackendType;
  host: string;
  port: number;
  pathPrefix: string;
  status: SessionStatus;
  pid?: number;
  startedAt?: string;
  errorMessage?: string;
  /** Workspace / folder path to open in VS Code (shown as a query param in the iframe URL). */
  folder?: string;
  /**
   * True when the backend is an extension-host-only server (e.g. a Remote-SSH
   * installation) that does not require the `serve-web` subcommand.
   */
  extensionHostOnly?: boolean;
  /** Access key used by leduo-patrol for authenticated HTTP/WS requests. */
  accessKey?: string;
}

/** Internal session record (includes the live process handle). */
export interface Session extends SessionInfo {
  config: BackendConfig;
  managed?: ManagedBackend;
}

let _counter = 0;
/** Reset the session counter (test helper). */
export function _resetCounter(): void {
  _counter = 0;
}

/**
 * Manages a collection of VS Code serve-web sessions.
 *
 * Emits:
 *   'stopped' (session: SessionInfo) — when a managed process exits.
 */
export class SessionManager extends EventEmitter {
  private readonly _sessions = new Map<string, Session>();

  /**
   * Registers a backend config as a new session.
   * The session is initially `stopped`; call `launch()` to start it.
   *
   * If the config does not have a `pathPrefix`, one is auto-assigned using
   * the session ID (e.g. `/_session/s1`).
   *
   * @returns The newly created Session record.
   */
  register(config: BackendConfig): Session {
    const id = `s${++_counter}`;
    const pathPrefix = config.pathPrefix ?? `/_session/${id}`;
    const resolvedConfig: BackendConfig = { ...config, pathPrefix };

    const session: Session = {
      id,
      config: resolvedConfig,
      type: resolvedConfig.type,
      host: resolvedConfig.host,
      port: resolvedConfig.port,
      pathPrefix,
      status: 'stopped',
      folder: resolvedConfig.folder,
      extensionHostOnly: resolvedConfig.extensionHostOnly,
      accessKey: resolvedConfig.accessKey,
    };
    this._sessions.set(id, session);
    return session;
  }

  /**
   * Launches (spawns) the backend process for the given session ID.
   * The session transitions: stopped → starting → running.
   *
   * @param id     Session ID to launch.
   * @param folder Optional workspace/folder path to open.  When supplied it
   *               overrides the folder stored in the session config so that
   *               every launch can open a different directory without having
   *               to create a new session.
   * @throws If the session is not found, the port is already in use by another
   *         running session, or if the backend process cannot be started.
   */
  async launch(id: string, folder?: string): Promise<void> {
    const session = this._sessions.get(id);
    if (!session) throw new Error(`Session ${id} not found.`);

    // Guard against port reuse: if another session is already running on the
    // same host:port the new code-server would fail to bind with EADDRINUSE.
    // Catch this early and surface a meaningful error instead of letting the
    // backend process exit silently.
    for (const other of this._sessions.values()) {
      if (
        other.id !== id &&
        other.status === 'running' &&
        other.host === session.host &&
        other.port === session.port
      ) {
        const msg =
          `Port ${session.port} is already in use by session ${other.id}. ` +
          `Choose a different port or stop session ${other.id} first.`;
        session.status = 'error';
        session.errorMessage = msg;
        throw new Error(msg);
      }
    }

    // Apply the folder override (or keep whatever was previously set).
    if (folder !== undefined) {
      session.folder = folder || undefined;
      session.config = { ...session.config, folder: folder || undefined };
    }

    session.status = 'starting';
    session.errorMessage = undefined;

    try {
      const managed = await startBackend(session.config);
      session.managed = managed;
      session.pid = managed.process.pid;
      session.startedAt = new Date().toISOString();
      // For leduoPatrol with LEDUO_PATROL_WEB_PORT, startBackend resolves a
      // different proxy-target port (the Vite web-server port) than the initial
      // config.port (the backend API port).  Sync the session record so the
      // proxy routes traffic to the correct port.
      if (managed.config.port !== session.config.port) {
        session.config = { ...session.config, port: managed.config.port };
        session.port = managed.config.port;
      }
      session.status = 'running';

      void managed.waitForExit().then(() => {
        session.status = 'stopped';
        session.managed = undefined;
        session.pid = undefined;
        this.emit('stopped', this._toInfo(session));
      });
    } catch (err) {
      session.status = 'error';
      session.errorMessage = (err as Error).message;
      throw err;
    }
  }

  /**
   * Stops (sends SIGTERM to) the backend process for the given session ID.
   * The session transitions to `stopped`.
   *
   * @throws If the session is not found.
   */
  stop(id: string): void {
    const session = this._sessions.get(id);
    if (!session) throw new Error(`Session ${id} not found.`);
    if (session.managed) {
      session.managed.stop();
    }
    session.status = 'stopped';
  }

  /**
   * Stops the session (if running) and removes it from the manager.
   *
   * @returns `true` if the session existed; `false` otherwise.
   */
  remove(id: string): boolean {
    const session = this._sessions.get(id);
    if (!session) return false;
    if (session.managed) {
      session.managed.stop();
    }
    this._sessions.delete(id);
    return true;
  }

  /** Returns all registered sessions. */
  list(): Session[] {
    return [...this._sessions.values()];
  }

  /** Returns a single session by ID, or `undefined` if not found. */
  get(id: string): Session | undefined {
    return this._sessions.get(id);
  }

  /** Stops all managed (running) sessions. */
  stopAll(): void {
    for (const session of this._sessions.values()) {
      if (session.managed) {
        session.managed.stop();
      }
    }
  }

  /** Returns a JSON-safe array of session info objects. */
  toJSON(): SessionInfo[] {
    return this.list().map((s) => this._toInfo(s));
  }

  private _toInfo(s: Session): SessionInfo {
    const info: SessionInfo = {
      id: s.id,
      type: s.type,
      host: s.host,
      port: s.port,
      pathPrefix: s.pathPrefix,
      status: s.status,
    };
    if (s.pid !== undefined) info.pid = s.pid;
    if (s.startedAt !== undefined) info.startedAt = s.startedAt;
    if (s.errorMessage !== undefined) info.errorMessage = s.errorMessage;
    if (s.folder !== undefined) info.folder = s.folder;
    if (s.extensionHostOnly) info.extensionHostOnly = true;
    if (s.type === 'leduoPatrol' && s.config.accessKey !== undefined) {
      info.accessKey = s.config.accessKey;
    }
    return info;
  }
}
