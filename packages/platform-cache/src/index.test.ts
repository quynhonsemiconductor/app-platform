import 'reflect-metadata';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { dockerTestsEnabled, startValkey, type ValkeyHarness } from '@quynhonsemiconductor/testing';

import { CacheModule } from './cache.module';
import { CacheService } from './cache.service';
import { CACHE_OPTIONS } from './cache.types';

// The service runs against a REAL Valkey (packages/testing), not an in-memory double: the
// rate limiter is a Lua script and the lock is `SET NX PX`, so what is under test is the
// server's behaviour. Skipped without Docker locally; on CI a missing Docker fails the run.
const dockerEnabled = await dockerTestsEnabled();

const PREFIX = 'test:';

describe.skipIf(!dockerEnabled)('CacheService (real Valkey)', () => {
  let valkey: ValkeyHarness;
  let service: CacheService;

  beforeAll(async () => {
    valkey = await startValkey();
  }, 120_000);

  afterAll(async () => {
    await valkey?.stop();
  }, 60_000);

  beforeEach(async () => {
    await valkey.flush();
    service = new CacheService({ url: valkey.url, keyPrefix: PREFIX });
    service.onModuleInit();
  });

  afterEach(async () => {
    await service.onApplicationShutdown();
  });

  it('quits in onApplicationShutdown, so jobs and in-flight requests still have the client until then', async () => {
    // Nest runs onModuleDestroy before beforeApplicationShutdown (job runners stop there) and
    // before the HTTP server drains. The ordering itself is proven end to end in
    // platform-runtime's graceful-shutdown test; this pins the hook the client quits in.
    const own = new CacheService({ url: valkey.url, keyPrefix: PREFIX });
    own.onModuleInit();
    await own.set('k', 'v', 60);
    await expect(own.onApplicationShutdown()).resolves.toBeUndefined();
    await expect(own.get('k')).rejects.toThrow(/closed/i);
  });

  it('keeps onModuleDestroy() as a deprecated no-op that does not close the connection', async () => {
    // Non-breaking: a caller of the old hook still compiles, but the client stays usable.
    await service.set('before', 'v', 60);
    await service.onModuleDestroy();
    await service.onModuleDestroy();
    expect(service.isAvailable).toBe(true);
    expect(await service.get('before')).toBe('v');
    await service.set('after', 'v', 60);
    expect(await service.get('after')).toBe('v');
  });

  it('stores and reads a string value with TTL', async () => {
    expect(await service.get('k')).toBeNull();
    await service.set('k', 'v', 60);
    expect(await service.get('k')).toBe('v');
  });

  it('applies the key prefix and the TTL on the server', async () => {
    await service.set('k', 'v', 60);
    expect(await valkey.command('GET', `${PREFIX}k`)).toBe('v');
    const ttl = Number(await valkey.command('TTL', `${PREFIX}k`));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60);
  });

  it('stores no expiry when no TTL is given', async () => {
    await service.set('forever', 'v');
    expect(await valkey.command('TTL', `${PREFIX}forever`)).toBe('-1');
  });

  it('stores and reads a JSON value', async () => {
    expect(await service.getJson('j')).toBeNull();
    await service.setJson('j', { a: 1, b: 'two' }, 60);
    expect(await service.getJson('j')).toEqual({ a: 1, b: 'two' });
  });

  it('returns null for corrupt JSON', async () => {
    await service.set('bad', 'not-json');
    expect(await service.getJson('bad')).toBeNull();
  });

  it('deletes keys', async () => {
    await service.set('d', 'v');
    await service.del('d');
    expect(await service.get('d')).toBeNull();
  });

  it('reports availability and exposes the raw client', async () => {
    expect(service.redis).not.toBeNull();
    expect(() => service.instance).not.toThrow();
    await service.get('warm-up'); // a command resolves only once the connection is ready
    expect(service.isAvailable).toBe(true);
  });

  it('allows requests up to the limit then blocks', async () => {
    const first = await service.consumeRateLimit('login', 2, 60);
    const second = await service.consumeRateLimit('login', 2, 60);
    const third = await service.consumeRateLimit('login', 2, 60);

    expect(first.allowed).toBe(true);
    expect(first.remaining).toBe(1);
    expect(second.allowed).toBe(true);
    expect(second.remaining).toBe(0);
    expect(third.allowed).toBe(false);
    expect(third.resetAt).toBeGreaterThan(0);
  });

  it('admits exactly `limit` of many concurrent requests (the Lua script is atomic)', async () => {
    const results = await Promise.all(
      Array.from({ length: 12 }, () => service.consumeRateLimit('burst', 3, 60)),
    );
    expect(results.filter((r) => r.allowed)).toHaveLength(3);
  });

  it('frees a slot once the window has passed', async () => {
    expect((await service.consumeRateLimit('slide', 1, 1)).allowed).toBe(true);
    expect((await service.consumeRateLimit('slide', 1, 1)).allowed).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect((await service.consumeRateLimit('slide', 1, 1)).allowed).toBe(true);
  });

  it('grants a lock once and refuses a second holder until released', async () => {
    expect(await service.acquireLock('k', 1000)).toBe(true);
    expect(await service.acquireLock('k', 1000)).toBe(false);
    await service.releaseLock('k');
    expect(await service.acquireLock('k', 1000)).toBe(true);
  });

  it('expires a lock on its own so a crashed holder cannot deadlock it', async () => {
    expect(await service.acquireLock('ttl', 300)).toBe(true);
    const pttl = Number(await valkey.command('PTTL', `${PREFIX}lock:ttl`));
    expect(pttl).toBeGreaterThan(0);
    expect(pttl).toBeLessThanOrEqual(300);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(await service.acquireLock('ttl', 300)).toBe(true);
  });

  describe('tryLock: a lock with an owner', () => {
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const stored = async (key: string) =>
      (await valkey.command('GET', `${PREFIX}lock:${key}`)) || null; // the harness gives '' for a missing key

    it('grants a lock once, with a random 32-hex token as the stored value, and refuses a second holder', async () => {
      const lock = await service.tryLock('job', 5_000);
      expect(lock).not.toBeNull();
      expect(lock!.key).toBe('job');
      expect(lock!.token).toMatch(/^[0-9a-f]{32}$/);
      expect(await stored('job')).toBe(lock!.token);
      expect(await service.tryLock('job', 5_000)).toBeNull();
      const pttl = Number(await valkey.command('PTTL', `${PREFIX}lock:job`));
      expect(pttl).toBeGreaterThan(0);
      expect(pttl).toBeLessThanOrEqual(5_000);
    });

    it('every acquisition has its own token', async () => {
      const tokens = new Set<string>();
      for (let i = 0; i < 20; i += 1) {
        const lock = await service.tryLock(`distinct-${i}`, 5_000);
        tokens.add(lock!.token);
      }
      expect(tokens.size).toBe(20);
    });

    it('release frees it for the next holder, once: a second release is false', async () => {
      const lock = (await service.tryLock('r', 5_000))!;
      expect(await lock.release()).toBe(true);
      expect(await lock.release()).toBe(false);
      expect(await stored('r')).toBeNull();
      expect(await service.tryLock('r', 5_000)).not.toBeNull();
    });

    it('a holder that overran its lease does NOT free the lock of whoever took over (the bug a plain DEL had)', async () => {
      const slow = (await service.tryLock('overrun', 200))!;
      await sleep(300); // the lease ran out while the work was still going
      const successor = (await service.tryLock('overrun', 5_000))!;
      expect(successor).not.toBeNull();

      expect(await slow.release()).toBe(false); // it is not ours any more
      expect(await stored('overrun')).toBe(successor.token); // the successor still holds it
      expect(await service.tryLock('overrun', 5_000)).toBeNull(); // so nobody else can take it
      expect(await successor.release()).toBe(true);
    });

    it('extend pushes the lease out while the lock is ours, and says false once it is not', async () => {
      const lock = (await service.tryLock('ext', 300))!;
      expect(await lock.extend(5_000)).toBe(true);
      const pttl = Number(await valkey.command('PTTL', `${PREFIX}lock:ext`));
      expect(pttl).toBeGreaterThan(1_000);
      await lock.release();

      const expiring = (await service.tryLock('ext2', 200))!;
      await sleep(300);
      expect(await expiring.extend(5_000)).toBe(false); // expired: not ours, and not resurrected
      expect(await stored('ext2')).toBeNull();
      const other = (await service.tryLock('ext2', 5_000))!;
      expect(await expiring.extend(60_000)).toBe(false); // someone else's: left alone
      expect(Number(await valkey.command('PTTL', `${PREFIX}lock:ext2`))).toBeLessThanOrEqual(5_000);
      await other.release();
    });

    it('refuses a ttl that is not a positive integer, before touching the cache', async () => {
      for (const ttl of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
        await expect(service.tryLock('bad', ttl)).rejects.toBeInstanceOf(RangeError);
      }
      const lock = (await service.tryLock('bad-extend', 5_000))!;
      await expect(lock.extend(0)).rejects.toBeInstanceOf(RangeError);
      expect(await stored('bad')).toBeNull();
    });

    it('mutual exclusion: of 25 concurrent attempts exactly one wins', async () => {
      const results = await Promise.all(
        Array.from({ length: 25 }, () => service.tryLock('race', 5_000)),
      );
      expect(results.filter((l) => l !== null)).toHaveLength(1);
    });

    it('two processes: one cannot release what the other holds', async () => {
      const other = new CacheService({ url: valkey.url, keyPrefix: PREFIX });
      other.onModuleInit();
      try {
        const mine = (await service.tryLock('shared', 5_000))!;
        expect(await other.tryLock('shared', 5_000)).toBeNull();
        expect(await mine.release()).toBe(true);
        const theirs = (await other.tryLock('shared', 5_000))!;
        expect(await mine.release()).toBe(false);
        expect(await stored('shared')).toBe(theirs.token);
      } finally {
        await other.onApplicationShutdown();
      }
    });
  });

  describe('acquireLock / releaseLock (deprecated) are safe now', () => {
    it('releaseLock releases only what THIS process holds: a lock another process took over survives it', async () => {
      const other = new CacheService({ url: valkey.url, keyPrefix: PREFIX });
      other.onModuleInit();
      try {
        expect(await service.acquireLock('legacy', 200)).toBe(true);
        await new Promise((resolve) => setTimeout(resolve, 300)); // the lease runs out
        expect(await other.acquireLock('legacy', 5_000)).toBe(true); // another pod takes over
        await service.releaseLock('legacy'); // the first one finishes late
        expect(await other.acquireLock('legacy', 5_000)).toBe(false); // still held by the second
        await other.releaseLock('legacy');
        expect(await service.acquireLock('legacy', 5_000)).toBe(true);
      } finally {
        await other.onApplicationShutdown();
      }
    });

    it('releaseLock for a key this process never took does not delete someone else’s lock', async () => {
      const lock = (await service.tryLock('foreign', 5_000))!;
      await service.releaseLock('foreign');
      expect(await valkey.command('GET', `${PREFIX}lock:foreign`)).toBe(lock.token);
      await service.releaseLock('never-taken'); // and is harmless
    });

    it('two holders of one key in ONE process: the first’s late release does not free the second’s live lock', async () => {
      expect(await service.acquireLock('same-process', 200)).toBe(true); // holder A
      await new Promise((resolve) => setTimeout(resolve, 300)); // A overran its lease
      expect(await service.acquireLock('same-process', 5_000)).toBe(true); // holder B took over, same process

      await service.releaseLock('same-process'); // A finishes late: must hit A's own, expired token
      expect(await service.tryLock('same-process', 5_000)).toBeNull(); // B's lock is intact
      expect(await service.acquireLock('same-process', 5_000)).toBe(false);

      await service.releaseLock('same-process'); // B finishes: releases its own
      const free = await service.tryLock('same-process', 5_000);
      expect(free).not.toBeNull();
      await free!.release();
    });

    it('…and if the second finishes FIRST its lock stays held until the first’s call (the documented cost): never freed under anyone', async () => {
      expect(await service.acquireLock('order', 200)).toBe(true); // A
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(await service.acquireLock('order', 5_000)).toBe(true); // B

      await service.releaseLock('order'); // B finishes first: consumes A's expired token
      expect(await service.tryLock('order', 5_000)).toBeNull(); // B's lock is still there (liveness cost)

      await service.releaseLock('order'); // A's late call releases B's (B is done)
      const free = await service.tryLock('order', 5_000);
      expect(free).not.toBeNull();
      await free!.release();
    });

    it('a plain acquire/release cycle repeated in one process leaves nothing behind', async () => {
      for (let i = 0; i < 40; i += 1) {
        expect(await service.acquireLock('cycle', 5_000)).toBe(true);
        await service.releaseLock('cycle');
      }
      expect((service as unknown as { held: Map<string, unknown> }).held.size).toBe(0);
      expect(await service.acquireLock('cycle', 5_000)).toBe(true);
    });

    it('the lock stored by acquireLock has an owner token, not the constant it used to be', async () => {
      expect(await service.acquireLock('tokened', 5_000)).toBe(true);
      expect(await valkey.command('GET', `${PREFIX}lock:tokened`)).toMatch(/^[0-9a-f]{32}$/);
    });
  });
});

describe('CacheService (optional mode, disabled)', () => {
  function makeDisabled(): CacheService {
    const service = new CacheService({ mode: 'optional' });
    service.onModuleInit();
    return service;
  }

  it('degrades gracefully when no url is supplied', async () => {
    const service = makeDisabled();
    expect(service.redis).toBeNull();
    expect(service.isAvailable).toBe(false);
    expect(() => service.instance).toThrow();

    // Generic ops no-op / return empty.
    await service.set('k', 'v');
    expect(await service.get('k')).toBeNull();
    expect(await service.getJson('k')).toBeNull();
    await service.del('k');

    // Rate-limit fails open; locks refuse.
    const rl = await service.consumeRateLimit('x', 5, 60);
    expect(rl.allowed).toBe(true);
    expect(await service.acquireLock('x', 1000)).toBe(false);
    expect(await service.tryLock('x', 1000)).toBeNull();
    await service.releaseLock('x'); // harmless
  });

  it('throws in required mode when no url is supplied', () => {
    const service = new CacheService({ mode: 'required' });
    expect(() => service.onModuleInit()).toThrow();
  });
});

describe('CacheModule', () => {
  it('forRoot wires the options value and the service', () => {
    const mod = CacheModule.forRoot({ url: 'redis://localhost:6379', keyPrefix: 'rova:' });
    expect(mod.module).toBe(CacheModule);
    expect(mod.exports).toContain(CacheService);
    const optionsProvider = (mod.providers ?? []).find(
      (p): p is { provide: symbol; useValue: unknown } =>
        typeof p === 'object' && 'provide' in p && p.provide === CACHE_OPTIONS,
    );
    expect(optionsProvider?.useValue).toEqual({
      url: 'redis://localhost:6379',
      keyPrefix: 'rova:',
    });
  });

  it('forRootAsync exposes an options factory and the service', () => {
    const mod = CacheModule.forRootAsync({
      useFactory: () => ({ url: 'redis://localhost:6379' }),
    });
    expect(mod.module).toBe(CacheModule);
    expect(mod.exports).toContain(CacheService);
    const optionsProvider = (mod.providers ?? []).find(
      (p): p is { provide: symbol; useFactory: () => unknown; inject: unknown[] } =>
        typeof p === 'object' && 'provide' in p && p.provide === CACHE_OPTIONS,
    );
    expect(optionsProvider?.useFactory).toBeTypeOf('function');
  });
});
