/**
 * Backend process management for different VS Code server variants.
 *
 * This module knows how to detect and optionally start a backend VS Code
 * serve-web process for each supported variant type.
 */

import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { ChildProcess, spawn } from 'child_process';
import { BackendConfig, BackendType } from './config';
import { ensureDownloadedServer } from './download';

/** Executable names (on PATH) for each supported backend type. */
const EXECUTABLES: Record<BackendType, string> = {
  vscode: 'code',
  vscodium: 'codium',
  lingma: 'lingma',
  qoder: 'qoder',
  custom: '', // resolved from BackendConfig.executable
};

/** Result of resolving the executable path for a backend. */
export interface BackendExecutable {
  /** The resolved command/executable. */
  command: string;
  /** CLI arguments to pass to the command to start serve-web. */
  args: string[];
}

/**
 * Searches for a VS Code-flavour server binary installed in the user's home
 * directory by the Remote-SSH extension (or a VSCodium equivalent).
 *
 * Checked locations, newest-first:
 *  - ~/.vscode-server/cli/servers/Stable-<hash>/server/bin/code-server
 *  - ~/.vscode-server/bin/<hash>/bin/code-server  (legacy Remote-SSH layout)
 *
 * Returns `undefined` when nothing is found.
 */
export function findServerBinaryInHomeDir(
  type: 'vscode' | 'vscodium'
): string | undefined {
  const serverDirName =
    type === 'vscode' ? '.vscode-server' : '.vscodium-server';
  const serverRoot = path.join(os.homedir(), serverDirName);
  const binName = type === 'vscode' ? 'code-server' : 'codium-server';

  // CLI-style install (newer): Stable-<hash>/server/bin/<binName>
  const cliServersDir = path.join(serverRoot, 'cli', 'servers');
  if (fs.existsSync(cliServersDir)) {
    try {
      const entries = fs
        .readdirSync(cliServersDir)
        .filter((e) => /^Stable-/.test(e))
        .sort()
        .reverse();
      for (const entry of entries) {
        const candidate = path.join(
          cliServersDir,
          entry,
          'server',
          'bin',
          binName
        );
        if (fs.existsSync(candidate)) return candidate;
      }
    } catch {
      /* directory not readable – skip */
    }
  }

  // Legacy Remote-SSH style: bin/<hash>/bin/<binName>
  const legacyBinDir = path.join(serverRoot, 'bin');
  if (fs.existsSync(legacyBinDir)) {
    try {
      const entries = fs.readdirSync(legacyBinDir).sort().reverse();
      for (const entry of entries) {
        const candidate = path.join(legacyBinDir, entry, 'bin', binName);
        if (fs.existsSync(candidate)) return candidate;
      }
    } catch {
      /* directory not readable – skip */
    }
  }

  return undefined;
}

/**
 * Resolves the executable and default CLI args needed to start a given
 * backend in serve-web mode.
 *
 * When `config.extensionHostOnly` is true the `serve-web` subcommand is
 * omitted — the binary is already the VS Code server (e.g. a
 * `~/.vscode-server` Remote-SSH installation) and does not accept that
 * subcommand.
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

  return { command, args };
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
 * Spawns a backend VS Code serve-web process for the given configuration.
 *
 * Fallback chain (for vscode / vscodium types on ENOENT):
 *   1. Primary executable on PATH (or BackendConfig.executable).
 *   2. Server binary installed by Remote-SSH in ~/.vscode-server /
 *      ~/.vscodium-server.
 *   3. Automatically downloads the VS Code server bundled in the code-server
 *      npm package (~49 MB, cached in $TMPDIR/lengcat-vst-vscode-server).
 *
 * The function only resolves once the backend is confirmed to be accepting
 * HTTP connections (readiness poll with a 30 s timeout).
 *
 * @returns A Promise that resolves to a ManagedBackend handle.
 * @throws  When no working executable can be found or the backend doesn't
 *          become ready in time.
 */
export async function startBackend(config: BackendConfig): Promise<ManagedBackend> {
  const { command, args } = resolveExecutable(config);

  try {
    const managed = await trySpawn(command, args, config);
    await waitForBackendReady(managed);
    return managed;
  } catch (primaryErr) {
    const errnoErr = primaryErr as NodeJS.ErrnoException;

    // On ENOENT for known types, try home-directory server binaries.
    // These binaries don't use the 'serve-web' subcommand, so re-resolve
    // with extensionHostOnly: true to get the right arg list.
    if (
      errnoErr.code === 'ENOENT' &&
      (config.type === 'vscode' || config.type === 'vscodium')
    ) {
      const fallbackBin = findServerBinaryInHomeDir(config.type);
      if (fallbackBin) {
        const fallbackConfig: BackendConfig = { ...config, extensionHostOnly: true };
        const { args: fallbackArgs } = resolveExecutable(fallbackConfig);
        const managed = await trySpawn(fallbackBin, fallbackArgs, fallbackConfig);
        await waitForBackendReady(managed);
        return managed;
      }

      // ── Final fallback: auto-download the VS Code server ──────────────────
      // Neither the primary binary nor any home-directory installation was
      // found.  Download the VS Code server bundled inside the code-server
      // npm package and run it via Node.js.
      const { entryPoint, cwd } = await ensureDownloadedServer();
      const downloadedConfig: BackendConfig = { ...config, extensionHostOnly: true };
      const { args: downloadedArgs } = resolveExecutable(downloadedConfig);
      // code-server's bundled VS Code server requires this flag.
      downloadedArgs.push('--accept-server-license-terms');
      const managed = await trySpawn(
        process.execPath,               // run with the current Node.js binary
        [entryPoint, ...downloadedArgs],
        downloadedConfig,
        cwd
      );
      await waitForBackendReady(managed);
      return managed;
    }

    throw primaryErr;
  }
}

/**
 * Returns the backend origin URL (e.g. "http://localhost:8000") for the
 * given config.
 */
export function backendOrigin(config: BackendConfig): string {
  const scheme = config.tls ? 'https' : 'http';
  return `${scheme}://${config.host}:${config.port}`;
}
