/**
 * TLS certificate utilities for lengcat-vst.
 *
 * Provides a single helper that either loads an existing cert+key pair from
 * disk or auto-generates a self-signed certificate that covers `localhost`
 * and `127.0.0.1`.  Generated credentials are cached in a temp directory so
 * the same certificate is reused across restarts (avoiding repeated browser
 * "Accept the risk" prompts).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { generate } from 'selfsigned';

/** PEM-encoded TLS credentials. */
export interface TlsCredentials {
  cert: string;
  key: string;
  /** True when the cert was auto-generated (self-signed). */
  selfSigned: boolean;
}

/** Directory where the auto-generated certificate is persisted. */
const CACHE_DIR = path.join(os.tmpdir(), 'lengcat-vst-tls');

/**
 * Returns TLS credentials for the proxy HTTPS server.
 *
 * Resolution order:
 *  1. If both `certPath` and `keyPath` are given, reads them from disk.
 *  2. Otherwise generates a self-signed certificate (cached in
 *     `$TMPDIR/lengcat-vst-tls/` so the same cert survives restarts).
 *
 * The auto-generated certificate includes Subject Alternative Names for
 * `localhost`, `127.0.0.1`, and `0.0.0.0` so it works when the proxy is
 * accessed by any of those addresses.
 */
export async function loadOrGenerateTls(
  certPath?: string,
  keyPath?: string
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

  if (fs.existsSync(cachedCert) && fs.existsSync(cachedKey)) {
    return {
      cert: fs.readFileSync(cachedCert, 'utf-8'),
      key:  fs.readFileSync(cachedKey,  'utf-8'),
      selfSigned: true,
    };
  }

  // Generate a new certificate.
  const attrs = [{ name: 'commonName', value: 'lengcat-vst' }];
  const oneYear = new Date();
  oneYear.setFullYear(oneYear.getFullYear() + 1);

  const pems = await generate(attrs, {
    notAfterDate: oneYear,
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

  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(cachedCert, pems.cert,    { mode: 0o600 });
  fs.writeFileSync(cachedKey,  pems.private, { mode: 0o600 });

  return { cert: pems.cert, key: pems.private, selfSigned: true };
}

/** Path where the auto-generated certificate is cached (for user reference). */
export const tlsCertCachePath = path.join(CACHE_DIR, 'cert.pem');
