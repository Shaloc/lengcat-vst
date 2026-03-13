/**
 * Backend process management for different VS Code server variants.
 *
 * This module knows how to detect and optionally start a backend VS Code
 * serve-web process for each supported variant type.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ChildProcess, spawn } from 'child_process';
import { BackendConfig, BackendType } from './config';

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

  const args = [
    'serve-web',
    '--host', config.host === 'localhost' ? '127.0.0.1' : config.host,
    '--port', String(config.port),
  ];

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
  config: BackendConfig
): Promise<ManagedBackend> {
  const proc = spawn(command, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });

  // Wait for either successful spawn or an immediate error (e.g. ENOENT).
  await new Promise<void>((resolve, reject) => {
    const onSpawn = (): void => {
      proc.removeListener('error', onError);
      // Attach a permanent listener so any post-spawn errors (e.g. the
      // process crashes later) are absorbed rather than crashing us.
      proc.on('error', () => { /* absorbed */ });
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
 * Spawns a backend VS Code serve-web process for the given configuration.
 *
 * If the primary executable (from PATH or BackendConfig.executable) is not
 * found, the function automatically falls back to server binaries installed
 * in the user's home directory (~/.vscode-server or ~/.vscodium-server).
 * Server binaries do not need the 'serve-web' subcommand.
 *
 * @returns A Promise that resolves to a ManagedBackend handle.
 * @throws  When no working executable can be found.
 */
export async function startBackend(config: BackendConfig): Promise<ManagedBackend> {
  const { command, args } = resolveExecutable(config);

  try {
    return await trySpawn(command, args, config);
  } catch (primaryErr) {
    const errnoErr = primaryErr as NodeJS.ErrnoException;

    // On ENOENT for known types, try home-directory server binaries.
    if (
      errnoErr.code === 'ENOENT' &&
      (config.type === 'vscode' || config.type === 'vscodium')
    ) {
      const fallbackBin = findServerBinaryInHomeDir(config.type);
      if (fallbackBin) {
        // Server binaries are already the server; they don't take 'serve-web'.
        const fallbackArgs = args.slice(1); // drop 'serve-web'
        return trySpawn(fallbackBin, fallbackArgs, config);
      }
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
