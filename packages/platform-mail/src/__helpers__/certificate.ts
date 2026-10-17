import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface CertificateOptions {
  /** `rsa` (default) or `ec`: the library refuses an EC key. */
  keyType?: 'rsa' | 'ec';
  /** Protect the key with a passphrase (an `ENCRYPTED PRIVATE KEY`), which the library refuses. */
  encrypted?: boolean;
}

/**
 * A throwaway self-signed key + certificate, generated for this test run with `openssl` (present on every CI image and developer machine
 * we use) and never written to the repository: a committed private key, even a test one, is what secret scanners exist to flag.
 * Returns the PEM the way the product's secret holds it: the key followed by the certificate.
 */
export function generateCertificatePem(options: CertificateOptions = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'platform-mail-cert-'));
  try {
    const args = [
      'req',
      '-x509',
      '-newkey',
      options.keyType === 'ec' ? 'ec' : 'rsa:2048',
      ...(options.keyType === 'ec' ? ['-pkeyopt', 'ec_paramgen_curve:P-256'] : []),
      ...(options.encrypted ? ['-passout', 'pass:not-a-real-passphrase'] : ['-nodes']),
      '-days',
      '1',
      '-subj',
      '/CN=platform-mail-test',
      '-keyout',
      join(dir, 'key.pem'),
      '-out',
      join(dir, 'cert.pem'),
    ];
    execFileSync('openssl', args, { stdio: 'ignore' });
    return readFileSync(join(dir, 'key.pem'), 'utf8') + readFileSync(join(dir, 'cert.pem'), 'utf8');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
