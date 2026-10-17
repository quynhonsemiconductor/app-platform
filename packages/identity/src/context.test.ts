import { describe, expect, it, vi } from 'vitest';
import {
  chainCreateBefore,
  contextIdOf,
  createContextRuntime,
  validateContextOptions,
  type ContextOptions,
} from './context';

const A = '0194a000-0000-7000-8000-00000000000a';
const B = '0194a000-0000-7000-8000-00000000000b';
const U = '0194a000-0000-7000-8000-0000000000u1'.replace('u', '0');

const quiet = { warn: () => undefined, error: () => undefined };
const deps = (events: unknown[] = [], degradedCount: () => number = () => 0) => ({
  sink: { emit: (e: unknown) => void events.push(e) },
  onSinkError: () => undefined,
  logger: quiet,
  degradedCount,
});

describe('validateContextOptions', () => {
  it('accepts the documented shapes', () => {
    expect(() => validateContextOptions(undefined)).not.toThrow();
    expect(() => validateContextOptions({ membership: () => true })).not.toThrow();
    expect(() =>
      validateContextOptions({ membership: () => true, initial: () => A, revalidateSeconds: 0 }),
    ).not.toThrow();
    expect(() =>
      validateContextOptions({ membership: () => true, revalidateSeconds: 3600 }),
    ).not.toThrow();
  });

  const bad: unknown[][] = [
    [{}],
    [null],
    [{ membership: 'x' }],
    [{ membership: () => true, initial: 5 }],
    [{ membership: () => true, revalidateSeconds: -1 }],
    [{ membership: () => true, revalidateSeconds: 0.5 }],
    [{ membership: () => true, revalidateSeconds: 3601 }],
    [{ membership: () => true, revalidateSeconds: '60' }],
  ];
  it.each(bad)('refuses %j', (option) => {
    expect(() => validateContextOptions(option as unknown as ContextOptions)).toThrow(/context/);
  });
});

describe('contextIdOf', () => {
  it('returns a UUID context and null for everything else', () => {
    expect(contextIdOf({ session: { contextId: A } })).toBe(A);
    for (const v of [null, undefined, 7, 'x', {}, { session: {} }, { session: { contextId: 'x' } }])
      expect(contextIdOf(v)).toBeNull();
  });
});

describe('chainCreateBefore', () => {
  it('merges the data of each hook and shows later hooks what earlier ones added', async () => {
    const seen: unknown[] = [];
    const chain = chainCreateBefore(
      async () => ({ data: { expiresAt: 1 } }),
      async (s) => {
        seen.push(s);
        return { data: { contextId: A } };
      },
      undefined,
    );
    expect(await chain({ userId: 'u' }, null)).toEqual({ data: { expiresAt: 1, contextId: A } });
    expect(seen[0]).toMatchObject({ userId: 'u', expiresAt: 1 });
  });

  it('a hook that returns false stops the chain; a hook that throws stops it too', async () => {
    const later = vi.fn();
    expect(await chainCreateBefore(async () => false as const, later)({}, null)).toBe(false);
    await expect(
      chainCreateBefore(() => {
        throw new Error('refused');
      }, later)({}, null),
    ).rejects.toThrow('refused');
    expect(later).not.toHaveBeenCalled();
  });

  it('returns nothing when no hook returned data', async () => {
    expect(await chainCreateBefore(async () => undefined)({}, null)).toBeUndefined();
  });
});

describe('the session-create hook and the fallback', () => {
  it('starts a session in initial() only when membership approves it', async () => {
    const asked: Array<[string, string]> = [];
    const runtime = createContextRuntime(
      {
        membership: async (u, c) => {
          asked.push([u, c]);
          return c === A;
        },
        initial: async () => A,
      },
      deps(),
    );
    expect(await runtime.createBefore({ userId: U })).toEqual({ data: { contextId: A } });
    expect(asked).toEqual([[U, A]]);

    const refused = createContextRuntime({ membership: () => false, initial: () => A }, deps());
    expect(await refused.createBefore({ userId: U })).toEqual({ data: { contextId: null } });
  });

  it('never trusts a contextId that came with the row', async () => {
    const runtime = createContextRuntime({ membership: () => true }, deps());
    expect(await runtime.createBefore({ userId: U, contextId: B })).toEqual({
      data: { contextId: null },
    });
  });

  it('a session row with no user id is left alone', async () => {
    const runtime = createContextRuntime({ membership: () => true, initial: () => A }, deps());
    expect(await runtime.createBefore({})).toBeUndefined();
  });
});

describe('the findSession guard', () => {
  const adapterWith = (session: Record<string, unknown>) => {
    const updates: Array<[string, Record<string, unknown>]> = [];
    const adapter = {
      findSession: vi.fn(async (_token: string) => ({ session: { ...session }, user: { id: U } })),
      updateSession: vi.fn(async (token: string, data: Record<string, unknown>) => {
        updates.push([token, data]);
      }),
    };
    return { adapter, updates };
  };

  it('installs once per adapter', async () => {
    const { adapter } = adapterWith({ token: 't', contextId: A });
    const runtime = createContextRuntime({ membership: () => true }, deps());
    runtime.install({ internalAdapter: adapter });
    const wrapped = adapter.findSession;
    runtime.install({ internalAdapter: adapter });
    expect(adapter.findSession).toBe(wrapped);
  });

  it('keeps a context the user still belongs to, and asks again only after the window', async () => {
    const { adapter } = adapterWith({ token: 't', contextId: A });
    const membership = vi.fn(async () => true);
    const runtime = createContextRuntime({ membership, revalidateSeconds: 3600 }, deps());
    runtime.install({ internalAdapter: adapter });
    await adapter.findSession('t');
    await adapter.findSession('t');
    expect(membership).toHaveBeenCalledTimes(1);

    const always = vi.fn(async () => true);
    const zero = createContextRuntime({ membership: always, revalidateSeconds: 0 }, deps());
    const other = adapterWith({ token: 't', contextId: A });
    zero.install({ internalAdapter: other.adapter });
    await other.adapter.findSession('t');
    await other.adapter.findSession('t');
    expect(always).toHaveBeenCalledTimes(2);
  });

  it('replaces a context the user lost with the fallback (or none) and emits one event', async () => {
    const events: unknown[] = [];
    const { adapter, updates } = adapterWith({ token: 't', contextId: A });
    const runtime = createContextRuntime(
      { membership: async (_u, c) => c === B, initial: () => B, revalidateSeconds: 0 },
      deps(events),
    );
    runtime.install({ internalAdapter: adapter });
    const found = await adapter.findSession('t');
    expect((found as unknown as { session: { contextId: unknown } }).session.contextId).toBe(B);
    expect(updates).toEqual([['t', { contextId: B }]]);
    expect(events).toEqual([
      { name: 'context.revoked', userId: U, detail: { reason: 'membership_lost', to: B } },
    ]);

    const none = adapterWith({ token: 't', contextId: A });
    const noFallback = createContextRuntime(
      { membership: () => false, revalidateSeconds: 0 },
      deps(),
    );
    noFallback.install({ internalAdapter: none.adapter });
    const result = await none.adapter.findSession('t');
    expect((result as unknown as { session: { contextId: unknown } }).session.contextId).toBeNull();
    expect(none.updates).toEqual([['t', { contextId: null }]]);
  });

  it('a throwing membership keeps the context and never throws into the read', async () => {
    const { adapter, updates } = adapterWith({ token: 't', contextId: A });
    const logged: string[] = [];
    const runtime = createContextRuntime(
      {
        membership: () => {
          throw new Error('SECRET');
        },
        revalidateSeconds: 0,
      },
      { ...deps(), logger: { warn: (m) => void logged.push(m), error: () => undefined } },
    );
    runtime.install({ internalAdapter: adapter });
    const found = await adapter.findSession('t');
    expect((found as unknown as { session: { contextId: unknown } }).session.contextId).toBe(A);
    expect(updates).toEqual([]);
    expect(logged.join()).not.toContain('SECRET');
  });

  it('leaves a session with no context, a null session and a non-UUID context alone', async () => {
    const membership = vi.fn(async () => false);
    const runtime = createContextRuntime({ membership, revalidateSeconds: 0 }, deps());
    for (const session of [
      { token: 't' },
      { token: 't', contextId: null },
      { token: 't', contextId: 'x' },
    ]) {
      const { adapter } = adapterWith(session);
      runtime.install({ internalAdapter: adapter });
      await adapter.findSession('t');
    }
    const gone = { findSession: vi.fn(async (_token: string) => null), updateSession: vi.fn() };
    runtime.install({ internalAdapter: gone });
    expect(await gone.findSession('t')).toBeNull();
    expect(membership).not.toHaveBeenCalled();
  });
});

describe('an expired session is not re-checked', () => {
  it('no membership call and no write for a session past its expiry', async () => {
    const membership = vi.fn(async () => false);
    const updates: unknown[] = [];
    const adapter = {
      findSession: vi.fn(async (_token: string) => ({
        session: { token: 't', contextId: A, expiresAt: new Date(Date.now() - 1000) },
        user: { id: U },
      })),
      updateSession: vi.fn(async (...args: unknown[]) => void updates.push(args)),
    };
    createContextRuntime({ membership, revalidateSeconds: 0 }, deps()).install({
      internalAdapter: adapter,
    });
    await adapter.findSession('t');
    expect(membership).not.toHaveBeenCalled();
    expect(updates).toEqual([]);
  });
});

describe('reconcile: a write the store missed', () => {
  const run = (degraded: { n: number }, deleteOutcome: 'ok' | 'fails') => {
    const logged: Array<[string, unknown]> = [];
    const runtime = createContextRuntime(
      { membership: () => true },
      {
        ...deps([], () => degraded.n),
        logger: { warn: (m, f) => void logged.push([m, f]), error: () => undefined },
      },
    );
    const storage = {
      delete: vi.fn(async (_key: string) => {
        if (deleteOutcome === 'fails') degraded.n += 1;
      }),
    };
    return { runtime, storage, logged };
  };

  it('does nothing when the store did not degrade during the write', async () => {
    const degraded = { n: 3 };
    const { runtime, storage } = run(degraded, 'ok');
    await runtime.reconcile(storage, 'tok', 3);
    expect(storage.delete).not.toHaveBeenCalled();
  });

  it('drops the cached copy when it did, and says nothing if that worked', async () => {
    const degraded = { n: 4 };
    const { runtime, storage, logged } = run(degraded, 'ok');
    await runtime.reconcile(storage, 'tok', 3);
    expect(storage.delete).toHaveBeenCalledWith('tok');
    expect(logged).toEqual([]);
  });

  it('logs identity.context_cache_stale when the drop fails too', async () => {
    const degraded = { n: 4 };
    const { runtime, storage, logged } = run(degraded, 'fails');
    await runtime.reconcile(storage, 'tok', 3);
    expect(logged).toHaveLength(1);
    expect(logged[0]![1]).toMatchObject({ code: 'identity.context_cache_stale' });
  });

  it('a store with no secondary storage has nothing to drop', async () => {
    const { runtime } = run({ n: 9 }, 'ok');
    await expect(runtime.reconcile(undefined, 'tok', 0)).resolves.toBeUndefined();
  });
});
