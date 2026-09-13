import type { CacheService } from '@quynhonsemiconductor/platform-cache';
import { beforeEach, describe, expect, it } from 'vitest';
import { ExclusiveJob } from './exclusive-job.service';

/**
 * Stub cache with the real `SET NX PX` semantics that matter here: acquire succeeds only
 * when the key is absent, and returns false — NOT throws — when the cache is disabled.
 * That false-on-disabled is the behaviour the fail-open path exists to disambiguate.
 */
class StubCache {
  readonly keys = new Set<string>();
  available = true;
  get isAvailable() {
    return this.available;
  }
  acquireLock(key: string) {
    if (!this.available) return Promise.resolve(false);
    if (this.keys.has(key)) return Promise.resolve(false);
    this.keys.add(key);
    return Promise.resolve(true);
  }
  releaseLock(key: string) {
    this.keys.delete(key);
    return Promise.resolve();
  }
}

/** A job that blocks until released, so two "pods" can be in flight at the same instant. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { open, opened };
}

describe('ExclusiveJob', () => {
  let cache: StubCache;
  /** Two instances sharing one cache — the accurate model of two pods, since the
   *  in-process guard is per-instance and would otherwise hide the distributed lock. */
  let podA: ExclusiveJob;
  let podB: ExclusiveJob;

  beforeEach(() => {
    cache = new StubCache();
    podA = new ExclusiveJob(cache as unknown as CacheService);
    podB = new ExclusiveJob(cache as unknown as CacheService);
  });

  it('runs the job on only one pod when two fire at the same time', async () => {
    const g = gate();
    let runs = 0;

    const a = podA.run('sweep', 60_000, async () => {
      runs++;
      await g.opened;
    });
    // B fires while A still holds the lock.
    await podB.run('sweep', 60_000, () => Promise.resolve(void runs++));

    expect(runs, 'the second pod ran the job concurrently').toBe(1);
    g.open();
    await a;
  });

  it('lets the next tick run once the lock is released', async () => {
    let runs = 0;
    await podA.run('sweep', 60_000, () => Promise.resolve(void runs++));
    await podB.run('sweep', 60_000, () => Promise.resolve(void runs++));

    expect(runs, 'the lock was never released, so the job stopped running').toBe(2);
    expect(cache.keys.size).toBe(0);
  });

  it('releases the lock when the job throws', async () => {
    await expect(
      podA.run('sweep', 60_000, () => Promise.reject(new Error('job blew up'))),
    ).rejects.toThrow('job blew up');

    expect(cache.keys.size, 'a throwing job left its lock held for the whole TTL').toBe(0);
    // Proven by the next tick actually running rather than by inspecting state alone.
    let ran = false;
    await podB.run('sweep', 60_000, () => Promise.resolve(void (ran = true)));
    expect(ran).toBe(true);
  });

  it('still runs the job when the cache is unavailable (fails OPEN)', async () => {
    cache.available = false;
    let ran = false;

    await podA.run('sweep', 60_000, () => Promise.resolve(void (ran = true)));

    // The whole point: acquireLock also returns false when there is no client, and treating
    // that as "another pod has it" would silently stop every scheduled job in the system
    // for the length of a cache incident.
    expect(ran, 'a cache outage silently skipped the job instead of running it').toBe(true);
  });

  it('does not start a second run on the same pod while one is in flight', async () => {
    const g = gate();
    let runs = 0;

    const first = podA.run('sweep', 60_000, async () => {
      runs++;
      await g.opened;
    });
    await podA.run('sweep', 60_000, () => Promise.resolve(void runs++));

    expect(runs, 'the same pod overlapped two runs of one job').toBe(1);
    g.open();
    await first;
  });

  it('keeps the in-process guard when there is no cache to lock in', async () => {
    cache.available = false;
    const g = gate();
    let runs = 0;

    const first = podA.run('sweep', 60_000, async () => {
      runs++;
      await g.opened;
    });
    await podA.run('sweep', 60_000, () => Promise.resolve(void runs++));

    // Fail-open gives up cross-POD exclusion, not same-pod overlap protection.
    expect(runs).toBe(1);
    g.open();
    await first;
  });

  it('locks per job name, so unrelated jobs do not block each other', async () => {
    const g = gate();
    let other = 0;

    const first = podA.run('sweep', 60_000, async () => {
      await g.opened;
    });
    await podB.run('other-sweep', 60_000, () => Promise.resolve(void other++));

    expect(other, 'one job held a lock that blocked a different job').toBe(1);
    g.open();
    await first;
  });
});
