/**
 * TLS certificate utilities for lengcat-vst.
 *
 * Provides a single helper that either loads an existing cert+key pair from
 * disk or auto-generates a self-signed certificate that covers `localhost`
 * and `127.0.0.1`.  Generated credentials are cached in a temp directory so
 * the same certificate is reused across restarts (avoiding repeated browser
 * "Accept the risk" prompts).
 *
 * When `extraDomains` are supplied the generated certificate also includes
 * Subject Alternative Names for those hostnames / IP addresses.  A
 * `domains.json` manifest is stored alongside the cached certificate; if the
 * requested domain set differs from the one recorded in the manifest the
 * certificate is regenerated automatically.
 */

import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { generate, type SubjectAltNameEntry } from 'selfsigned';

/** PEM-encoded TLS credentials. */
export interface TlsCredentials {
  cert: string;
  key: string;
  /** True when the cert was auto-generated (self-signed). */
  selfSigned: boolean;
}

/** Directory where the auto-generated certificate is persisted. */
const CACHE_DIR = process.env.LENGCAT_TLS_CACHE_DIR ?? path.join(os.tmpdir(), 'lengcat-vst-tls');

/**
 * Returns TLS credentials for the proxy HTTPS server.
 *
 * Resolution order:
 *  1. If both `certPath` and `keyPath` are given, reads them from disk.
 *  2. Otherwise generates a self-signed certificate (cached in
 *     `$TMPDIR/lengcat-vst-tls/` so the same cert survives restarts).
 *
 * The auto-generated certificate always includes Subject Alternative Names
 * for `localhost`, `127.0.0.1`, and `0.0.0.0`.  Any additional hostnames or
 * IP addresses listed in `extraDomains` are also added to the SANs.
 *
 * Cache invalidation: a `domains.json` manifest is stored alongside the
 * cached certificate.  If the sorted list of `extraDomains` differs from
 * what is recorded in the manifest the certificate is regenerated so that it
 * always covers the currently-requested domains.
 */
export async function loadOrGenerateTls(
  certPath?: string,
  keyPath?: string,
  extraDomains?: string[]
): Promise<TlsCredentials> {
  if (certPath && keyPath) {
    return {
      cert: fs.readFileSync(certPath, 'utf-8'),
      key:  fs.readFileSync(keyPath,  'utf-8'),
      selfSigned: false,
    };
  }

  const cachedCert = path.join(CACHE_DIR, 'cert.pem');
  const cachedKey  = path.join(CACHE_DIR, 'key.pem');
  const cachedMeta = path.join(CACHE_DIR, 'domains.json');

  // Normalise the requested extra-domain list (deduplicate, sort).
  const normalizedExtras = Array.from(new Set(extraDomains ?? [])).sort();

  /** Returns the sorted extra-domain list stored in the cache manifest, or
   *  `null` when the file is missing or cannot be parsed. */
  function readCachedDomains(): string[] | null {
    try {
      return JSON.parse(fs.readFileSync(cachedMeta, 'utf-8')) as string[];
    } catch {
      return null;
    }
  }

  /** True when the cached certificate was generated for the same domain set. */
  function cacheIsValid(): boolean {
    if (!fs.existsSync(cachedCert) || !fs.existsSync(cachedKey)) {
      return false;
    }
    const stored = readCachedDomains();
    if (stored === null) {
      // Legacy cache without a manifest — valid only when no extra domains
      // are requested (backwards-compatible behaviour).
      return normalizedExtras.length === 0;
    }
    return JSON.stringify(stored) === JSON.stringify(normalizedExtras);
  }

  if (cacheIsValid()) {
    return {
      cert: fs.readFileSync(cachedCert, 'utf-8'),
      key:  fs.readFileSync(cachedKey,  'utf-8'),
      selfSigned: true,
    };
  }

  // Build the Subject Alternative Name list.
  // Always include the loopback defaults; append user-supplied entries.
  const altNames: SubjectAltNameEntry[] = [
    { type: 2, value: 'localhost' },
    { type: 7, ip: '127.0.0.1' },
    { type: 7, ip: '0.0.0.0' },
  ];

  for (const domain of normalizedExtras) {
    if (net.isIP(domain)) {
      altNames.push({ type: 7, ip: domain });
    } else {
      altNames.push({ type: 2, value: domain });
    }
  }

  // Use a fixed Common Name; SANs carry the actual hostnames that browsers
  // validate against, so the CN value does not affect certificate matching.
  const attrs = [{ name: 'commonName', value: 'lengcat-vst' }];
  const expiryDate = new Date();
  expiryDate.setFullYear(expiryDate.getFullYear() + 1);

  const pems = await generate(attrs, {
    algorithm: 'sha256',
    notAfterDate: expiryDate,
    extensions: [
      {
        name: 'basicConstraints',
        cA: true,
        critical: true,
      },
      {
        name: 'keyUsage',
        digitalSignature: true,
        keyEncipherment: true,
        keyCertSign: true,
        cRLSign: true,
        critical: true,
      },
      {
        name: 'extKeyUsage',
        serverAuth: true,
      },
      {
        name: 'subjectAltName',
        altNames,
      },
    ],
  });

  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(cachedCert, pems.cert,    { mode: 0o600 });
  fs.writeFileSync(cachedKey,  pems.private, { mode: 0o600 });
  fs.writeFileSync(cachedMeta, JSON.stringify(normalizedExtras), { mode: 0o600 });

  return { cert: pems.cert, key: pems.private, selfSigned: true };
}

/** Path where the auto-generated certificate is cached (for user reference). */
export const tlsCertCachePath = path.join(CACHE_DIR, 'cert.pem');
