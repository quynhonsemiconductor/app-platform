import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A throwaway self-signed key + certificate, generated for this test run with `openssl` (present on every CI image and developer machine
 * we use) and never written to the repository: a committed private key, even a test one, is what secret scanners exist to flag.
 * Returns the PEM the way the product's secret holds it: the key followed by the certificate.
 */
export function generateCertificatePem(): string {
  const dir = mkdtempSync(join(tmpdir(), 'platform-mail-cert-'));
  try {
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '1',
        '-subj',
        '/CN=platform-mail-test',
        '-keyout',
        join(dir, 'key.pem'),
        '-out',
        join(dir, 'cert.pem'),
      ],
      { stdio: 'ignore' },
    );
    return readFileSync(join(dir, 'key.pem'), 'utf8') + readFileSync(join(dir, 'cert.pem'), 'utf8');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
