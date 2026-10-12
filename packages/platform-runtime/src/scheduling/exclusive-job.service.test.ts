import { Logger } from '@nestjs/common';
import { CacheService } from '@quynhonsemiconductor/platform-cache';
import { createPool } from '@quynhonsemiconductor/platform-db';
import {
  dockerTestsEnabled,
  startPostgres,
  startValkey,
  type PostgresHarness,
  type ValkeyHarness,
} from '@quynhonsemiconductor/testing';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExclusiveJob } from './exclusive-job.service';

const { unlockedAdd } = vi.hoisted(() => ({ unlockedAdd: vi.fn() }));
vi.mock('@quynhonsemiconductor/observability', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getMeter: () => ({ createCounter: () => ({ add: unlockedAdd }) }),
}));

/**
 * Stub cache with the real `SET NX PX` semantics that matter here: acquire succeeds only
 * when the key is absent, and returns false — NOT throws — when the cache is disabled.
 * That false-on-disabled is the behaviour the fail-open path exists to disambiguate.
 */
class StubCache {
  /** key -> the token of the current holder, as in Valkey. */
  readonly keys = new Map<string, string>();
  available = true;
  private next = 0;
  get isAvailable() {
    return this.available;
  }
  tryLock(key: string) {
    if (!this.available) return Promise.resolve(null);
    if (this.keys.has(key)) return Promise.resolve(null);
    const token = `token-${(this.next += 1)}`;
    this.keys.set(key, token);
    return Promise.resolve({
      key,
      token,
      // Compare-and-delete: only the current holder's token frees it.
      release: () => {
        const ours = this.keys.get(key) === token;
        if (ours) this.keys.delete(key);
        return Promise.resolve(ours);
      },
      extend: () => Promise.resolve(this.keys.get(key) === token),
    });
  }
  /** The lease runs out: the key is gone although the holder is still working. */
  expire(key: string) {
    this.keys.delete(key);
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

  it('a job that overruns its lock does NOT free the lock of the pod that took over, and says so', async () => {
    const warns = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const g = gate();
      const slow = podA.run('sweep', 60_000, async () => {
        await g.opened;
      });
      await expect.poll(() => cache.keys.has('cron:sweep')).toBe(true);
      cache.expire('cron:sweep'); // the lease ran out while pod A was still working
      const g2 = gate();
      const takeover = podB.run('sweep', 60_000, async () => {
        await g2.opened;
      });
      await expect.poll(() => cache.keys.get('cron:sweep')).toBe('token-2');

      g.open(); // pod A finishes late and releases
      await slow;
      expect(cache.keys.get('cron:sweep'), 'the late release freed the new holder’s lock').toBe(
        'token-2',
      );
      expect(warns).toHaveBeenCalledWith(expect.stringMatching(/sweep outlived its lock/));

      // So a third pod's tick is still excluded while pod B runs.
      let ran = false;
      await new ExclusiveJob(cache as unknown as CacheService).run('sweep', 60_000, () =>
        Promise.resolve(void (ran = true)),
      );
      expect(ran).toBe(false);
      g2.open();
      await takeover;
      expect(cache.keys.size).toBe(0);
    } finally {
      warns.mockRestore();
    }
  });

  it('a failing release neither masks the job’s error nor fails a good run', async () => {
    const original = cache.tryLock.bind(cache);
    cache.tryLock = async (key: string) => {
      const lock = await original(key);
      return lock && { ...lock, release: () => Promise.reject(new Error('valkey down')) };
    };
    const warns = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      await expect(
        podA.run('sweep', 60_000, () => Promise.reject(new Error('job blew up'))),
      ).rejects.toThrow('job blew up');
      cache.keys.clear();
      await expect(podA.run('sweep', 60_000, () => Promise.resolve())).resolves.toBeUndefined();
      expect(warns).toHaveBeenCalledWith(expect.stringMatching(/releasing the lock failed/));
    } finally {
      warns.mockRestore();
    }
  });

  it('still runs the job when the cache is unavailable (fails OPEN)', async () => {
    cache.available = false;
    let ran = false;

    await podA.run('sweep', 60_000, () => Promise.resolve(void (ran = true)));

    // The whole point: tryLock also returns null when there is no client, and treating
    // that as "another pod has it" would silently stop every scheduled job in the system
    // for the length of a cache incident.
    expect(ran, 'a cache outage silently skipped the job instead of running it').toBe(true);
  });

  it('logs an ERROR and counts an unlocked run when there is neither a cache nor a pool', async () => {
    cache.available = false;
    unlockedAdd.mockClear();
    const errors = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      let ran = false;
      await podA.run('sweep', 60_000, () => Promise.resolve(void (ran = true)));

      expect(ran, 'fail-open must still run the job').toBe(true);
      expect(errors).toHaveBeenCalledWith(expect.stringMatching(/WITHOUT a leader lock/));
      expect(unlockedAdd).toHaveBeenCalledExactlyOnceWith(1, { job: 'sweep' });
    } finally {
      errors.mockRestore();
    }
  });

  it('does not count a normal, locked run as unlocked', async () => {
    unlockedAdd.mockClear();
    await podA.run('sweep', 60_000, () => Promise.resolve());
    expect(unlockedAdd).not.toHaveBeenCalled();
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

const dockerOn = await dockerTestsEnabled();

describe.skipIf(!dockerOn)('ExclusiveJob on a real Valkey lock', () => {
  let valkey: ValkeyHarness;
  const caches: CacheService[] = [];
  const connect = async () => {
    const cache = new CacheService({ url: valkey.url, keyPrefix: 'rt:', mode: 'required' });
    cache.onModuleInit();
    for (let i = 0; i < 100 && !cache.isAvailable; i += 1)
      await new Promise((r) => setTimeout(r, 25));
    caches.push(cache);
    return cache;
  };

  beforeAll(async () => {
    valkey = await startValkey();
  }, 120_000);
  afterAll(async () => {
    await Promise.all(caches.map((c) => c.onApplicationShutdown()));
    await valkey?.stop();
  }, 60_000);
  beforeEach(() => valkey.flush());

  it('two pods on one Valkey: exactly one runs, and the lock is gone afterwards', async () => {
    const podA = new ExclusiveJob(await connect());
    const podB = new ExclusiveJob(await connect());
    const g = gate();
    let runs = 0;
    const a = podA.run('sweep', 60_000, async () => {
      runs++;
      await g.opened;
    });
    await expect.poll(() => runs).toBe(1);
    await podB.run('sweep', 60_000, () => Promise.resolve(void runs++));
    expect(runs).toBe(1);
    g.open();
    await a;
    expect(await valkey.command('EXISTS', 'rt:lock:cron:sweep')).toBe('0');
    await podB.run('sweep', 60_000, () => Promise.resolve(void runs++));
    expect(runs).toBe(2);
  });

  it('a job that overruns a SHORT lease does not free the lock of the pod that took over (real compare-and-delete)', async () => {
    const warns = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      const podA = new ExclusiveJob(await connect());
      const podB = new ExclusiveJob(await connect());
      const g = gate();
      const g2 = gate();
      const slow = podA.run('sweep', 200, async () => {
        await g.opened;
      });
      await expect.poll(async () => valkey.command('EXISTS', 'rt:lock:cron:sweep')).toBe('1');
      await new Promise((r) => setTimeout(r, 300)); // pod A's lease has run out; it is still working
      const takeover = podB.run('sweep', 60_000, async () => {
        await g2.opened;
      });
      await expect
        .poll(async () => valkey.command('TTL', 'rt:lock:cron:sweep'), { timeout: 5_000 })
        .not.toBe('-2');

      g.open();
      await slow; // pod A finishes late and tries to release
      expect(await valkey.command('EXISTS', 'rt:lock:cron:sweep')).toBe('1'); // pod B still holds it
      expect(warns).toHaveBeenCalledWith(expect.stringMatching(/sweep outlived its lock/));
      g2.open();
      await takeover;
      expect(await valkey.command('EXISTS', 'rt:lock:cron:sweep')).toBe('0');
    } finally {
      warns.mockRestore();
    }
  });
});

describe.skipIf(!dockerOn)('ExclusiveJob without a cache, on a Postgres advisory lock', () => {
  let pg: PostgresHarness;
  let poolA: Pool;
  let poolB: Pool;
  const quiet = { warn: () => undefined, error: () => undefined };

  beforeAll(async () => {
    pg = await startPostgres({ tls: true });
  }, 180_000);
  afterAll(async () => {
    await pg?.stop();
  }, 60_000);
  beforeEach(() => {
    // Two pools = two pods: the lock must exclude across connections, not inside one process.
    poolA = createPool({ ...pg.env(), DB_POOL_MAX: '3' }, { logger: quiet });
    poolB = createPool({ ...pg.env(), DB_POOL_MAX: '3' }, { logger: quiet });
    return async () => {
      await Promise.all([poolA.end(), poolB.end()]);
    };
  });

  const noCache = () => {
    const cache = new StubCache();
    cache.available = false;
    return cache as unknown as CacheService;
  };
  const pod = (pool: Pool) => new ExclusiveJob(noCache(), pool);

  it('two pods firing at the same tick: exactly one runs', async () => {
    const g = gate();
    let runs = 0;

    const a = pod(poolA).run('sweep', 60_000, async () => {
      runs++;
      await g.opened;
    });
    await expect.poll(() => runs).toBe(1);
    // B fires while A is inside the job: it must skip, not run unlocked.
    await pod(poolB).run('sweep', 60_000, () => Promise.resolve(void runs++));

    expect(runs, 'both pods ran the job in the same tick').toBe(1);
    g.open();
    await a;
  });

  it('exactly one runs across many simultaneous callers', async () => {
    const g = gate();
    let runs = 0;
    const pods = [pod(poolA), pod(poolB), pod(poolA), pod(poolB), pod(poolA), pod(poolB)];

    const all = Promise.all(
      pods.map((p) =>
        p.run('burst', 60_000, async () => {
          runs++;
          await g.opened;
        }),
      ),
    );
    await expect.poll(() => runs).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 300));
    g.open();
    await all;
    expect(runs).toBe(1);
  });

  it('runs once per tick: the next tick runs again after the lock is released', async () => {
    let runs = 0;
    await pod(poolA).run('sweep', 60_000, () => Promise.resolve(void runs++));
    await pod(poolB).run('sweep', 60_000, () => Promise.resolve(void runs++));
    expect(runs).toBe(2);
  });

  it('releases the lock when the job throws', async () => {
    await expect(
      pod(poolA).run('sweep', 60_000, () => Promise.reject(new Error('job blew up'))),
    ).rejects.toThrow('job blew up');
    let ran = false;
    await pod(poolB).run('sweep', 60_000, () => Promise.resolve(void (ran = true)));
    expect(ran, 'a throwing job left its Postgres lock held').toBe(true);
  });

  it('locks per job name', async () => {
    const g = gate();
    let other = 0;
    const first = pod(poolA).run('one', 60_000, () => g.opened);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await pod(poolB).run('two', 60_000, () => Promise.resolve(void other++));
    expect(other).toBe(1);
    g.open();
    await first;
  });

  it('keeps using the cache lock when the cache IS available (Postgres is only the fallback)', async () => {
    const cache = new StubCache();
    const job = new ExclusiveJob(cache as unknown as CacheService, poolA);
    let seenCacheKey = false;
    await job.run('sweep', 60_000, () => {
      seenCacheKey = cache.keys.has('cron:sweep');
      return Promise.resolve();
    });
    expect(seenCacheKey).toBe(true);
    const { rows } = await poolA.query(`SELECT 1 FROM pg_locks WHERE locktype = 'advisory'`);
    expect(rows).toHaveLength(0);
  });

  it('still fails OPEN (logs at ERROR) when there is neither a cache nor a database pool', async () => {
    let ran = false;
    await new ExclusiveJob(noCache()).run('sweep', 60_000, () =>
      Promise.resolve(void (ran = true)),
    );
    expect(ran).toBe(true);
  });
});
