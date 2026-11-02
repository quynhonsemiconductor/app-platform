import type { Pool, PoolClient } from 'pg';

/** Minimal logger so the core needs no framework. A Nest `Logger` and `console` both fit. */
export interface DbLogger {
  warn(message: string): void;
  error(message: string): void;
  log?(message: string): void;
}

export interface GuardPoolOptions {
  /** Where connection trouble is reported. Default: `console`. */
  logger?: DbLogger;
  /** First wait after a failed connection attempt. Default: 250 ms. */
  minBackoffMs?: number;
  /**
   * Longest wait between connection attempts. Default: 5 000 ms: short against a readiness probe
   * period, so a pod is back within one probe of the database coming back.
   */
  maxBackoffMs?: number;
  /** What the log lines call the server, e.g. `host:port`. Never put credentials here. */
  target?: string;
  /** For tests. */
  now?: () => number;
}

const GUARDED = Symbol.for('@quynhonsemiconductor/platform-db:guarded');

/** pg-pool's own message when a caller waited in the queue for a busy pool: not a database failure. */
const QUEUE_TIMEOUT = 'timeout exceeded when trying to connect';

type ConnectCallback = (
  err: Error | undefined,
  client?: PoolClient,
  done?: (release?: unknown) => void,
) => void;

/**
 * Make a node-postgres pool survive the database going away and coming back, in place.
 *
 * 1. ERROR LISTENERS. pg-pool re-emits an IDLE client's error (the server restarted, a failover,
 *    a node drain: 57P01) on the pool and throws if nobody listens, and an IN-USE client emits
 *    'error' on itself with no listener at all. Either way Node treats it as an uncaught exception
 *    and one dropped connection ends the process. Both get a listener here; the pool discards the
 *    dead client and opens a new one on demand, which is all the recovery there is to do.
 *
 * 2. CONNECTION BACKOFF. While the database is unreachable, every caller (each outbox relay tick,
 *    each readiness probe, each request) would otherwise dial it, and a database that is starting
 *    up or out of slots (53300) is hammered by exactly the clients waiting for it. After a failed
 *    attempt, a connect that WOULD DIAL (no idle client to hand out, room under `max`) fails fast
 *    with the last error until the backoff has passed: 250 ms, doubling, capped at
 *    `maxBackoffMs`. The first success resets it. Nothing is cached beyond that window, so the
 *    pool is never left unusable: the next attempt after it dials for real.
 *
 * Idempotent. Returns the same pool.
 */
export function guardPool<P extends Pool>(pool: P, options: GuardPoolOptions = {}): P {
  const marked = pool as P & { [GUARDED]?: true };
  if (marked[GUARDED]) return pool;
  marked[GUARDED] = true;

  const logger = options.logger ?? console;
  const minBackoffMs = options.minBackoffMs ?? 250;
  const maxBackoffMs = Math.max(minBackoffMs, options.maxBackoffMs ?? 5_000);
  const now = options.now ?? (() => Date.now());
  const on = options.target ? ` on ${options.target}` : '';

  // Logs the driver's message only. pg's messages carry neither the connection string, the user
  // nor the password, and this must not add them.
  pool.on('connect', (client) => {
    client.on('error', (err) => logger.warn(`Database client error${on}: ${err.message}`));
  });
  // The client listener above has already logged it; this only has to exist.
  pool.on('error', () => undefined);

  let failures = 0;
  let retryAt = 0;
  let lastError: Error | undefined;

  const dial = pool.connect.bind(pool) as () => Promise<PoolClient>;
  const max = (pool as unknown as { options: { max?: number } }).options.max ?? 10;

  const attempt = async (): Promise<PoolClient> => {
    const wouldDial = pool.idleCount === 0 && pool.totalCount < max;
    if (wouldDial && lastError && now() < retryAt) throw lastError;
    try {
      const client = await dial();
      if (failures > 0) {
        (logger.log ?? logger.warn).call(
          logger,
          `Database connection${on} recovered after ${failures} failed attempt(s)`,
        );
      }
      failures = 0;
      retryAt = 0;
      lastError = undefined;
      return client;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      if (error.message !== QUEUE_TIMEOUT) {
        failures += 1;
        const delay = Math.min(maxBackoffMs, minBackoffMs * 2 ** Math.min(failures - 1, 20));
        retryAt = now() + delay;
        lastError = error;
        if (failures === 1) {
          logger.warn(
            `Database connection${on} failed (${error.message}); retrying with backoff up to ${maxBackoffMs} ms`,
          );
        }
      }
      throw error;
    }
  };

  // pg-pool calls `this.connect(cb)` from `pool.query`, so the callback form must keep working.
  (
    pool as unknown as { connect: (cb?: ConnectCallback) => Promise<PoolClient> | undefined }
  ).connect = (cb?: ConnectCallback) => {
    const pending = attempt();
    if (!cb) return pending;
    pending.then(
      // `done(err)` is pg's way to discard a broken client rather than return it to the pool.
      (client) => cb(undefined, client, (release?: unknown) => client.release(release as boolean)),
      (err: Error) => cb(err, undefined, () => undefined),
    );
    return undefined;
  };

  return pool;
}
