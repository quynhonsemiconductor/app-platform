import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * `reference-consumer/` owns a COPY of identity's reference tables (a product generates its own with
 * `auth generate`). The copy is a snapshot, so a change to the workspace's reference schema or DDL
 * that does not update it used to be found only AFTER the release, by the consumer's post-release run
 * on main (identity 8.4.0 and 8.4.1 both). This runs on every pull request, in the required `Tests`
 * job, so the pull request that changes the tables is the one that fails.
 *
 * To fix a failure: copy `packages/identity/src/testing/reference-schema.ts` and `reference-ddl.ts`
 * over `reference-consumer/src/schema.ts` and `schema-ddl.ts` (keep the consumer's header comment).
 * Pinning the consumer to the new identity version is a separate, later step: it can only happen once
 * that version is published (`reference-consumer/README.md`, "Following an identity release").
 */
const repo = join(import.meta.dirname, '..');

/** The code of a file: from its first `import` (schema) or `export const` (DDL), dropping header comments. */
const code = (path: string, start: RegExp): string => {
  const text = readFileSync(join(repo, path), 'utf8');
  const at = text.search(start);
  if (at < 0) throw new Error(`${path}: no ${start} found`);
  return text.slice(at);
};

describe('the reference consumer snapshot follows the workspace identity package', () => {
  it('schema.ts is packages/identity/src/testing/reference-schema.ts', () => {
    expect(code('reference-consumer/src/schema.ts', /^import /m)).toBe(
      code('packages/identity/src/testing/reference-schema.ts', /^import /m),
    );
  });

  it('schema-ddl.ts is packages/identity/src/testing/reference-ddl.ts', () => {
    expect(code('reference-consumer/src/schema-ddl.ts', /^export const /m)).toBe(
      code('packages/identity/src/testing/reference-ddl.ts', /^export const /m),
    );
  });
});
