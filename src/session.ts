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
    };
    this._sessions.set(id, session);
    return session;
  }

  /**
   * Launches (spawns) the backend process for the given session ID.
   * The session transitions: stopped → starting → running.
   *
   * @throws If the session is not found.
   */
  async launch(id: string): Promise<void> {
    const session = this._sessions.get(id);
    if (!session) throw new Error(`Session ${id} not found.`);

    session.status = 'starting';
    session.errorMessage = undefined;

    try {
      const managed = startBackend(session.config);
      session.managed = managed;
      session.pid = managed.process.pid;
      session.startedAt = new Date().toISOString();
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
    return info;
  }
}
