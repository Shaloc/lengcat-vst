/**
 * Unit tests for the onboarding status checker (src/onboarding.ts).
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getOnboardingStatus } from '../src/onboarding';

// Use a temp directory for tests so we don't mutate the real filesystem.
const tmpBase = path.join(os.tmpdir(), `lvst-onboarding-test-${process.pid}`);

beforeAll(() => {
  fs.mkdirSync(tmpBase, { recursive: true });
});

afterAll(() => {
  fs.rmSync(tmpBase, { recursive: true, force: true });
});

describe('getOnboardingStatus', () => {
  it('reports leduo-patrol as missing when directory does not exist', () => {
    const dir = path.join(tmpBase, 'non-existent-dir');
    const status = getOnboardingStatus(dir);
    expect(status.leduoPatrol.dirExists).toBe(false);
    expect(status.leduoPatrol.envFileExists).toBe(false);
    expect(status.leduoPatrol.nodeModulesExists).toBe(false);
    expect(status.leduoPatrol.dir).toBe(dir);
  });

  it('reports leduo-patrol dir exists but .env missing', () => {
    const dir = path.join(tmpBase, 'leduo-no-env');
    fs.mkdirSync(dir, { recursive: true });
    const status = getOnboardingStatus(dir);
    expect(status.leduoPatrol.dirExists).toBe(true);
    expect(status.leduoPatrol.envFileExists).toBe(false);
    expect(status.leduoPatrol.nodeModulesExists).toBe(false);
  });

  it('reports leduo-patrol fully ready when dir and .env exist', () => {
    const dir = path.join(tmpBase, 'leduo-ready');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.env'), 'PORT=3001\n');
    const status = getOnboardingStatus(dir);
    expect(status.leduoPatrol.dirExists).toBe(true);
    expect(status.leduoPatrol.envFileExists).toBe(true);
  });

  it('detects node_modules when present', () => {
    const dir = path.join(tmpBase, 'leduo-with-nm');
    fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.env'), 'PORT=3001\n');
    const status = getOnboardingStatus(dir);
    expect(status.leduoPatrol.nodeModulesExists).toBe(true);
  });

  it('returns codeServer status with cacheDir', () => {
    const status = getOnboardingStatus(path.join(tmpBase, 'any'));
    expect(status.codeServer).toBeDefined();
    expect(typeof status.codeServer.installed).toBe('boolean');
    expect(typeof status.codeServer.cacheDir).toBe('string');
  });

  it('reports ready=false when leduo-patrol is missing', () => {
    const status = getOnboardingStatus(path.join(tmpBase, 'no-such-dir'));
    expect(status.ready).toBe(false);
  });
});
