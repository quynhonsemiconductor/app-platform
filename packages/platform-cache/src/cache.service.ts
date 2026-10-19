import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import Redis from 'ioredis';
import {
  CACHE_OPTIONS,
  type CacheLock,
  type CacheMode,
  type CacheModuleOptions,
} from './cache.types';

/**
 * Shared Valkey/Redis cache primitive (ioredis wrapper).
 *
 * This is the generic *mechanism* — connection lifecycle, key/value access, a
 * sliding-window rate-limit helper, and distributed locks. It carries no domain
 * policy: sessions and their revocation belong to `@quynhonsemiconductor/identity`, and
 * each product owns its own rate-limit/cache policy.
 *
 * Runtime state is per-product: each backend wires its own connection options
 * ({@link CacheModuleOptions}), so importing this shared code never implies a
 * shared Valkey instance.
 */
@Injectable()
export class CacheService implements OnModuleInit, OnModuleDestroy, OnApplicationShutdown {
  private readonly logger = new Logger(CacheService.name);
  private client: Redis | null = null;
  private readonly mode: CacheMode;
  // Named so shutdown can detach them: an ioredis event after shutdown belongs to no running app and must not log.
  private readonly onError = (err: unknown): void => {
    this.logger.error({ err }, 'Cache connection error');
  };
  private readonly onReady = (): void => {
    this.logger.log('Cache ready');
  };

  constructor(@Inject(CACHE_OPTIONS) private readonly options: CacheModuleOptions) {
    this.mode = options.mode ?? 'required';
  }

  onModuleInit(): void {
    const url = this.options.url;
    if (!url) {
      if (this.mode === 'required') {
        throw new Error('CacheService: a connection url is required in "required" mode');
      }
      this.logger.warn('Cache url not set — cache disabled (optional mode)');
      return;
    }

    // NB: lazyConnect MUST be false. With lazyConnect the client stays in the
    // `wait` state until the first command is issued, but callers short-circuit
    // on `isAvailable` (status === 'ready') and never issue a command — so the
    // connection is never established and the cache is permanently reported
    // "unavailable". Eager connect avoids this.
    // Auto-pipelining batches commands issued in the same event-loop tick into a
    // single round trip. `Promise.all([...])` gives concurrency, not batching —
    // without this, two independent reads a guard makes on every request (a
    // session lookup and a revocation check, say) cost two round trips instead of one. The saving
    // applies to any call site that fires independent commands together.
    this.client = new Redis(url, {
      keyPrefix: this.options.keyPrefix,
      enableReadyCheck: true,
      maxRetriesPerRequest: 3,
      lazyConnect: false,
      enableAutoPipelining: true,
    });

    this.client.on('error', this.onError);
    this.client.on('ready', this.onReady);
  }

  /**
   * @deprecated The connection now closes in `onApplicationShutdown` so jobs can finish first;
   * this method does nothing and will be removed in the next major.
   *
   * Kept as a no-op so a product that called `onModuleDestroy()` itself (a test teardown, a manual
   * close) keeps compiling and running. Nest still calls it, first of the close hooks, and it
   * must NOT close the client: jobs and in-flight requests are still using it at that point.
   */
  onModuleDestroy(): void {
    // Intentionally empty. See onApplicationShutdown().
  }

  /**
   * Quit in `onApplicationShutdown`, NOT `onModuleDestroy`. Nest's `close()` runs the hooks in
   * this order: `onModuleDestroy`, `beforeApplicationShutdown`, close the HTTP server,
   * `onApplicationShutdown`. Anything that stops work using the cache (a job runner, in
   * `beforeApplicationShutdown`) or serves requests that use it (the HTTP drain) must finish
   * first; a destroy hook runs before all of them, so the client used to be gone while jobs and
   * in-flight requests were still reading and locking through it.
   */
  async onApplicationShutdown(): Promise<void> {
    const client = this.client;
    if (!client) return;
    // Before the quit: a ready event can fire while quit is pending (quit queues behind offline commands during connect).
    client.off('ready', this.onReady);
    try {
      await client.quit();
    } finally {
      client.off('error', this.onError);
      // With no error listener, ioredis prints its own unhandled-error line for an error after the quit; that line is not the log contract.
      client.on('error', () => undefined);
    }
  }

  /** Raw ioredis client, or `null` when the cache is disabled (optional mode). */
  get redis(): Redis | null {
    return this.client;
  }

  /**
   * Raw ioredis client; throws if the cache is disabled. Use in `required`-mode
   * contexts where the connection is guaranteed to exist.
   */
  get instance(): Redis {
    if (!this.client) {
      throw new Error('CacheService: client is not available (cache disabled)');
    }
    return this.client;
  }

  /** Whether the cache connection is established and ready to serve commands. */
  get isAvailable(): boolean {
    return this.client?.status === 'ready';
  }

  // ── Generic key/value ────────────────────────────────────────────────────────

  /** Set a key with optional TTL (seconds). No-op when the cache is disabled. */
  async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (!this.client) return;
    if (ttlSeconds) {
      await this.client.setex(key, ttlSeconds, value);
    } else {
      await this.client.set(key, value);
    }
  }

  /** Get a key. Returns `null` if not found or the cache is disabled. */
  async get(key: string): Promise<string | null> {
    return this.client?.get(key) ?? null;
  }

  /** Set a JSON-serializable value with optional TTL (seconds). */
  async setJson<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    await this.set(key, JSON.stringify(value), ttlSeconds);
  }

  /** Get and parse a JSON value. Returns `null` if missing, disabled, or corrupt. */
  async getJson<T>(key: string): Promise<T | null> {
    const raw = await this.get(key);
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      this.logger.warn(`Corrupt JSON in cache for key ${key} — ignoring`);
      return null;
    }
  }

  /** Delete one or more keys. No-op when the cache is disabled. */
  async del(...keys: string[]): Promise<void> {
    if (!this.client || keys.length === 0) return;
    await this.client.del(...keys);
  }

  // ── Rate-limit (atomic sliding-window log via sorted sets) ───────────────────

  /**
   * Atomic sliding-window rate limiter, evaluated server-side in a single Lua
   * call: evict entries older than the window, count what remains, then admit
   * (record the request) or reject. A true sliding window avoids the burst that
   * a fixed-window counter allows at window boundaries.
   *
   * Returns `{ allowed, remaining, resetAt }` where `resetAt` is the Unix-seconds
   * timestamp at which the window next frees a slot. Fails open (allowed) when
   * the cache is disabled so a missing cache never blocks traffic.
   *
   * This is a generic mechanism; rate-limit *policy* (tiers, limits, which routes)
   * stays in each product's guard.
   */
  async consumeRateLimit(
    key: string,
    limit: number,
    windowSeconds: number,
  ): Promise<{ allowed: boolean; remaining: number; resetAt: number; id?: string }> {
    const windowMs = windowSeconds * 1000;
    const nowMs = Date.now();

    if (!this.client) {
      return { allowed: true, remaining: limit, resetAt: Math.floor(nowMs / 1000) + windowSeconds };
    }

    // Unique member so multiple requests in the same millisecond each get a slot. It is also the slot's id: pass it
    // to refundRateLimit to give the slot back.
    const member = `${nowMs}:${Math.random().toString(36).slice(2, 10)}`;
    const [allowed, remaining, resetAtMs] = (await this.client.eval(
      CacheService.SLIDING_WINDOW_LUA,
      1,
      `rl:${key}`,
      String(nowMs),
      String(windowMs),
      String(limit),
      member,
    )) as [number, number, number];

    const admitted = Number(allowed) === 1;
    return {
      allowed: admitted,
      remaining: Math.max(0, Number(remaining)),
      resetAt: Math.ceil(Number(resetAtMs) / 1000),
      ...(admitted ? { id: member } : {}),
    };
  }

  /**
   * Gives back one slot taken by `consumeRateLimit`, by the `id` it returned. Removes exactly that entry from the
   * window, so a request that did not go on to count (a refused reply, a request that succeeded and should not have
   * used the address's budget) frees its slot for the next one, and no other.
   *
   * Refunding an entry that is already gone is a no-op. With no cache there is nothing to refund. A cache error is
   * thrown, as `consumeRateLimit` throws: the caller decides whether a failed refund matters to its request.
   */
  async refundRateLimit(key: string, id: string): Promise<void> {
    if (!this.client) return;
    await this.client.zrem(`rl:${key}`, id);
  }

  /**
   * Sliding-window admission control over a sorted set scored by request time
   * (ms). Returns `{ allowed, remaining, resetAtMs }`.
   */
  private static readonly SLIDING_WINDOW_LUA = `
local key    = KEYS[1]
local now    = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit  = tonumber(ARGV[3])
local member = ARGV[4]

redis.call('ZREMRANGEBYSCORE', key, '-inf', now - window)
local count = redis.call('ZCARD', key)

if count < limit then
  redis.call('ZADD', key, now, member)
  redis.call('PEXPIRE', key, window)
  return {1, limit - count - 1, now + window}
else
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  return {0, 0, tonumber(oldest[2]) + window}
end
`;

  // ── Distributed locks (SET NX PX with an owner token) ────────────────────────

  /** Delete the lock only if it still holds our token. */
  private static readonly RELEASE_LUA =
    "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

  /** Push the lease out only if the lock still holds our token. */
  private static readonly EXTEND_LUA =
    "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end";

  /**
   * Try to take the distributed lock `key` for `ttlMs` milliseconds. Resolves a {@link CacheLock}, or `null` when
   * it is already held (or the cache is disabled: check {@link isAvailable} to tell the two apart).
   *
   * The value stored is a random token, and `release()` / `extend()` are server-side compare-and-delete /
   * compare-and-expire on it. That is what makes it safe: a holder that overruns its lease and then releases
   * does NOT free the lock of whoever acquired it after the lease expired. The lease still has to be longer than
   * the work (or renewed with `extend`); a lock cannot make an overrunning job stop.
   *
   * ```ts
   * const lock = await cache.tryLock('nightly-report', 60_000);
   * if (!lock) return; // someone else has it
   * try { await work(); } finally { await lock.release(); }
   * ```
   */
  async tryLock(key: string, ttlMs: number): Promise<CacheLock | null> {
    if (!Number.isInteger(ttlMs) || ttlMs <= 0) {
      throw new RangeError('CacheService.tryLock: ttlMs must be a positive integer');
    }
    if (!this.client) return null;
    const token = randomBytes(16).toString('hex');
    const lockKey = `lock:${key}`;
    const result = await this.client.set(lockKey, token, 'PX', ttlMs, 'NX');
    if (result !== 'OK') return null;

    let released = false;
    return {
      key,
      token,
      release: async () => {
        if (released || !this.client) return false;
        released = true;
        return Number(await this.client.eval(CacheService.RELEASE_LUA, 1, lockKey, token)) === 1;
      },
      extend: async (extendMs: number) => {
        if (!Number.isInteger(extendMs) || extendMs <= 0) {
          throw new RangeError('CacheLock.extend: ttlMs must be a positive integer');
        }
        if (released || !this.client) return false;
        return (
          Number(await this.client.eval(CacheService.EXTEND_LUA, 1, lockKey, token, extendMs)) === 1
        );
      },
    };
  }

  /**
   * Locks taken through {@link acquireLock} by THIS process, oldest first, per key. A list, not one entry: two
   * holders of one key in one process (the first overran its lease, the second took over) both leave a token,
   * and {@link releaseLock} must not mistake the second's for the first's.
   */
  private readonly held = new Map<string, Array<{ lock: CacheLock; until: number }>>();

  /**
   * @deprecated Use {@link tryLock}, which returns the lock to release.
   *
   * Attempt to acquire a distributed lock. Returns true if the lock was acquired, false if already held (or the
   * cache is disabled). The lock auto-expires after ttlMs to prevent deadlocks on pod crash.
   *
   * Since this version it takes a random-token lock under the hood and remembers it in this process, so
   * {@link releaseLock} can release only what this process holds.
   */
  async acquireLock(key: string, ttlMs: number): Promise<boolean> {
    const lock = await this.tryLock(key, ttlMs);
    if (!lock) return false;
    const now = Date.now();
    if (this.held.size >= 1000) {
      for (const [k, entries] of this.held) {
        const live = entries.filter((entry) => entry.until > now);
        if (live.length === 0) this.held.delete(k);
        else this.held.set(k, live);
      }
    }
    const entries = this.held.get(key) ?? [];
    entries.push({ lock, until: now + ttlMs });
    // Bounded: tokens older than a handful of takeovers are long expired and could only release nothing.
    if (entries.length > 16) entries.shift();
    this.held.set(key, entries);
    return true;
  }

  /**
   * @deprecated Use the {@link CacheLock} that {@link tryLock} returns.
   *
   * Release a lock THIS process took with {@link acquireLock}, if it is still ours (compare-and-delete). Safe to
   * call when the lock has expired, was never taken here, or the cache is disabled: it then does nothing. It
   * used to delete `lock:{key}` whoever held it, so a holder that overran its lease freed the lock of the one
   * that had taken over; a lock taken by ANOTHER process is no longer deletable from here.
   *
   * **Limit of this API, and why `tryLock` exists:** `releaseLock(key)` carries no handle, so when one process has
   * held the same key more than once (the first holder overran its lease and a second took over) it cannot tell
   * the callers apart. It releases the OLDEST remembered lock first. That is the safe choice: the first
   * holder's late release hits its own, long expired token and does nothing, so it can never free the second
   * holder's live lock. The cost is liveness, not safety: if the second holder finishes first, its call
   * consumes the first token and its own lock stays held until the first holder's call or the lease. Only
   * `tryLock` tells holders apart.
   */
  async releaseLock(key: string): Promise<void> {
    const entries = this.held.get(key);
    const oldest = entries?.shift();
    if (!oldest) return;
    if (entries!.length === 0) this.held.delete(key);
    await oldest.lock.release();
  }
}
