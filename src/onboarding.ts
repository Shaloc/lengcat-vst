/**
 * Onboarding status helpers for the lengcat-vst dashboard.
 *
 * The frontend queries `/api/onboarding/status` on page load to determine
 * which external dependencies are ready and which still need user attention.
 * This module centralises the detection logic so both the REST handler and
 * unit tests can reuse it.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  installedCodeServerVersion,
  CODE_SERVER_CACHE_DIR,
} from './download';

/** Directory where leduo-patrol is expected to live by default. */
export const DEFAULT_LEDUO_PATROL_DIR = path.join(
  os.homedir(),
  '.lengcat-vst',
  'leduo-patrol'
);

export interface CodeServerStatus {
  installed: boolean;
  version?: string;
  cacheDir: string;
}

export interface LeduoPatrolStatus {
  dirExists: boolean;
  dir: string;
  envFileExists: boolean;
  nodeModulesExists: boolean;
}

export interface OnboardingStatus {
  codeServer: CodeServerStatus;
  leduoPatrol: LeduoPatrolStatus;
  /** True when all dependencies are ready and onboarding can be skipped. */
  ready: boolean;
}

/**
 * Inspects the local environment and returns the current onboarding status.
 *
 * @param leduoDir  Override for the leduo-patrol directory path (defaults to
 *                  `$LEDUO_PATROL_DIR` or `~/.lengcat-vst/leduo-patrol`).
 */
export function getOnboardingStatus(leduoDir?: string): OnboardingStatus {
  const dir =
    leduoDir ??
    process.env.LEDUO_PATROL_DIR ??
    DEFAULT_LEDUO_PATROL_DIR;

  // ── code-server ───────────────────────────────────────────────────────────
  const csVersion = installedCodeServerVersion();
  const codeServer: CodeServerStatus = {
    installed: csVersion !== undefined,
    version: csVersion,
    cacheDir: CODE_SERVER_CACHE_DIR,
  };

  // ── leduo-patrol ──────────────────────────────────────────────────────────
  const dirExists = fs.existsSync(dir);
  const envFileExists = dirExists && fs.existsSync(path.join(dir, '.env'));
  const nodeModulesExists =
    dirExists && fs.existsSync(path.join(dir, 'node_modules'));
  const leduoPatrol: LeduoPatrolStatus = {
    dirExists,
    dir,
    envFileExists,
    nodeModulesExists,
  };

  const ready = codeServer.installed && dirExists && envFileExists;

  return { codeServer, leduoPatrol, ready };
}
