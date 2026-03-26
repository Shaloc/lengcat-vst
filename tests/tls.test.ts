/**
 * Unit tests for the TLS certificate generation and cache-invalidation logic
 * in src/tls.ts.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { X509Certificate } from 'crypto';
import { generate } from 'selfsigned';

// ── helpers ──────────────────────────────────────────────────────────────────

/** Creates a fresh temporary directory and returns its path. */
function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tls-test-'));
}

/** Removes a directory tree. */
function rmTmpDir(p: string): void {
  fs.rmSync(p, { recursive: true, force: true });
}

// ── module under test ─────────────────────────────────────────────────────────
//
// CACHE_DIR in tls.ts is read from LENGCAT_TLS_CACHE_DIR at module-load time.
// We set the env-var before each test, then reset the module registry so the
// module is re-evaluated with the new directory.

describe('loadOrGenerateTls', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    process.env.LENGCAT_TLS_CACHE_DIR = tmpDir;
    jest.resetModules();
  });

  afterEach(() => {
    delete process.env.LENGCAT_TLS_CACHE_DIR;
    rmTmpDir(tmpDir);
  });

  // Re-import the module after resetting Jest's module registry.
  async function importTls() {
    return import('../src/tls');
  }

  it('generates a self-signed cert when no paths are given', async () => {
    const { loadOrGenerateTls } = await importTls();
    const creds = await loadOrGenerateTls();
    expect(creds.selfSigned).toBe(true);
    expect(creds.cert).toMatch(/-----BEGIN CERTIFICATE-----/);
    expect(creds.key).toMatch(/-----BEGIN/);
  });

  it('returns the cached cert on a second call with the same (empty) domain list', async () => {
    const { loadOrGenerateTls } = await importTls();
    const first  = await loadOrGenerateTls();
    const second = await loadOrGenerateTls();
    expect(second.cert).toBe(first.cert);
    expect(second.key).toBe(first.key);
  });

  it('regenerates the cert when extra domains are added', async () => {
    const { loadOrGenerateTls } = await importTls();
    const withoutDomains = await loadOrGenerateTls();
    const withDomain     = await loadOrGenerateTls(undefined, undefined, ['mydev.local']);
    // The cert PEM should differ because new SANs were requested.
    expect(withDomain.cert).not.toBe(withoutDomains.cert);
  });

  it('returns cached cert when the same extra domain list is used again', async () => {
    const { loadOrGenerateTls } = await importTls();
    const first  = await loadOrGenerateTls(undefined, undefined, ['mydev.local']);
    const second = await loadOrGenerateTls(undefined, undefined, ['mydev.local']);
    expect(second.cert).toBe(first.cert);
  });

  it('regenerates the cert when the domain list changes', async () => {
    const { loadOrGenerateTls } = await importTls();
    const withA = await loadOrGenerateTls(undefined, undefined, ['alpha.local']);
    const withB = await loadOrGenerateTls(undefined, undefined, ['beta.local']);
    expect(withB.cert).not.toBe(withA.cert);
  });

  it('regenerates the cert when domains are added to the list', async () => {
    const { loadOrGenerateTls } = await importTls();
    const one = await loadOrGenerateTls(undefined, undefined, ['mydev.local']);
    const two = await loadOrGenerateTls(undefined, undefined, ['mydev.local', '10.0.1.5']);
    expect(two.cert).not.toBe(one.cert);
  });

  it('treats domain list as order-independent (deduplicates and sorts)', async () => {
    const { loadOrGenerateTls } = await importTls();
    const first  = await loadOrGenerateTls(undefined, undefined, ['b.local', 'a.local']);
    const second = await loadOrGenerateTls(undefined, undefined, ['a.local', 'b.local', 'a.local']);
    // Same canonical set → should reuse the cache.
    expect(second.cert).toBe(first.cert);
  });

  it('includes IP addresses in the SAN list without crashing', async () => {
    const { loadOrGenerateTls } = await importTls();
    const creds = await loadOrGenerateTls(undefined, undefined, ['10.0.1.5', 'mydev.local']);
    expect(creds.selfSigned).toBe(true);
    expect(creds.cert).toMatch(/-----BEGIN CERTIFICATE-----/);
  });

  it('uses the provided cert/key paths (selfSigned = false)', async () => {
    const { loadOrGenerateTls } = await importTls();

    // Write a fake cert and key to disk.
    const fakeCert = path.join(tmpDir, 'fake.crt');
    const fakeKey  = path.join(tmpDir, 'fake.key');
    fs.writeFileSync(fakeCert, 'FAKE_CERT');
    fs.writeFileSync(fakeKey,  'FAKE_KEY');

    const creds = await loadOrGenerateTls(fakeCert, fakeKey);
    expect(creds.selfSigned).toBe(false);
    expect(creds.cert).toBe('FAKE_CERT');
    expect(creds.key).toBe('FAKE_KEY');
  });

  it('writes a domains.json manifest alongside the generated cert', async () => {
    const { loadOrGenerateTls } = await importTls();
    await loadOrGenerateTls(undefined, undefined, ['mydev.local']);

    const metaFile = path.join(tmpDir, 'domains.json');
    expect(fs.existsSync(metaFile)).toBe(true);

    const stored = JSON.parse(fs.readFileSync(metaFile, 'utf-8')) as string[];
    expect(stored).toEqual(['mydev.local']);
  });

  it('writes an empty domains.json manifest when no extra domains are requested', async () => {
    const { loadOrGenerateTls } = await importTls();
    await loadOrGenerateTls();

    const metaFile = path.join(tmpDir, 'domains.json');
    expect(fs.existsSync(metaFile)).toBe(true);

    const stored = JSON.parse(fs.readFileSync(metaFile, 'utf-8')) as string[];
    expect(stored).toEqual([]);
  });

  it('generates a CA certificate suitable for manual iOS trust enablement', async () => {
    const { loadOrGenerateTls } = await importTls();
    const creds = await loadOrGenerateTls();

    const cert = new X509Certificate(creds.cert);
    expect(cert.ca).toBe(true);
  });

  it('regenerates legacy cached non-CA certificates for iOS trust compatibility', async () => {
    const attrs = [{ name: 'commonName', value: 'lengcat-vst' }];
    const legacy = await generate(attrs, {
      extensions: [
        {
          name: 'subjectAltName',
          altNames: [
            { type: 2, value: 'localhost' },
            { type: 7, ip: '127.0.0.1' },
            { type: 7, ip: '0.0.0.0' },
          ],
        },
      ],
    });

    fs.writeFileSync(path.join(tmpDir, 'cert.pem'), legacy.cert);
    fs.writeFileSync(path.join(tmpDir, 'key.pem'), legacy.private);
    fs.writeFileSync(path.join(tmpDir, 'domains.json'), JSON.stringify([]));

    const legacyCert = new X509Certificate(legacy.cert);
    expect(legacyCert.ca).toBe(false);

    const { loadOrGenerateTls } = await importTls();
    const creds = await loadOrGenerateTls();
    const upgraded = new X509Certificate(creds.cert);

    expect(upgraded.ca).toBe(true);
    expect(creds.cert).not.toBe(legacy.cert);
  });
});
