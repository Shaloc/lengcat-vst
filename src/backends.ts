/**
 * Backend process management for VS Code server variants.
 *
 * For `type === 'vscode'` the backend is always started via the managed
 * code-server binary (installed by ensureCodeServer from download.ts).
 * For `type === 'custom'` the caller-supplied executable is used.
 */

import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import { ChildProcess, spawn } from 'child_process';
import { BackendConfig, BackendType } from './config';
import { ensureCodeServer } from './download';

/** Executable names (on PATH) for each supported backend type. */
const EXECUTABLES: Record<BackendType, string> = {
  vscode: 'code',  // kept for resolveExecutable; startBackend uses ensureCodeServer
  custom: '',      // resolved from BackendConfig.executable
};

/**
 * Grace time passed to VS Code's built-in `serve-web --connection-grace-time`.
 * Set to a very large value (~115 days) so the server does NOT auto-exit when
 * all browser tabs are closed.  Background tasks (AI agents, terminals) continue
 * running until the session is explicitly stopped via the dashboard.
 *
 * NOTE: code-server (coder/code-server) uses a different flag:
 *       `--idle-timeout-seconds 0` (see buildCodeServerArgs).
 */
const VSCODE_CONNECTION_GRACE_TIME_SECONDS = 9999999; // ~115 days

/** Result of resolving the executable path for a backend. */
export interface BackendExecutable {
  /** The resolved command/executable. */
  command: string;
  /** CLI arguments to pass to the command to start serve-web. */
  args: string[];
}

/**
 * Resolves the executable and default CLI args needed to start a given
 * backend in serve-web mode.
 *
 * When `config.extensionHostOnly` is true the `serve-web` subcommand is
 * omitted — the binary is already the VS Code server and does not accept
 * that subcommand.
 *
 * Note: for `type === 'vscode'`, `startBackend` bypasses this function and
 * uses the managed code-server binary instead.  This function is primarily
 * used for `type === 'custom'`.
 */
export function resolveExecutable(config: BackendConfig): BackendExecutable {
  let command: string;
  if (config.type === 'custom') {
    if (!config.executable) {
      throw new Error(
        'BackendConfig.executable must be set when type is "custom".'
      );
    }
    command = config.executable;
  } else {
    command = EXECUTABLES[config.type];
  }

  // Extension-host-only servers (e.g. ~/.vscode-server binary installed by
  // Remote SSH) are already the server; they do not accept a 'serve-web'
  // subcommand.
  const args: string[] = config.extensionHostOnly ? [] : ['serve-web'];

  args.push(
    '--host', config.host === 'localhost' ? '127.0.0.1' : config.host,
    '--port', String(config.port),
  );

  if (config.pathPrefix) {
    args.push('--server-base-path', config.pathPrefix);
  }

  if (config.tokenSource === 'fixed' && config.token) {
    args.push('--connection-token', config.token);
  } else {
    args.push('--without-connection-token');
  }

  // Prevent VS Code's serve-web from shutting down when the last browser
  // client disconnects.  By default VS Code's serve-web exits after a grace
  // period (--connection-grace-time) once all tabs are closed, which would
  // kill background tasks such as AI agents and running terminals.  Setting
  // this to a very large value (VSCODE_CONNECTION_GRACE_TIME_SECONDS, ~115
  // days) effectively keeps the server alive until it is explicitly stopped
  // via the dashboard.
  // NOTE: this flag is specific to VS Code's built-in serve-web subcommand.
  //       code-server (coder/code-server) uses --idle-timeout-seconds instead;
  //       that is handled in buildCodeServerArgs() below.
  if (!config.extensionHostOnly) {
    args.push('--connection-grace-time', String(VSCODE_CONNECTION_GRACE_TIME_SECONDS));
  }

  return { command, args };
}

/**
 * Builds the CLI arguments for starting code-server (from
 * https://github.com/coder/code-server) with the settings from `config`.
 *
 * code-server uses a different argument format from VS Code's `serve-web`:
 *   --bind-addr HOST:PORT  (combined, not separate --host / --port)
 *   --auth none            (instead of --without-connection-token)
 *   --base-path PREFIX     (instead of --server-base-path)
 */
export function buildCodeServerArgs(config: BackendConfig): string[] {
  const host = config.host === 'localhost' ? '127.0.0.1' : config.host;
  // Use the standard VS Code server user-data directory ($HOME/.vscode-server/data)
  // so that settings, keybindings and cached state from existing VS Code Remote
  // installations are immediately available to all sessions.
  const userDataDir = path.join(os.homedir(), '.vscode-server', 'data');
  const args: string[] = [
    '--bind-addr', `${host}:${config.port}`,
    '--auth', 'none',
    '--user-data-dir', userDataDir,
    // Disable code-server's idle timeout so it does NOT exit when all browser
    // tabs are closed.  This keeps AI agents, terminals, and background tasks
    // alive in VS Code even when no browser window is open.
    // code-server's --idle-timeout-seconds differs from VS Code serve-web's
    // --connection-grace-time; setting it to 0 disables the timeout entirely.
    '--idle-timeout-seconds', '0',
  ];
  // Note: code-server does not support a --base-path / --server-base-path flag.
  // Path prefix routing is handled by the lengcat-vst proxy, which strips the
  // prefix before forwarding requests to code-server (see server.ts).
  return args;
}

/** A running managed backend process. */
export interface ManagedBackend {
  process: ChildProcess;
  config: BackendConfig;
  /** Resolves when the process has exited. */
  waitForExit: () => Promise<number | null>;
  /** Terminates the managed process gracefully. */
  stop: () => void;
}

/**
 * Attempts to spawn `command` with `args` and waits for the OS-level
 * 'spawn' event (success) or 'error' event (e.g. ENOENT).
 *
 * Returns the ManagedBackend on success, or throws on failure.
 * A permanent 'error' listener is attached so post-spawn errors never
 * become unhandled events that would crash the Node.js process.
 */
async function trySpawn(
  command: string,
  args: string[],
  config: BackendConfig,
  cwd?: string
): Promise<ManagedBackend> {
  const proc = spawn(command, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
    ...(cwd !== undefined ? { cwd } : {}),
  });

  // Wait for either successful spawn or an immediate error (e.g. ENOENT).
  await new Promise<void>((resolve, reject) => {
    const onSpawn = (): void => {
      proc.removeListener('error', onError);
      // Attach a permanent listener so any post-spawn errors (e.g. the
      // process crashes later) are absorbed rather than crashing us.
      // Log to stderr so operators can diagnose unexpected process failures.
      proc.on('error', (err: Error) => {
        process.stderr.write(
          `[lengcat-vst] backend process error (${config.type}): ${err.message}\n`
        );
      });
      resolve();
    };
    const onError = (err: Error): void => {
      proc.removeListener('spawn', onSpawn);
      reject(err);
    };
    proc.once('spawn', onSpawn);
    proc.once('error', onError);
  });

  const exitPromise = new Promise<number | null>((resolve) => {
    proc.on('exit', (code) => resolve(code));
  });

  return {
    process: proc,
    config,
    waitForExit: () => exitPromise,
    stop() {
      if (!proc.killed) {
        proc.kill('SIGTERM');
      }
    },
  };
}

/**
 * Minimal HTTP GET that resolves with the response status code.
 * Used for backend readiness polling.
 */
function httpGet(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      res.resume(); // drain the response body
      resolve(res.statusCode ?? 0);
    }).on('error', reject);
  });
}

/**
 * Polls the backend's HTTP endpoint until it responds or the process exits.
 *
 * VS Code takes a few seconds to start accepting connections after the
 * process spawns.  This function bridges that gap so callers can be sure
 * the backend is ready before routing traffic to it.
 *
 * @throws When the process exits before becoming ready, or when the timeout
 *         elapses without a successful HTTP response.
 */
async function waitForBackendReady(
  managed: ManagedBackend,
  timeoutMs = 30_000
): Promise<void> {
  // resolveExecutable normalises 'localhost' → '127.0.0.1' when building
  // the spawn args, so we check the same address the backend is bound to.
  const { host, port } = managed.config;
  const checkHost = host === 'localhost' ? '127.0.0.1' : host;
  const url = `http://${checkHost}:${port}/`;

  const deadline = Date.now() + timeoutMs;
  let processExited = false;

  // Detect early process exit so we fail fast instead of waiting the full timeout.
  managed.waitForExit().then(() => {
    processExited = true;
  }).catch(() => {
    processExited = true;
  });

  while (Date.now() < deadline) {
    if (processExited) {
      throw new Error(
        `Backend process (${managed.config.type}) exited before becoming ready to accept connections.`
      );
    }
    try {
      await httpGet(url);
      return; // Backend is responsive.
    } catch {
      // Not ready yet — wait a short interval before retrying.
      await new Promise<void>((r) => setTimeout(r, 500));
    }
  }

  throw new Error(
    `Backend at ${url} did not become ready within ${timeoutMs / 1000}s.`
  );
}

/**
 * Spawns a backend process for the given configuration.
 *
 * For `type === 'vscode'`:
 *   Uses the managed code-server binary (https://github.com/coder/code-server).
 *   The binary is installed on demand via `ensureCodeServer` the first time
 *   it is needed and cached in ~/.lengcat-vst/code-server/ thereafter.
 *
 * For `type === 'custom'`:
 *   Uses the caller-supplied executable path via `resolveExecutable`.
 *
 * The function only resolves once the backend is confirmed to be accepting
 * HTTP connections (readiness poll with a 30 s timeout).
 *
 * @returns A Promise that resolves to a ManagedBackend handle.
 * @throws  When the binary cannot be started or the backend doesn't become
 *          ready in time.
 */
export async function startBackend(config: BackendConfig): Promise<ManagedBackend> {
  if (config.type === 'vscode') {
    // Always use the managed code-server binary for VS Code.
    const binPath = await ensureCodeServer((msg) => {
      process.stderr.write(`[lengcat-vst] ${msg}\n`);
    });
    const args = buildCodeServerArgs(config);
    const managed = await trySpawn(binPath, args, config);
    await waitForBackendReady(managed);
    return managed;
  }

  // type === 'custom': use the caller-configured executable.
  const { command, args } = resolveExecutable(config);
  const managed = await trySpawn(command, args, config);
  await waitForBackendReady(managed);
  return managed;
}

/**
 * Returns the backend origin URL (e.g. "http://localhost:8000") for the
 * given config.
 */
export function backendOrigin(config: BackendConfig): string {
  const scheme = config.tls ? 'https' : 'http';
  return `${scheme}://${config.host}:${config.port}`;
}
