/**
 * Helper that downloads, extracts, and manages real VS Code server instances
 * (backed by the code-server npm package) for integration testing.
 *
 * The package tarball is fetched once and cached in a temp directory so
 * subsequent test runs are fast.  All server instances are started as child
 * Node.js processes and must be stopped by calling `instance.stop()`.
 */

import * as http from 'http';
import { spawn, ChildProcess } from 'child_process';
import {
  ensureDownloadedServer,
  DOWNLOADED_SERVER_ENTRY,
  DOWNLOADED_SERVER_CWD,
} from '../../src/download';

/**
 * Ensures the VS Code server is extracted and ready to run.
 *
 * Delegates to ensureDownloadedServer() from src/download.ts which downloads
 * the code-server npm package (~49 MB) on the first call and caches the
 * result so subsequent runs are instant.
 */
export async function ensureVSCodeServer(): Promise<string> {
  await ensureDownloadedServer();
  return DOWNLOADED_SERVER_ENTRY;
}

/** Options for starting a VS Code server instance. */
export interface VSCodeServerOptions {
  /** The TCP port to listen on. */
  port: number;
  /**
   * Optional server base path (e.g. '/instance/1').
   * When set, passes --server-base-path to the server so the UI is available
   * at <host>:<port><basePath>/.
   */
  basePath?: string;
}

/** A running VS Code server instance returned by `startVSCodeServer`. */
export interface VSCodeServerInstance {
  port: number;
  basePath?: string;
  /** The URL at which the VS Code web UI is reachable. */
  url: string;
  /** Terminate the server process. */
  stop(): void;
}

/**
 * Starts a VS Code server instance and waits until it is ready to accept
 * HTTP connections.
 *
 * Requires that `ensureVSCodeServer()` has been called (and resolved) before
 * this function is invoked.
 */
export async function startVSCodeServer(
  options: VSCodeServerOptions
): Promise<VSCodeServerInstance> {
  const { port, basePath } = options;

  const args: string[] = [
    DOWNLOADED_SERVER_ENTRY,
    '--host', '127.0.0.1',
    '--port', String(port),
    '--without-connection-token',
    '--accept-server-license-terms',
  ];

  if (basePath) {
    args.push('--server-base-path', basePath);
  }

  const proc: ChildProcess = spawn(process.execPath, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: DOWNLOADED_SERVER_CWD,
  });

  // Surface fatal startup errors so tests fail with a clear message.
  proc.on('error', (err) => {
    console.error(`[vscode-server:${port}] spawn error:`, err);
  });

  const rootUrl = `http://127.0.0.1:${port}`;
  await waitForHTTP(rootUrl, 20_000);

  const uiUrl = basePath ? `${rootUrl}${basePath}` : rootUrl;

  return {
    port,
    basePath,
    url: uiUrl,
    stop() {
      if (!proc.killed) {
        proc.kill('SIGTERM');
      }
    },
  };
}

/** Polls an HTTP endpoint until it responds or the timeout elapses. */
async function waitForHTTP(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: Error | undefined;

  while (Date.now() < deadline) {
    try {
      await httpGet(url);
      return;
    } catch (err) {
      lastErr = err as Error;
      await new Promise<void>((r) => setTimeout(r, 250));
    }
  }

  throw new Error(
    `VS Code server at ${url} did not become ready within ${timeoutMs}ms. ` +
    `Last error: ${lastErr?.message}`
  );
}

/** Minimal HTTP GET that resolves with the status code. */
function httpGet(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    }).on('error', reject);
  });
}
