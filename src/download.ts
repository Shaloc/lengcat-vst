/**
 * Installation helpers for the code-server binary.
 *
 * Downloads and caches the standalone code-server binary from GitHub Releases:
 *   https://github.com/coder/code-server/releases
 *
 * The binary is persisted to ~/.lengcat-vst/code-server/ so subsequent runs
 * do not need to download again.
 *
 * ── Offline / poor-network usage ────────────────────────────────────────────
 * If you cannot download from GitHub, place the tarball you obtained through
 * another means into CODE_SERVER_CACHE_DIR before running the tool:
 *
 *   Expected location:
 *     ~/.lengcat-vst/code-server/code-server-<version>-<platform>-<arch>.tar.gz
 *
 *   Example (Linux x86-64, v4.23.0):
 *     ~/.lengcat-vst/code-server/code-server-4.23.0-linux-amd64.tar.gz
 *
 *   Download from:
 *     https://github.com/coder/code-server/releases
 *
 * The tool detects the tarball automatically on startup and extracts it
 * without any network access.
 * ────────────────────────────────────────────────────────────────────────────
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as https from 'https';
import * as http from 'http';
import { execSync } from 'child_process';

/** Fallback version used when the GitHub Releases API is unreachable. */
export const CODE_SERVER_FALLBACK_VERSION = '4.96.4';

// ── Global download-progress tracking ───────────────────────────────────────
// Allows the REST API to expose real-time download progress to the dashboard
// without requiring an SSE or WebSocket stream — the frontend simply polls.

export interface DownloadProgress {
  /** True while a download is in progress. */
  downloading: boolean;
  /** 0–100 percentage (based on Content-Length). -1 when unknown. */
  percent: number;
  /** The version being downloaded/installed. */
  version: string;
  /** Human-readable status line. */
  message: string;
  /** Non-empty when the download/install failed. */
  error: string;
}

const _progress: DownloadProgress = {
  downloading: false,
  percent: 0,
  version: '',
  message: '',
  error: '',
};

/** Returns a snapshot of the current download progress (safe to serialise). */
export function getDownloadProgress(): Readonly<DownloadProgress> {
  return { ..._progress };
}

/** Resets progress to idle (used after install completes or fails). */
function resetProgress(): void {
  _progress.downloading = false;
  _progress.percent = 0;
  _progress.version = '';
  _progress.message = '';
  _progress.error = '';
}

function updateProgress(patch: Partial<DownloadProgress>): void {
  Object.assign(_progress, patch);
}

// ── Download cancellation ───────────────────────────────────────────────────
let _activeDownloadReq: http.ClientRequest | null = null;
let _downloadCancelled = false;

/**
 * Cancels the currently running code-server download (if any).
 * The download promise will reject with a "cancelled" error and
 * `downloadFileWithRetry` will not retry.
 */
export function cancelCodeServerDownload(): void {
  _downloadCancelled = true;
  if (_activeDownloadReq) {
    _activeDownloadReq.destroy(new Error('Download cancelled by user'));
    _activeDownloadReq = null;
  }
  updateProgress({ downloading: false, message: 'Download cancelled', error: '' });
}

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
 * Returns the filename of the tarball for the given version on the current
 * platform/arch.  Users can download this file manually and place it inside
 * CODE_SERVER_CACHE_DIR to skip the automatic network download.
 *
 * Example: "code-server-4.23.0-linux-amd64.tar.gz"
 */
export function localTarballName(version: string): string {
  const platform = resolveReleasePlatform();
  const arch = resolveReleaseArch();
  return `code-server-${version}-${platform}-${arch}.tar.gz`;
}

/**
 * Returns the full drop-in path where a user-supplied tarball for `version`
 * should be placed so the tool finds it without downloading.
 */
export function localTarballPath(version: string): string {
  return path.join(CODE_SERVER_CACHE_DIR, localTarballName(version));
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
 * Scans CODE_SERVER_CACHE_DIR for a user-placed code-server tarball that
 * matches the current platform and architecture.
 *
 * This is the offline / poor-network path: the user downloads the tarball
 * from https://github.com/coder/code-server/releases on a machine with
 * internet access and copies it to CODE_SERVER_CACHE_DIR.
 *
 * Expected filename format:
 *   code-server-<version>-<platform>-<arch>.tar.gz
 *
 * @returns `{ tarball, version }` for the newest matching file found, or
 *          `undefined` if none exist.
 */
export function findLocalTarball():
  | { tarball: string; version: string }
  | undefined {
  try {
    if (!fs.existsSync(CODE_SERVER_CACHE_DIR)) return undefined;
    const platform = resolveReleasePlatform();
    const arch = resolveReleaseArch();
    const suffix = `-${platform}-${arch}.tar.gz`;
    const prefix = 'code-server-';

    const matches = fs
      .readdirSync(CODE_SERVER_CACHE_DIR)
      .filter((f) => f.startsWith(prefix) && f.endsWith(suffix))
      .sort()
      .reverse(); // prefer lexicographically newer versions first

    for (const filename of matches) {
      const version = filename.slice(prefix.length, filename.length - suffix.length);
      if (!version) continue;
      const tarball = path.join(CODE_SERVER_CACHE_DIR, filename);
      return { tarball, version };
    }
  } catch {
    /* unreadable directory – fall through */
  }
  return undefined;
}

/**
 * Scans CODE_SERVER_CACHE_DIR for an already-extracted code-server binary
 * (handles manual installations or runs where extraction succeeded but
 * `.installed-version` was never written).
 *
 * @returns `{ binPath, version }` for the newest matching directory found,
 *          or `undefined` if none exist.
 */
export function findExtractedBinary():
  | { binPath: string; version: string }
  | undefined {
  try {
    if (!fs.existsSync(CODE_SERVER_CACHE_DIR)) return undefined;
    const platform = resolveReleasePlatform();
    const arch = resolveReleaseArch();
    const prefix = 'code-server-';
    const suffix = `-${platform}-${arch}`;

    const matches = fs
      .readdirSync(CODE_SERVER_CACHE_DIR)
      .filter((e) => {
        if (!e.startsWith(prefix) || !e.endsWith(suffix) || e.endsWith('.tar.gz')) {
          return false;
        }
        try {
          return fs.statSync(path.join(CODE_SERVER_CACHE_DIR, e)).isDirectory();
        } catch {
          return false;
        }
      })
      .sort()
      .reverse(); // prefer lexicographically newer versions first

    for (const dir of matches) {
      const binPath = path.join(CODE_SERVER_CACHE_DIR, dir, 'bin', 'code-server');
      if (fs.existsSync(binPath)) {
        const version = dir.slice(prefix.length, dir.length - suffix.length);
        if (version) return { binPath, version };
      }
    }
  } catch { /* unreadable directory */ }
  return undefined;
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
 * Downloads `url` to `dest`, following redirects.
 *
 * - Reports percentage progress via `onProgress`.
 * - Applies a 30-second socket-inactivity timeout so stalled connections
 *   do not hang indefinitely.
 * - Retries up to `maxRetries` times with exponential back-off (2 s, 4 s, 8 s)
 *   on connection errors or unexpected HTTP status codes.
 * - Cleans up the partial file before each retry.
 *
 * If all retries are exhausted the error message includes the manual
 * drop-in path so the user knows where to place a self-downloaded tarball.
 */
async function downloadFileWithRetry(
  url: string,
  dest: string,
  onProgress?: (msg: string) => void,
  maxRetries = 3
): Promise<void> {
  let lastErr: Error | undefined;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    // Bail immediately if the user cancelled the download.
    if (_downloadCancelled) throw new Error('Download cancelled by user');

    if (attempt > 0) {
      const delaySec = Math.pow(2, attempt); // 2, 4, 8 seconds
      onProgress?.(
        `  Network error on attempt ${attempt}/${maxRetries - 1}: ${lastErr?.message ?? 'unknown'}. ` +
        `Retrying in ${delaySec}s…`
      );
      await new Promise<void>((r) => setTimeout(r, delaySec * 1_000));
      // Remove any partial file before retrying.
      try { if (fs.existsSync(dest)) fs.unlinkSync(dest); } catch { /* ignore */ }
    }

    try {
      await downloadFile(url, dest, onProgress);
      return; // success
    } catch (err) {
      lastErr = err as Error;
    }
  }

  throw new Error(
    `Failed to download code-server after ${maxRetries} attempt(s): ${lastErr?.message ?? 'unknown error'}\n` +
    `\nPoor network?  Download the tarball manually and place it here:\n` +
    `  URL:  ${url}\n` +
    `  Save: ${dest}\n` +
    `Then run the command again — the tool will detect the file automatically.`
  );
}

/**
 * Single-attempt HTTP/HTTPS download of `url` to `dest`.
 * Follows up to 10 redirects.  Applies a 30-second socket-inactivity timeout.
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
      const req = mod.get(u, (res) => {
        // Store active request so cancelCodeServerDownload() can abort it.
        _activeDownloadReq = req;
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
          const pct = total > 0 ? Math.round((received / total) * 100) : -1;
          if (onProgress && total > 0) {
            onProgress(`  ${pct}%`);
          }
          // Update global progress tracker so the dashboard can poll it.
          updateProgress({ percent: pct, message: `Downloading… ${pct >= 0 ? pct + '%' : ''}` });
        });
        res.pipe(file);
        file.on('finish', () => file.close(() => resolve()));
        file.on('error', (err) => { file.close(); reject(err); });
      });

      // 30-second socket-inactivity timeout: kills stalled transfers.
      req.setTimeout(30_000, () => {
        req.destroy(new Error(`Socket timeout downloading ${u}`));
      });
      req.on('error', (err) => { file.close(); reject(err); });
    }

    attempt(url, 10);
  });
}

/**
 * Downloads, extracts, and records the code-server binary for `version`.
 *
 * Resolution order:
 *   1. Binary already extracted in CODE_SERVER_CACHE_DIR → return immediately.
 *   2. Matching tarball already in CODE_SERVER_CACHE_DIR (user-supplied or a
 *      previous partial install) → extract without downloading.
 *   3. Download from GitHub Releases with retry/back-off.
 *
 * @param version    Semver string, e.g. `'4.23.0'`.
 * @param onProgress Optional callback for human-readable progress messages.
 * @returns          Absolute path to the installed `code-server` binary.
 */
export async function installCodeServer(
  version: string,
  onProgress?: (msg: string) => void
): Promise<string> {
  // Reset cancellation flag at the start of a new install.
  _downloadCancelled = false;
  _activeDownloadReq = null;

  const binPath = codeServerBinPath(version);

  if (fs.existsSync(binPath)) {
    // Binary already present — refresh the version record and return.
    fs.mkdirSync(CODE_SERVER_CACHE_DIR, { recursive: true });
    fs.writeFileSync(CODE_SERVER_VERSION_FILE, version, 'utf-8');
    return binPath;
  }

  fs.mkdirSync(CODE_SERVER_CACHE_DIR, { recursive: true });

  const tarball = localTarballPath(version);
  const url = codeServerTarballUrl(version);

  if (fs.existsSync(tarball)) {
    // Verify the tarball is non-empty before attempting extraction.
    const size = fs.statSync(tarball).size;
    if (size === 0) {
      onProgress?.(`  Removing empty tarball at ${tarball}…`);
      try { fs.unlinkSync(tarball); } catch { /* ignore */ }
    } else {
      onProgress?.(`  Found local tarball: ${tarball}`);
    }
  }
  if (!fs.existsSync(tarball)) {
    onProgress?.(`  Downloading code-server v${version} from GitHub…`);
    onProgress?.(`  (Tip: to skip the download, place the tarball at:\n      ${tarball})`);
    updateProgress({ downloading: true, percent: 0, version, message: 'Starting download…', error: '' });
    try {
      await downloadFileWithRetry(url, tarball, onProgress);
    } catch (err) {
      updateProgress({ downloading: false, error: (err as Error).message });
      throw err;
    }
  }

  onProgress?.('  Extracting…');
  updateProgress({ message: 'Extracting…', percent: 100 });
  try {
    execSync(
      `tar -xzf ${JSON.stringify(tarball)} -C ${JSON.stringify(CODE_SERVER_CACHE_DIR)}`
    );
  } catch (extractErr) {
    // Tarball is corrupt or incomplete — remove it so the next run can
    // download a fresh copy.
    try { fs.unlinkSync(tarball); } catch { /* ignore */ }
    const msg = `Failed to extract code-server tarball: ${(extractErr as Error).message}\n` +
      `The corrupt file has been removed. Run the command again to re-download, or\n` +
      `place a valid tarball at: ${tarball}`;
    updateProgress({ downloading: false, error: msg });
    throw new Error(msg);
  }

  if (!fs.existsSync(binPath)) {
    const msg = `Extraction succeeded but binary not found at expected path: ${binPath}\n` +
      `This may indicate the tarball was for a different platform or arch.`;
    updateProgress({ downloading: false, error: msg });
    throw new Error(msg);
  }

  fs.chmodSync(binPath, 0o755);
  fs.writeFileSync(CODE_SERVER_VERSION_FILE, version, 'utf-8');
  onProgress?.(`  Installed at ${binPath}`);
  resetProgress();
  return binPath;
}

/**
 * Ensures code-server is installed, downloading it only when no installation
 * (and no local tarball) is found.
 *
 * Resolution order:
 *   1. Installed binary in CODE_SERVER_CACHE_DIR → return immediately.
 *   2. User-placed tarball in CODE_SERVER_CACHE_DIR → extract, no download.
 *   3. Fetch latest version from GitHub API → download and install.
 *
 * When already installed this function makes zero network calls.
 *
 * @param onProgress Optional callback for human-readable progress messages.
 * @returns          Absolute path to the `code-server` binary.
 */
export async function ensureCodeServer(
  onProgress?: (msg: string) => void
): Promise<string> {
  // 1. Fast path: recorded installation.
  const existing = installedCodeServerBin();
  if (existing) return existing;

  // 2. Recovery: an already-extracted binary directory exists but the version
  //    file was never written (e.g. a previous install that crashed mid-way,
  //    or a binary placed manually).
  const extracted = findExtractedBinary();
  if (extracted) {
    onProgress?.(`  Found existing binary v${extracted.version} — recording installation.`);
    fs.mkdirSync(CODE_SERVER_CACHE_DIR, { recursive: true });
    fs.writeFileSync(CODE_SERVER_VERSION_FILE, extracted.version, 'utf-8');
    return extracted.binPath;
  }

  // 3. Offline path: user pre-placed a tarball in the cache directory.
  const local = findLocalTarball();
  if (local) {
    onProgress?.(`  Found local tarball for v${local.version} — extracting…`);
    return installCodeServer(local.version, onProgress);
  }

  // 4. Online path: fetch the latest release tag and download.
  onProgress?.('  Fetching latest code-server version from GitHub…');
  const version = await fetchLatestCodeServerVersion();
  onProgress?.(`  Latest: v${version}`);
  return installCodeServer(version, onProgress);
}
