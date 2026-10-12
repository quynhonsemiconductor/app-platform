import 'reflect-metadata';
import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { requestContextStorage, type RequestContext } from '@quynhonsemiconductor/observability';
import { describe, expect, it, vi } from 'vitest';
import type { Identity } from '../create-identity';
import { SessionGuard, type PrincipalHook } from './session.guard';

const TOKEN = 'the-session-token-must-never-be-in-the-context';
const session = {
  user: { id: 'user-1', email: 'jane@users.example.test' },
  session: { id: 'session-1', token: TOKEN },
};

function guardFor(options: { session?: unknown; hook?: PrincipalHook; isPublic?: boolean } = {}) {
  const auth = {
    api: { getSession: vi.fn(async () => ('session' in options ? options.session : session)) },
  } as unknown as Identity;
  const reflector = { getAllAndOverride: () => options.isPublic === true } as unknown as Reflector;
  const guard = new SessionGuard(auth, reflector, options.hook ?? null);
  const warn = vi.spyOn(
    (guard as unknown as { logger: { warn: (message: string) => void } }).logger,
    'warn',
  );
  const req: Record<string, unknown> = { headers: { cookie: 'a=b' } };
  const ctx = {
    getHandler: () => () => undefined,
    getClass: () => class {},
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
  return { guard, ctx, req, warn };
}
const seeded = (): RequestContext => ({
  workspaceId: undefined,
  userId: undefined,
  sessionId: undefined,
  correlationId: 'corr-1',
  traceparent: undefined,
});
const inRequest = async <T>(fn: (store: RequestContext) => Promise<T>): Promise<T> => {
  const store = seeded();
  return requestContextStorage.run(store, () => fn(store));
};

describe('SessionGuard writes the principal into the request context', () => {
  it('userId and sessionId (the id, never the token), once the session is resolved', async () => {
    const { guard, ctx } = guardFor();
    await inRequest(async (store) => {
      expect(await guard.canActivate(ctx)).toBe(true);
      expect(store.userId).toBe('user-1');
      expect(store.sessionId).toBe('session-1');
      expect(JSON.stringify(store)).not.toContain(TOKEN);
    });
  });

  it('writes nothing for a @Public() route, and nothing when there is no session (401)', async () => {
    await inRequest(async (store) => {
      expect(await guardFor({ isPublic: true }).guard.canActivate(guardFor().ctx)).toBe(true);
      expect(store.userId).toBeUndefined();
      const { guard, ctx } = guardFor({ session: null });
      await expect(guard.canActivate(ctx)).rejects.toMatchObject({ code: 'AUTH_UNAUTHENTICATED' });
      expect(store.userId).toBeUndefined();
      expect(store.sessionId).toBeUndefined();
    });
  });

  it('still authenticates when nothing seeded a request context (no enableCorrelationId): it just records nothing', async () => {
    const { guard, ctx, req } = guardFor();
    expect(requestContextStorage.getStore()).toBeUndefined();
    expect(await guard.canActivate(ctx)).toBe(true);
    expect(req['session']).toBe(session);
    expect(requestContextStorage.getStore()).toBeUndefined(); // it did not create one
  });

  it('is per request: two concurrent requests do not see each other’s user', async () => {
    const seen: string[] = [];
    await Promise.all(
      ['a', 'b'].map((id) =>
        inRequest(async () => {
          const s = { user: { id: `user-${id}` }, session: { id: `session-${id}` } };
          const { guard, ctx } = guardFor({ session: s });
          await new Promise((r) => setTimeout(r, id === 'a' ? 5 : 1));
          await guard.canActivate(ctx);
          await new Promise((r) => setTimeout(r, 5));
          seen.push(requestContextStorage.getStore()!.userId!);
        }),
      ),
    );
    expect(seen.sort()).toEqual(['user-a', 'user-b']);
  });

  describe('the product hook (replaces a session-principal bridge)', () => {
    it('adds the workspace and fields to the principal; it receives the resolved session', async () => {
      const hook = vi.fn(async () => ({ workspaceId: 'ws-9', fields: { role: 'admin', plan: 3 } }));
      const { guard, ctx } = guardFor({ hook });
      await inRequest(async (store) => {
        await guard.canActivate(ctx);
        expect(hook).toHaveBeenCalledWith(session);
        expect(store.workspaceId).toBe('ws-9');
        expect(store.principalFields).toEqual({ role: 'admin', plan: 3 });
        expect(store.userId).toBe('user-1');
      });
    });

    it('is not called for a public route or without a session', async () => {
      const hook = vi.fn(() => ({ workspaceId: 'x' }));
      await inRequest(async () => {
        await guardFor({ hook, isPublic: true }).guard.canActivate(guardFor().ctx);
        const { guard, ctx } = guardFor({ hook, session: null });
        await guard.canActivate(ctx).catch(() => undefined);
      });
      expect(hook).not.toHaveBeenCalled();
    });

    it('may return nothing', async () => {
      const { guard, ctx } = guardFor({ hook: () => undefined });
      await inRequest(async (store) => {
        await guard.canActivate(ctx);
        expect(store.userId).toBe('user-1');
        expect(store.principalFields).toBeUndefined();
      });
    });

    it('a throwing hook does not fail the request: ids only, one warning with the class and not the message', async () => {
      const hook: PrincipalHook = () => {
        throw new RangeError('secret detail from the product');
      };
      const { guard, ctx, warn } = guardFor({ hook });
      await inRequest(async (store) => {
        expect(await guard.canActivate(ctx)).toBe(true);
        expect(store.userId).toBe('user-1');
        expect(store.workspaceId).toBeUndefined();
      });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0])).toContain('RangeError');
      expect(String(warn.mock.calls[0]![0])).not.toContain('secret detail');
    });

    it('an invalid return (a reserved field, a bad value) is the same: ids only, nothing half-written', async () => {
      for (const bad of [
        { fields: { userId: 'someone-else' } },
        { fields: { role: { nested: true } as never } },
        { workspaceId: 'w\r\nx' },
      ]) {
        const { guard, ctx, warn } = guardFor({ hook: (() => bad) as unknown as PrincipalHook });
        await inRequest(async (store) => {
          expect(await guard.canActivate(ctx)).toBe(true);
          expect(store.userId).toBe('user-1');
          expect(store.sessionId).toBe('session-1');
          expect(store.workspaceId).toBeUndefined();
          expect(store.principalFields).toBeUndefined();
        });
        expect(warn).toHaveBeenCalledTimes(1);
      }
    });
  });
});
