/**
 * Backend process management for different VS Code server variants.
 *
 * This module knows how to detect and optionally start a backend VS Code
 * serve-web process for each supported variant type.
 */

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
 * Spawns a backend VS Code serve-web process for the given configuration.
 *
 * @returns A ManagedBackend handle that wraps the child process.
 */
export function startBackend(config: BackendConfig): ManagedBackend {
  const { command, args } = resolveExecutable(config);

  const proc = spawn(command, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });

  let exitCode: number | null = null;
  const exitPromise = new Promise<number | null>((resolve) => {
    proc.on('exit', (code) => {
      exitCode = code;
      resolve(exitCode);
    });
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
 * Returns the backend origin URL (e.g. "http://localhost:8000") for the
 * given config.
 */
export function backendOrigin(config: BackendConfig): string {
  const scheme = config.tls ? 'https' : 'http';
  return `${scheme}://${config.host}:${config.port}`;
}
