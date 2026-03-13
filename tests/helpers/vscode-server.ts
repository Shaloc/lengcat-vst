/**
 * Helper that installs and manages code-server instances
 * (from https://github.com/coder/code-server) for integration testing.
 *
 * Uses the same binary that lengcat-vst manages in production via
 * src/download.ts, so these tests exercise the real production path:
 *   ensureCodeServer() → code-server binary → VS Code web UI
 *
 * Each instance gets its own temporary user-data-dir and extensions-dir so
 * concurrent test instances do not share VS Code state or conflict with the
 * developer's own settings.
 */

import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { spawn, ChildProcess } from 'child_process';
import { ensureCodeServer } from '../../src/download';

/**
 * Ensures the code-server binary is installed and returns its path.
 *
 * Delegates to ensureCodeServer() from src/download.ts which downloads the
 * binary from GitHub Releases on the first call and caches it in
 * ~/.lengcat-vst/code-server/ so subsequent calls return instantly.
 */
export async function ensureVSCodeServer(): Promise<string> {
  return ensureCodeServer((msg) => process.stderr.write(`[test]${msg}\n`));
}

/** Options for starting a code-server instance. */
export interface VSCodeServerOptions {
  /** The TCP port to listen on. */
  port: number;
  /**
   * Optional URL base path (e.g. '/instance/1').
   * Passed as --base-path; the UI is available at <host>:<port><basePath>/.
   */
  basePath?: string;
}

/** A running code-server instance returned by `startVSCodeServer`. */
export interface VSCodeServerInstance {
  port: number;
  basePath?: string;
  /** The URL at which the VS Code web UI is reachable directly (not via proxy). */
  url: string;
  /** Terminate the server process and remove its temp directories. */
  stop(): void;
}

/**
 * Starts a code-server instance and waits until it is ready to accept
 * HTTP connections.
 *
 * Requires that `ensureVSCodeServer()` has been called before this function
 * is invoked.
 */
export async function startVSCodeServer(
  options: VSCodeServerOptions
): Promise<VSCodeServerInstance> {
  const { port, basePath } = options;

  const binPath = await ensureCodeServer();

  // Per-instance isolated directories so tests do not share VS Code state
  // and do not interfere with the developer's own settings.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `cs-test-${port}-`));

  const args: string[] = [
    '--bind-addr', `127.0.0.1:${port}`,
    '--auth', 'none',
    '--user-data-dir', path.join(tmpDir, 'data'),
    '--extensions-dir', path.join(tmpDir, 'extensions'),
  ];
  // Note: code-server has no --base-path / --server-base-path flag.
  // Path prefix routing is handled by the lengcat-vst proxy (prefix stripping).

  const proc: ChildProcess = spawn(binPath, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  proc.on('error', (err) => {
    console.error(`[code-server:${port}] spawn error:`, err);
  });

  const rootUrl = `http://127.0.0.1:${port}`;
  // code-server can take longer on first run (initialising user-data-dir).
  await waitForHTTP(rootUrl, 30_000);

  const uiUrl = basePath ? `${rootUrl}${basePath}/` : `${rootUrl}/`;

  return {
    port,
    basePath,
    url: uiUrl,
    stop() {
      if (!proc.killed) {
        proc.kill('SIGTERM');
      }
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch { /* ignore */ }
    },
  };
}

/** Polls an HTTP endpoint until it responds (any status) or the timeout elapses. */
async function waitForHTTP(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: Error | undefined;

  while (Date.now() < deadline) {
    try {
      await httpGet(url);
      return;
    } catch (err) {
      lastErr = err as Error;
      await new Promise<void>((r) => setTimeout(r, 300));
    }
  }

  throw new Error(
    `code-server at ${url} did not become ready within ${timeoutMs}ms. ` +
    `Last error: ${lastErr?.message}`
  );
}

/** Minimal HTTP GET that resolves with the response status code. */
function httpGet(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    }).on('error', reject);
  });
}
