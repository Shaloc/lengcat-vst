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
import * as fs from 'fs';
import { ChildProcess, spawn } from 'child_process';
import { BackendConfig, BackendType } from './config';
import { ensureCodeServer } from './download';

/**
 * Parses a `.env` file and returns its key/value pairs.
 * Lines that are empty or start with `#` are skipped.
 * Values may be wrapped in single or double quotes (which are stripped).
 * If the file does not exist an empty object is returned.
 */
export function loadDotEnv(dir: string): Record<string, string> {
  const envPath = path.join(dir, '.env');
  if (!fs.existsSync(envPath)) return {};
  const result: Record<string, string> = {};
  for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

/** Executable names (on PATH) for each supported backend type. */
const EXECUTABLES: Record<BackendType, string> = {
  vscode: 'code',  // kept for resolveExecutable; startBackend uses ensureCodeServer
  custom: '',      // resolved from BackendConfig.executable
  leduoPatrol: 'npm',
};

/**
 * Grace time passed to VS Code's built-in `serve-web --connection-grace-time`.
 * Set to the largest value that, when multiplied by 1000, still fits in a
 * 32-bit signed integer (Node.js's internal representation for setTimeout).
 * This is 2 147 483 seconds ≈ 24.8 days — effectively "never" for a dev
 * session, but without triggering a TimeoutOverflowWarning that would reset
 * the timer to 1 ms and cause an immediate idle-timeout.
 *
 * NOTE: code-server (coder/code-server) uses a different flag:
 *       `--idle-timeout-seconds` (see buildCodeServerArgs / CODE_SERVER_IDLE_TIMEOUT_SECONDS).
 */
const VSCODE_CONNECTION_GRACE_TIME_SECONDS = 2147483; // max safe (~24.8 days)

/**
 * Idle timeout passed to code-server's `--idle-timeout-seconds`.
 * Set to the largest value that, when multiplied by 1000, still fits in a
 * 32-bit signed integer (Node.js's internal representation for setTimeout).
 * This is 2 147 483 seconds ≈ 24.8 days — effectively "never" for a dev
 * session, but without triggering a TimeoutOverflowWarning that would reset
 * the timer to 1 ms and cause an immediate idle-timeout.
 * This is the code-server equivalent of VSCODE_CONNECTION_GRACE_TIME_SECONDS.
 */
const CODE_SERVER_IDLE_TIMEOUT_SECONDS = 2147483; // max safe (~24.8 days)

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
  if (config.type === 'leduoPatrol') {
    return { command: EXECUTABLES.leduoPatrol, args: ['start'] };
  }

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

  // Prevent the VS Code server from suspending the extension host when the last
  // browser client disconnects.  By default VS Code exits (or suspends
  // extension-host activity) after its built-in grace period once all tabs
  // close, which pauses AI agents, terminals, and background tasks.  Setting
  // --connection-grace-time to the max 32-bit-safe value (~24.8 days) keeps the
  // extension host fully active until the session is explicitly stopped via
  // the dashboard.  Values larger than 2 147 483 s overflow Node.js's 32-bit
  // setTimeout representation and reset the timer to 1 ms, causing immediate
  // shutdown.
  // NOTE: this flag is a VS Code *server-level* flag — it applies both when
  //       the binary runs as a serve-web server AND when it runs as an
  //       extension-host-only server (extensionHostOnly: true).
  //       code-server (coder/code-server) uses --idle-timeout-seconds instead;
  //       that is handled in buildCodeServerArgs() below.
  args.push('--connection-grace-time', String(VSCODE_CONNECTION_GRACE_TIME_SECONDS));

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
    // Set code-server's idle timeout to the max 32-bit-safe value (~24.8 days)
    // so it does NOT deactivate the extension host or exit when all browser
    // tabs are closed.  This keeps AI agents, terminals, and background tasks
    // alive in VS Code even when no browser window is open.
    // Values larger than 2 147 483 s overflow Node.js's 32-bit setTimeout
    // representation and reset the timer to 1 ms, causing immediate shutdown.
    // NOTE: setting this to 0 means "0 seconds" (immediate shutdown on idle),
    // NOT "disabled".  Use CODE_SERVER_IDLE_TIMEOUT_SECONDS for a safe large value.
    '--idle-timeout-seconds', String(CODE_SERVER_IDLE_TIMEOUT_SECONDS),
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
  /**
   * Returns all stderr output collected from the process so far (trimmed).
   * Useful for surfacing diagnostic information when the process exits
   * unexpectedly before it becomes ready to accept connections.
   */
  getStderr: () => string;
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
  cwd?: string,
  env?: NodeJS.ProcessEnv
): Promise<ManagedBackend> {
  const proc = spawn(command, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
    ...(cwd !== undefined ? { cwd } : {}),
    ...(env !== undefined ? { env } : {}),
  });

  // Collect stderr so that, if the process exits before becoming ready, the
  // output can be included in the error message to help diagnose why it failed.
  const stderrChunks: Buffer[] = [];
  if (proc.stderr) {
    proc.stderr.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk);
    });
  }
  // Drain stdout to prevent the OS pipe buffer from filling up and blocking
  // the backend process (stdout is piped but not otherwise consumed).
  if (proc.stdout) {
    proc.stdout.resume();
  }

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
    getStderr: () => Buffer.concat(stderrChunks).toString().trim(),
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
      const stderr = managed.getStderr();
      const detail = stderr ? `\nProcess output:\n${stderr}` : '';
      throw new Error(
        `Backend process (${managed.config.type}) exited before becoming ready to accept connections.${detail}`
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

  const stderr = managed.getStderr();
  const detail = stderr ? `\nProcess output:\n${stderr}` : '';
  throw new Error(
    `Backend at ${url} did not become ready within ${timeoutMs / 1000}s.${detail}`
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
  if (config.type === 'leduoPatrol') {
    const projectDir =
      process.env.LEDUO_PATROL_DIR ??
      path.join(os.homedir(), '.lengcat-vst', 'leduo-patrol');
    if (!fs.existsSync(projectDir)) {
      throw new Error(
        `leduo-patrol directory not found: ${projectDir}. ` +
        `Set LEDUO_PATROL_DIR to the cloned leduo-patrol project path.`
      );
    }
    const { command, args } = resolveExecutable(config);
    const dotEnv = loadDotEnv(projectDir);
    const env = {
      ...process.env,
      ...dotEnv,
      HOST: config.host,
      PORT: String(config.port),
      LEDUO_PATROL_ACCESS_KEY: config.accessKey || process.env.LEDUO_PATROL_ACCESS_KEY,
    };
    const managed = await trySpawn(command, args, config, projectDir, env);
    await waitForBackendReady(managed);
    return managed;
  }

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
