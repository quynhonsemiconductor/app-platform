import { getContainerRuntimeClient } from 'testcontainers';

/**
 * Default images, pinned to exact patch releases so a test run is reproducible and a bump is a
 * reviewed change. The same versions run in the local compose stacks and in CI service containers.
 *
 * Valkey is 8.1, the same engine as ElastiCache's Valkey 8 target. Do not "upgrade" it to 8.2:
 * ElastiCache's "8.2" is open-source Valkey 8.1 plus the valkey-search module, and there is no
 * valkey/valkey:8.2 image to pin.
 *
 * PostgreSQL is the Debian image, not `-alpine`: production runs CloudNativePG on Debian, and
 * musl's collation differs from glibc's, so an Alpine test database can order and compare text
 * differently from the one the code ships against.
 */
export const POSTGRES_IMAGE = 'postgres:18.6';
export const VALKEY_IMAGE = 'valkey/valkey:8.1.10-alpine';

/**
 * Whether a container runtime is reachable.
 *
 * Never throws: an unreachable runtime is an answer, not an error.
 */
export async function isDockerAvailable(): Promise<boolean> {
  try {
    await getContainerRuntimeClient();
    return true;
  } catch {
    return false;
  }
}

/**
 * Decide whether a Docker-backed suite should run. Use it as
 * `describe.skipIf(!(await dockerTestsEnabled()))(...)`.
 *
 * - Docker reachable: run.
 * - Docker unreachable on a developer machine: skip, so `pnpm test` still works offline.
 * - Docker unreachable when `CI` is set: THROW. A skipped suite counts as a pass, so on CI a
 *   missing runtime would silently turn the whole database layer into "green, tested nothing".
 */
export async function dockerTestsEnabled(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  if (await isDockerAvailable()) return true;
  if (env['CI']) {
    throw new Error(
      'Docker is not reachable but CI is set. Docker-backed tests must run on CI, not skip.',
    );
  }
  console.warn('[testing] Docker is not reachable; skipping Docker-backed tests.');
  return false;
}
