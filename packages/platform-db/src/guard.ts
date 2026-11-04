import { performance } from 'node:perf_hooks';
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
  /** Monotonic milliseconds. Default: `performance.now()`, so a wall-clock step cannot stretch the window. For tests. */
  now?: () => number;
}

const GUARDED = Symbol.for('@quynhonsemiconductor/platform-db:guarded');

/** pg-pool's internal queue entry, as `newClient` receives it. */
interface PendingItem {
  callback: (
    err: Error | undefined,
    client?: PoolClient,
    done?: (release?: unknown) => void,
  ) => void;
  timedOut?: boolean;
}

/** The pg-pool internals the backoff hooks into (pg-pool 3.x). */
interface PoolInternals {
  Client: new (...args: never[]) => {
    connect(callback?: (err?: Error) => void): Promise<void> | void;
  };
  newClient(pendingItem: PendingItem): void;
  _pulseQueue(): void;
}

const NOOP = () => undefined;

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
 *    dial, every further dial fails fast with the last error until the backoff has passed: 250 ms,
 *    doubling, capped at `maxBackoffMs`. The first successful dial resets it. Handing out an idle
 *    client is never gated, and nothing is cached beyond the window, so the pool is never left
 *    unusable: the next dial after it is real.
 *
 *    The gate sits on pg-pool's `newClient`, the one place every dial goes through: `connect()`
 *    calls it directly, and so does the queue pump (`_pulseQueue`) for callers that waited in the
 *    queue while the pool was full. Gating only `connect()` would let queued waiters dial straight
 *    through the window.
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
  const now = options.now ?? (() => performance.now());
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

  const record = (err: Error | undefined) => {
    if (err) {
      failures += 1;
      const delay = Math.min(maxBackoffMs, minBackoffMs * 2 ** Math.min(failures - 1, 20));
      retryAt = now() + delay;
      lastError = err;
      if (failures === 1) {
        logger.warn(
          `Database connection${on} failed (${err.message}); retrying with backoff up to ${maxBackoffMs} ms`,
        );
      }
      return;
    }
    if (failures > 0) {
      (logger.log ?? logger.warn).call(
        logger,
        `Database connection${on} recovered after ${failures} failed attempt(s)`,
      );
    }
    failures = 0;
    retryAt = 0;
    lastError = undefined;
  };

  const internals = pool as unknown as PoolInternals;
  // pg-pool's internals are not a public API. If a future pg-pool reshapes them, keep the listeners
  // and say so, rather than install a gate that silently never runs.
  if (
    typeof internals.newClient !== 'function' ||
    typeof internals._pulseQueue !== 'function' ||
    typeof internals.Client !== 'function'
  ) {
    logger.warn('guardPool: unsupported pg-pool version; connection backoff is disabled');
    return pool;
  }

  // The outcome is recorded in the client's own connect callback, which runs BEFORE pg-pool's: on
  // a failure pg-pool pumps the queue first and only then answers the caller, so recording it any
  // later would let the next queued waiter dial before the window opened.
  const Base = internals.Client;
  internals.Client = class extends Base {
    connect(callback?: (err?: Error) => void) {
      if (!callback) return super.connect();
      return super.connect((err?: Error) => {
        record(err);
        callback(err);
      });
    }
  };

  const dial = internals.newClient.bind(pool);
  internals.newClient = (pendingItem: PendingItem) => {
    if (lastError && now() < retryAt) {
      // No client was created, so nothing will pump the queue for the next waiter: do it here,
      // on the next tick so a long queue drains without deep recursion.
      process.nextTick(() => internals._pulseQueue());
      if (!pendingItem.timedOut) pendingItem.callback(lastError, undefined, NOOP);
      return;
    }
    dial(pendingItem);
  };

  return pool;
}
