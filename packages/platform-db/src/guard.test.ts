/**
 * guardPool: a pool built while the database is down recovers in place when it comes back, a dropped
 * connection does not end the process, and connection attempts back off instead of hammering a
 * database that is starting up (the 2026-11-03 node-reboot incident).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import {
  createTcpGate,
  dockerTestsEnabled,
  startPostgres,
  type PostgresHarness,
  type TcpGate,
} from '@quynhonsemiconductor/testing';
import { guardPool } from './guard';
import { createPool } from './pool';
import { pingDatabase } from './ping';

const quiet = { warn: () => undefined, error: () => undefined };

describe('guardPool without a database', () => {
  let refused: TcpGate; // never opened: nothing listens on its port

  beforeAll(async () => {
    refused = await createTcpGate({ host: '127.0.0.1', port: 1 });
  });

  function refusedPool(max = 4) {
    return new Pool({
      host: refused.host,
      port: refused.port,
      max,
      connectionTimeoutMillis: 2_000,
    });
  }

  /** Counts real dials: pg-pool's `newClient`, spied BEFORE guardPool wraps it. */
  function spyDials(pool: Pool) {
    return vi.spyOn(pool as unknown as { newClient: (item: unknown) => void }, 'newClient');
  }

  it('fails fast while backing off, then dials again once the backoff has passed', async () => {
    let clock = 1_000;
    const pool = refusedPool();
    const dial = spyDials(pool);
    const warnings: string[] = [];
    guardPool(pool, {
      logger: { warn: (m) => warnings.push(m), error: () => undefined },
      minBackoffMs: 100,
      maxBackoffMs: 400,
      now: () => clock,
      target: 'db.test:5432',
    });
    try {
      await expect(pool.query('SELECT 1')).rejects.toMatchObject({ code: 'ECONNREFUSED' });
      expect(dial).toHaveBeenCalledTimes(1);

      // Inside the 100 ms window: same error, no new connection attempt.
      for (let i = 0; i < 5; i += 1) {
        await expect(pool.query('SELECT 1')).rejects.toMatchObject({ code: 'ECONNREFUSED' });
      }
      expect(dial).toHaveBeenCalledTimes(1);

      clock += 100;
      await expect(pool.connect()).rejects.toMatchObject({ code: 'ECONNREFUSED' });
      expect(dial).toHaveBeenCalledTimes(2);

      // The window doubles (200 ms), and is capped at maxBackoffMs.
      clock += 199;
      await expect(pool.connect()).rejects.toThrow();
      expect(dial).toHaveBeenCalledTimes(2);
      clock += 1;
      await expect(pool.connect()).rejects.toThrow();
      expect(dial).toHaveBeenCalledTimes(3);
      clock += 400;
      await expect(pool.connect()).rejects.toThrow();
      clock += 400;
      await expect(pool.connect()).rejects.toThrow();
      expect(dial).toHaveBeenCalledTimes(5);

      // Reported once per outage, naming the target and never a credential.
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(
        /Database connection on db\.test:5432 failed \(.*ECONNREFUSED.*\)/,
      );
    } finally {
      await pool.end();
    }
  });

  it('queued waiters do not dial inside the window either (the queue pump goes through newClient too)', async () => {
    const clock = 1_000; // frozen: everything below happens inside the first window
    const pool = refusedPool(1); // max 1: every caller after the first waits in the queue
    const dial = spyDials(pool);
    guardPool(pool, { logger: quiet, minBackoffMs: 100, now: () => clock });
    try {
      const waiters = Array.from({ length: 6 }, () => pool.connect());
      const results = await Promise.allSettled(waiters);
      expect(results.every((r) => r.status === 'rejected')).toBe(true);
      for (const r of results) {
        expect((r as PromiseRejectedResult).reason).toMatchObject({ code: 'ECONNREFUSED' });
      }
      // One real dial; the five queued waiters were failed fast by the pump, not dialed.
      expect(dial).toHaveBeenCalledTimes(1);
      expect(pool.totalCount).toBe(0);
    } finally {
      await pool.end();
    }
  });

  it('defaults to a monotonic clock, so a wall-clock step back cannot stretch the window', async () => {
    const pool = refusedPool();
    const dial = spyDials(pool);
    guardPool(pool, { logger: quiet, minBackoffMs: 50, maxBackoffMs: 50 });
    try {
      await expect(pool.connect()).rejects.toThrow();
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(Date.now() - 3_600_000); // NTP steps the wall clock back an hour
      await new Promise((resolve) => setTimeout(resolve, 60));
      await expect(pool.connect()).rejects.toThrow();
      expect(dial).toHaveBeenCalledTimes(2); // the window still ended after 50 ms
    } finally {
      vi.useRealTimers();
      await pool.end();
    }
  });

  it('is idempotent: guarding twice does not wrap the dial twice', async () => {
    const pool = refusedPool();
    guardPool(pool, { logger: quiet });
    const internals = pool as unknown as { newClient: unknown };
    const once = internals.newClient;
    expect(guardPool(pool, { logger: quiet })).toBe(pool);
    expect(internals.newClient).toBe(once);
    await pool.end();
  });

  it('listens for pool errors, so an idle client error does not become an uncaught exception', async () => {
    const pool = guardPool(refusedPool(), { logger: quiet });
    expect(pool.listenerCount('error')).toBe(1);
    expect(() => pool.emit('error', new Error('terminating connection'))).not.toThrow();
    await pool.end();
  });
});

describe.skipIf(!(await dockerTestsEnabled()))(
  'guardPool against PostgreSQL 18 that starts late',
  () => {
    let pg: PostgresHarness;
    let gate: TcpGate;

    beforeAll(async () => {
      pg = await startPostgres();
      gate = await createTcpGate({ host: pg.host, port: pg.port });
    }, 180_000);

    afterAll(async () => {
      await gate?.close();
      await pg?.stop();
    }, 60_000);

    const env = () => ({
      ...pg.env(),
      DATABASE_SSL: 'disable',
      DATABASE_HOST: gate.host,
      DATABASE_PORT: String(gate.port),
    });

    it('a pool created before the database is up serves queries once it is, without being recreated', async () => {
      const logs: string[] = [];
      const logger = {
        warn: (m: string) => logs.push(m),
        error: () => undefined,
        log: (m: string) => logs.push(m),
      };
      const pool = createPool(env(), { logger });
      try {
        // The warm-up a product runs at boot, with the database not there yet.
        const warmUp = await Promise.allSettled([pool.connect(), pool.connect()]);
        expect(warmUp.every((r) => r.status === 'rejected')).toBe(true);
        await expect(pingDatabase(pool)).rejects.toMatchObject({ code: 'UNREACHABLE' });

        await gate.open();

        // The same pool object recovers within the backoff cap (5 s).
        await vi.waitFor(() => pingDatabase(pool), { timeout: 8_000, interval: 100 });
        expect(logs.some((l) => /recovered after \d+ failed attempt/.test(l))).toBe(true);

        // The database restarts under an idle client: no crash, and it comes back again.
        await gate.close();
        await expect(pingDatabase(pool)).rejects.toBeDefined();
        await gate.open();
        await vi.waitFor(() => pingDatabase(pool), { timeout: 8_000, interval: 100 });
      } finally {
        await gate.close();
        await pool.end();
      }
    }, 30_000);

    it('a busy pool (queue timeout) is not mistaken for a database outage', async () => {
      await gate.open();
      const pool = createPool(
        { ...env(), DB_POOL_MAX: '1', DB_POOL_CONNECT_TIMEOUT_MS: '100' },
        { logger: quiet },
      );
      try {
        const held = await pool.connect();
        await expect(pool.connect()).rejects.toThrow('timeout exceeded when trying to connect');
        held.release(true); // destroyed, so the next connect has to dial
        expect(pool.totalCount).toBe(0);
        // No backoff was armed: the next caller dials and gets a connection straight away.
        await pingDatabase(pool);
      } finally {
        await gate.close();
        await pool.end();
      }
    });
  },
);
