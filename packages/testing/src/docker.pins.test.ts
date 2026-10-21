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

/** Every image literal passed to `new GenericContainer(...)` in the file, in order. */
function containerImages(source: string): string[] {
  return [...source.matchAll(/new GenericContainer\(\s*'([^']+)'\s*\)/g)].map((m) => m[1]);
}

describe('Testcontainers image pins', () => {
  it('pins PostgreSQL 18 to an exact patch release', () => {
    expect(POSTGRES_IMAGE).toMatch(/^postgres:18\.\d+$/);
  });

  it('pins Valkey 8.1 to an exact patch release', () => {
    expect(VALKEY_IMAGE).toMatch(/^valkey\/valkey:8\.1\.\d+-alpine$/);
  });

  it('every postgres and valkey container the reference consumer starts equals the package constant', () => {
    const images = containerImages(readFileSync(REFERENCE_CONSUMER, 'utf8'));
    const postgres = images.filter((image) => image.startsWith('postgres:'));
    const valkey = images.filter((image) => image.startsWith('valkey/valkey:'));
    expect(postgres.length).toBeGreaterThan(0);
    expect(valkey.length).toBeGreaterThan(0);
    expect(postgres).toEqual(postgres.map(() => POSTGRES_IMAGE));
    expect(valkey).toEqual(valkey.map(() => VALKEY_IMAGE));
  });
});
