/**
 * Auto-download helper for the VS Code server bundled inside the code-server
 * npm package.
 *
 * Used as the last-resort fallback in startBackend() when no VS Code /
 * VSCodium binary can be found on PATH or in the user's home directory.
 * The downloaded server is extracted once and cached in a temp directory so
 * subsequent starts are instant.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as https from 'https';
import * as http from 'http';
import { execSync } from 'child_process';

/** Version of the code-server package that bundles the VS Code server. */
export const CODE_SERVER_VERSION = '4.111.0';

const CODE_SERVER_TARBALL_URL =
  `https://registry.npmjs.org/code-server/-/code-server-${CODE_SERVER_VERSION}.tgz`;

/** Directory where the downloaded server is cached across runs. */
export const DOWNLOADED_SERVER_CACHE_DIR = path.join(
  os.tmpdir(),
  'lengcat-vst-vscode-server'
);

/** Absolute path to the VS Code server entry-point script after extraction. */
export const DOWNLOADED_SERVER_ENTRY = path.join(
  DOWNLOADED_SERVER_CACHE_DIR,
  'package', 'lib', 'vscode', 'out', 'server-main.js'
);

/** Working directory required when running the downloaded server. */
export const DOWNLOADED_SERVER_CWD = path.join(
  DOWNLOADED_SERVER_CACHE_DIR,
  'package', 'lib', 'vscode'
);

/** Downloads a URL to a local file, following up to 5 redirects. */
function downloadFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);

    function doGet(u: string, redirectsLeft: number): void {
      const client: typeof https | typeof http = u.startsWith('https') ? https : http;
      client.get(u, (res) => {
        if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
          if (redirectsLeft <= 0) {
            reject(new Error(`Too many redirects downloading: ${u}`));
            return;
          }
          // Follow redirect.
          res.resume();
          doGet(res.headers.location, redirectsLeft - 1);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`Download failed with status ${res.statusCode}: ${u}`));
          return;
        }
        res.pipe(file);
        file.on('finish', () => file.close(() => resolve()));
        file.on('error', reject);
      }).on('error', reject);
    }

    doGet(url, 5);
  });
}

/**
 * Ensures the VS Code server from the code-server package is available on
 * disk, downloading and extracting it if necessary.
 *
 * The tarball is fetched once from the npm registry (~49 MB) and cached in
 * DOWNLOADED_SERVER_CACHE_DIR so subsequent calls return immediately.
 *
 * @returns The entry-point path and the CWD needed to spawn the server.
 */
export async function ensureDownloadedServer(): Promise<{
  entryPoint: string;
  cwd: string;
}> {
  // Fast path: already extracted.
  if (fs.existsSync(DOWNLOADED_SERVER_ENTRY)) {
    return { entryPoint: DOWNLOADED_SERVER_ENTRY, cwd: DOWNLOADED_SERVER_CWD };
  }

  fs.mkdirSync(DOWNLOADED_SERVER_CACHE_DIR, { recursive: true });

  const tarball = path.join(DOWNLOADED_SERVER_CACHE_DIR, 'code-server.tgz');
  if (!fs.existsSync(tarball)) {
    process.stderr.write(
      `[lengcat-vst] VS Code server not found — downloading code-server ${CODE_SERVER_VERSION} (~49 MB)...\n`
    );
    await downloadFile(CODE_SERVER_TARBALL_URL, tarball);
    process.stderr.write('[lengcat-vst] Download complete.\n');
  }

  process.stderr.write('[lengcat-vst] Extracting VS Code server...\n');
  execSync(`tar -xzf "${tarball}" -C "${DOWNLOADED_SERVER_CACHE_DIR}"`);

  // Install Node.js dependencies (needed only once after extraction).
  if (!fs.existsSync(path.join(DOWNLOADED_SERVER_CWD, 'node_modules'))) {
    process.stderr.write('[lengcat-vst] Installing VS Code server dependencies...\n');
    execSync('npm install --ignore-scripts', {
      cwd: DOWNLOADED_SERVER_CWD,
      stdio: 'inherit',
    });
  }

  process.stderr.write('[lengcat-vst] VS Code server ready.\n');
  return { entryPoint: DOWNLOADED_SERVER_ENTRY, cwd: DOWNLOADED_SERVER_CWD };
}
