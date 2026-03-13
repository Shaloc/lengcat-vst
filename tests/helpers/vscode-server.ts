/**
 * Helper that downloads, extracts, and manages real VS Code server instances
 * (backed by the code-server npm package) for integration testing.
 *
 * The package tarball is fetched once and cached in a temp directory so
 * subsequent test runs are fast.  All server instances are started as child
 * Node.js processes and must be stopped by calling `instance.stop()`.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as https from 'https';
import * as http from 'http';
import { execSync, spawn, ChildProcess } from 'child_process';

/** Version of code-server whose bundled VS Code server we use for tests. */
const CODE_SERVER_VERSION = '4.111.0';
const CODE_SERVER_TARBALL_URL = `https://registry.npmjs.org/code-server/-/code-server-${CODE_SERVER_VERSION}.tgz`;

/** Persistent cache directory so we only download once per machine. */
const CACHE_DIR = path.join(os.tmpdir(), 'lengcat-vst-vscode-server');

/** Absolute path to the VS Code server's Node entry point after extraction. */
const VSCODE_SERVER_ENTRY = path.join(
  CACHE_DIR,
  'package',
  'lib',
  'vscode',
  'out',
  'server-main.js'
);

/** Working directory for the VS Code server process (must contain package.json). */
const VSCODE_SERVER_CWD = path.join(CACHE_DIR, 'package', 'lib', 'vscode');

/** Download a URL to a local file, following redirects. */
function downloadFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(dest);

    function doGet(u: string): void {
      client.get(u, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          doGet(res.headers.location as string);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`Download failed: ${res.statusCode} ${u}`));
          return;
        }
        res.pipe(file);
        file.on('finish', () => file.close(() => resolve()));
        file.on('error', reject);
      }).on('error', reject);
    }

    doGet(url);
  });
}

/**
 * Ensures the VS Code server is extracted and ready to run.
 *
 * On the first call this downloads the code-server npm package (~49 MB) from
 * the npm registry, extracts the bundled VS Code server, and installs its
 * Node.js dependencies.  Subsequent calls return immediately from the cached
 * result.
 */
export async function ensureVSCodeServer(): Promise<string> {
  if (fs.existsSync(VSCODE_SERVER_ENTRY)) {
    return VSCODE_SERVER_ENTRY;
  }

  fs.mkdirSync(CACHE_DIR, { recursive: true });

  const tarball = path.join(CACHE_DIR, 'code-server.tgz');
  if (!fs.existsSync(tarball)) {
    console.log(`[vscode-server] Downloading code-server ${CODE_SERVER_VERSION}...`);
    await downloadFile(CODE_SERVER_TARBALL_URL, tarball);
    console.log('[vscode-server] Download complete.');
  }

  console.log('[vscode-server] Extracting...');
  execSync(`tar -xzf "${tarball}" -C "${CACHE_DIR}"`);

  console.log('[vscode-server] Installing VS Code server dependencies...');
  execSync('npm install --ignore-scripts', {
    cwd: VSCODE_SERVER_CWD,
    stdio: 'inherit',
  });

  console.log('[vscode-server] Ready.');
  return VSCODE_SERVER_ENTRY;
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
    VSCODE_SERVER_ENTRY,
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
    cwd: VSCODE_SERVER_CWD,
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
