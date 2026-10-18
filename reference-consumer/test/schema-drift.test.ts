import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REFERENCE_DDL as PUBLISHED_DDL } from '@quynhonsemiconductor/identity/testing';
import { REFERENCE_DDL } from '../src/schema-ddl';

/**
 * The consumer owns a COPY of identity's reference tables (a product generates its own with
 * `auth generate`). The copy follows the WORKSPACE package: `tools/reference-consumer-snapshot.test.ts`
 * fails the pull request that changes the tables without updating it.
 *
 * This test checks the other side, against the PUBLISHED package. It compares only when the installed
 * identity is the version the workspace is at, because only then do the two describe the same tables:
 *   - the consumer is pinned to a release older than the workspace (a table change merged, release not
 *     published yet): the copy is rightly ahead of the pin, and comparing would fail a correct state;
 *   - the post-release run installed the newest published version while main already moved on: same.
 * It is a skip with a reason, never a pass, and the post-release run for the release that carries the
 * change installs exactly the workspace version, so that release is always compared.
 */
const installed = (
  JSON.parse(
    readFileSync(
      join(import.meta.dirname, '../node_modules/@quynhonsemiconductor/identity/package.json'),
      'utf8',
    ),
  ) as { version: string }
).version;
const workspace = (
  JSON.parse(
    readFileSync(join(import.meta.dirname, '../../packages/identity/package.json'), 'utf8'),
  ) as { version: string }
).version;

describe('the consumer schema', () => {
  it.skipIf(installed !== workspace)(
    `is the DDL the published identity ships (installed ${installed}, workspace ${workspace})`,
    () => {
      expect(REFERENCE_DDL).toBe(PUBLISHED_DDL);
    },
  );
});
