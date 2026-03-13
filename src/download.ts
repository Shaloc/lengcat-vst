/**
 * Installation helpers for the code-server binary.
 *
 * Downloads and caches the standalone code-server binary from GitHub Releases:
 *   https://github.com/coder/code-server/releases
 *
 * The binary is persisted to ~/.lengcat-vst/code-server/ so subsequent runs
 * do not need to download again.  Call `installCodeServer` to install a
 * specific version, or `ensureCodeServer` to install only when no
 * installation is present.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as https from 'https';
import * as http from 'http';
import { execSync } from 'child_process';

/** Fallback version used when the GitHub Releases API is unreachable. */
export const CODE_SERVER_FALLBACK_VERSION = '4.23.0';

/** Persistent directory where the code-server binary is cached. */
export const CODE_SERVER_CACHE_DIR = path.join(
  os.homedir(),
  '.lengcat-vst',
  'code-server'
);

/** File that records the currently installed code-server version. */
export const CODE_SERVER_VERSION_FILE = path.join(
  CODE_SERVER_CACHE_DIR,
  '.installed-version'
);

/** Returns the OS platform label used in code-server release asset filenames. */
export function resolveReleasePlatform(): string {
  const p = process.platform;
  if (p === 'linux') return 'linux';
  if (p === 'darwin') return 'macos';
  throw new Error(
    `Unsupported platform "${p}" for code-server auto-install. ` +
    `Please install code-server manually from https://github.com/coder/code-server/releases`
  );
}

/** Returns the CPU architecture label used in code-server release asset filenames. */
export function resolveReleaseArch(): string {
  const a = process.arch;
  if (a === 'x64') return 'amd64';
  if (a === 'arm64') return 'arm64';
  throw new Error(
    `Unsupported architecture "${a}" for code-server auto-install. ` +
    `Please install code-server manually from https://github.com/coder/code-server/releases`
  );
}

/** Returns the GitHub Releases download URL for the given version. */
export function codeServerTarballUrl(version: string): string {
  const platform = resolveReleasePlatform();
  const arch = resolveReleaseArch();
  return (
    `https://github.com/coder/code-server/releases/download/v${version}/` +
    `code-server-${version}-${platform}-${arch}.tar.gz`
  );
}

/** Returns the absolute path to the code-server binary for the given version. */
export function codeServerBinPath(version: string): string {
  const platform = resolveReleasePlatform();
  const arch = resolveReleaseArch();
  return path.join(
    CODE_SERVER_CACHE_DIR,
    `code-server-${version}-${platform}-${arch}`,
    'bin',
    'code-server'
  );
}

/**
 * Returns the currently installed code-server version string, or `undefined`
 * if no valid installation exists in `CODE_SERVER_CACHE_DIR`.
 */
export function installedCodeServerVersion(): string | undefined {
  try {
    if (!fs.existsSync(CODE_SERVER_VERSION_FILE)) return undefined;
    const version = fs.readFileSync(CODE_SERVER_VERSION_FILE, 'utf-8').trim();
    if (!version) return undefined;
    // Verify the binary file still exists on disk.
    if (!fs.existsSync(codeServerBinPath(version))) return undefined;
    return version;
  } catch {
    return undefined;
  }
}

/**
 * Returns the absolute path to the installed code-server binary, or
 * `undefined` when no installation is found.
 */
export function installedCodeServerBin(): string | undefined {
  const version = installedCodeServerVersion();
  return version !== undefined ? codeServerBinPath(version) : undefined;
}

/**
 * Fetches the latest published code-server release version from the GitHub
 * API.  Returns `CODE_SERVER_FALLBACK_VERSION` if the API cannot be reached
 * within 8 seconds.
 */
export async function fetchLatestCodeServerVersion(): Promise<string> {
  return new Promise((resolve) => {
    const req = https.get(
      {
        hostname: 'api.github.com',
        path: '/repos/coder/code-server/releases/latest',
        headers: { 'User-Agent': 'lengcat-vst' },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf-8');
        res.on('data', (chunk: string) => { body += chunk; });
        res.on('end', () => {
          try {
            const json = JSON.parse(body) as { tag_name?: string };
            const version = (json.tag_name ?? '').replace(/^v/, '');
            resolve(version || CODE_SERVER_FALLBACK_VERSION);
          } catch {
            resolve(CODE_SERVER_FALLBACK_VERSION);
          }
        });
      }
    );
    req.on('error', () => resolve(CODE_SERVER_FALLBACK_VERSION));
    req.setTimeout(8_000, () => {
      req.destroy();
      resolve(CODE_SERVER_FALLBACK_VERSION);
    });
  });
}

/**
 * Downloads `url` to the local file at `dest`, following up to 10 redirects.
 * Calls `onProgress` with a percentage string as data arrives.
 */
function downloadFile(
  url: string,
  dest: string,
  onProgress?: (msg: string) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);

    function attempt(u: string, redirectsLeft: number): void {
      const mod: typeof https | typeof http = u.startsWith('https') ? https : http;
      mod.get(u, (res) => {
        if (
          res.statusCode !== undefined &&
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          if (redirectsLeft <= 0) {
            reject(new Error(`Too many redirects downloading ${u}`));
            return;
          }
          res.resume();
          attempt(res.headers.location, redirectsLeft - 1);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode ?? '?'} downloading ${u}`));
          return;
        }
        const total = parseInt(res.headers['content-length'] ?? '0', 10);
        let received = 0;
        res.on('data', (chunk: Buffer) => {
          received += chunk.length;
          if (onProgress && total > 0) {
            onProgress(`  ${Math.round((received / total) * 100)}%`);
          }
        });
        res.pipe(file);
        file.on('finish', () => file.close(() => resolve()));
        file.on('error', (err) => { file.close(); reject(err); });
      }).on('error', (err) => { file.close(); reject(err); });
    }

    attempt(url, 10);
  });
}

/**
 * Downloads, extracts, and records the code-server binary for `version`.
 *
 * Skips the download if the binary already exists on disk.
 * The downloaded tarball is removed after successful extraction.
 *
 * @param version    Semver version string, e.g. `'4.23.0'`.
 * @param onProgress Optional callback called with human-readable progress messages.
 * @returns          The absolute path to the installed `code-server` binary.
 */
export async function installCodeServer(
  version: string,
  onProgress?: (msg: string) => void
): Promise<string> {
  const binPath = codeServerBinPath(version);

  if (fs.existsSync(binPath)) {
    // Already on disk — just refresh the version record and return.
    fs.mkdirSync(CODE_SERVER_CACHE_DIR, { recursive: true });
    fs.writeFileSync(CODE_SERVER_VERSION_FILE, version, 'utf-8');
    return binPath;
  }

  fs.mkdirSync(CODE_SERVER_CACHE_DIR, { recursive: true });

  const url = codeServerTarballUrl(version);
  const tarball = path.join(CODE_SERVER_CACHE_DIR, `code-server-${version}.tar.gz`);

  onProgress?.(`  Downloading code-server v${version} from GitHub…`);
  await downloadFile(url, tarball, onProgress);
  onProgress?.('  Extracting…');

  execSync(
    `tar -xzf ${JSON.stringify(tarball)} -C ${JSON.stringify(CODE_SERVER_CACHE_DIR)}`
  );
  try { fs.unlinkSync(tarball); } catch { /* ignore */ }

  if (!fs.existsSync(binPath)) {
    throw new Error(
      `Extraction succeeded but binary not found at expected path: ${binPath}`
    );
  }

  fs.chmodSync(binPath, 0o755);
  fs.writeFileSync(CODE_SERVER_VERSION_FILE, version, 'utf-8');
  onProgress?.(`  Installed at ${binPath}`);
  return binPath;
}

/**
 * Ensures code-server is installed, downloading it if no installation exists.
 *
 * When already installed the function returns immediately without any network
 * access.  On first run the latest release is fetched from GitHub (~50 MB)
 * and cached in `CODE_SERVER_CACHE_DIR` so all subsequent calls are instant.
 *
 * @param onProgress Optional callback for human-readable progress messages.
 * @returns          Absolute path to the `code-server` binary.
 */
export async function ensureCodeServer(
  onProgress?: (msg: string) => void
): Promise<string> {
  const existing = installedCodeServerBin();
  if (existing) return existing;

  onProgress?.('  Fetching latest code-server version from GitHub…');
  const version = await fetchLatestCodeServerVersion();
  onProgress?.(`  Latest: v${version}`);
  return installCodeServer(version, onProgress);
}
