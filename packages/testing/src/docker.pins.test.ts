import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { POSTGRES_IMAGE, VALKEY_IMAGE } from './docker';

// The same data-store versions are pinned in compose, CI service containers, Terraform and
// the reference consumer. A floating tag (`postgres:18`, `valkey/valkey:8-alpine`) moves under
// the test suite without a PR, so every image here names an exact patch release.
const REFERENCE_CONSUMER = new URL(
  '../../../reference-consumer/test/support/containers.ts',
  import.meta.url,
);

describe('Testcontainers image pins', () => {
  it('pins PostgreSQL 18 to an exact patch release', () => {
    expect(POSTGRES_IMAGE).toMatch(/^postgres:18\.\d+$/);
  });

  it('pins Valkey 8.1 to an exact patch release', () => {
    expect(VALKEY_IMAGE).toMatch(/^valkey\/valkey:8\.1\.\d+-alpine$/);
  });

  it('reference consumer starts the same images as the testing package', () => {
    const source = readFileSync(REFERENCE_CONSUMER, 'utf8');
    expect(source).toContain(`GenericContainer('${POSTGRES_IMAGE}')`);
    expect(source).toContain(`GenericContainer('${VALKEY_IMAGE}')`);
  });
});
