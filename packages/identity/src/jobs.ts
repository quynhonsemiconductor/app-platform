import { DEFAULTS } from './defaults';
import { identityInternals, purgeUnverifiedAccounts, type Identity } from './create-identity';
import type { JobRegistry } from './ports';

/**
 * Register the one scheduled job identity owns: the 72-hour purge of unverified accounts
 * (ADR 0002, decision 2, rule 3). `jobs` is `platform-jobs`; the schedule is a singleton, so any
 * number of worker replicas run it once per tick. Call it from the worker process only. A product
 * that has not adopted `platform-jobs` can call {@link purgeUnverifiedAccounts} from a scheduler of
 * its own that runs it on one replica at a time.
 */
export async function registerIdentityJobs(jobs: JobRegistry, auth: Identity): Promise<void> {
  if (!identityInternals(auth))
    throw new Error('identity: registerIdentityJobs needs an instance from createIdentity()');
  const { queue, cron, tz } = DEFAULTS.purge;
  await jobs.handle(queue, async () => {
    await purgeUnverifiedAccounts(auth);
  });
  await jobs.schedule(queue, cron, {}, { tz });
}
