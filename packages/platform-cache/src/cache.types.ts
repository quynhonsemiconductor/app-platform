/**
 * Connection mode for the shared cache primitive.
 *
 * - `required` (default): a URL must be supplied; the client connects eagerly and
 *   {@link CacheService.instance} is always available. Use when the cache is on a
 *   critical path (e.g. auth denylist) and the service must fail loudly if misconfigured.
 * - `optional`: a missing URL disables the cache gracefully (methods no-op / return
 *   empty) instead of throwing. Use when the product treats cache as best-effort and
 *   fails open when it is unavailable.
 */
export type CacheMode = 'optional' | 'required';

/**
 * Options for the shared Valkey/Redis cache primitive used across QNSC product backends.
 */
export interface CacheModuleOptions {
  /**
   * Valkey/Redis connection URL, e.g. `redis://localhost:6379`. May be omitted only
   * in `optional` mode, in which case the cache is disabled.
   */
  url?: string;
  /**
   * Key prefix applied to every key (namespacing, e.g. `rova:` / `opshub:`),
   * so multiple products may share a node without colliding.
   */
  keyPrefix?: string;
  /** Connection mode. Defaults to `required`. */
  mode?: CacheMode;
}

/** DI token carrying the resolved {@link CacheModuleOptions}. */
export const CACHE_OPTIONS = Symbol('CACHE_OPTIONS');

/**
 * A held distributed lock (see {@link CacheService.tryLock}). It belongs to whoever acquired it: `release` and
 * `extend` act only while the lock is still THEIRS, so a holder whose lease ran out can never release or extend
 * the lock of whoever took it over.
 */
export interface CacheLock {
  /** The key as passed to `tryLock` (the stored key is `lock:{key}`, with the cache's prefix). */
  readonly key: string;
  /** The random token stored as the lock's value: 32 hex characters, unique per acquisition. */
  readonly token: string;
  /**
   * Release the lock if it is still ours (compare-and-delete). Resolves `true` when it was released, `false` when
   * it was not ours any more (the lease expired, and perhaps someone else holds it) or was already released.
   * Never deletes another holder's lock.
   */
  release(): Promise<boolean>;
  /**
   * Push the lease out to `ttlMs` from now if the lock is still ours. Resolves `true` when extended, `false`
   * when it is not ours any more: the caller has lost the lock and must stop.
   */
  extend(ttlMs: number): Promise<boolean>;
}
