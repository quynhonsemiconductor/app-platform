import 'reflect-metadata';
import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import {
  requestContextStorage,
  setRequestPrincipal,
  type RequestContext,
} from '@quynhonsemiconductor/observability';
import { describe, expect, it, vi } from 'vitest';
import type { Identity } from '../create-identity';
import { markPreAuthenticated, SessionGuard, type PrincipalHook } from './session.guard';

const CTX = '0194a000-0000-7000-8000-000000000001';

const sessionWith = (contextId?: unknown) => ({
  user: { id: 'user-1', email: 'jane@users.example.test' },
  session: { id: 'session-1', token: 'tok', ...(contextId === undefined ? {} : { contextId }) },
});

function guardFor(options: { session?: unknown; hook?: PrincipalHook; isPublic?: boolean } = {}) {
  const getSession = vi.fn(async () => ('session' in options ? options.session : sessionWith()));
  const auth = { api: { getSession } } as unknown as Identity;
  const reflector = { getAllAndOverride: () => options.isPublic === true } as unknown as Reflector;
  const guard = new SessionGuard(auth, reflector, options.hook ?? null);
  const warn = vi.spyOn(
    (guard as unknown as { logger: { warn: (message: string) => void } }).logger,
    'warn',
  );
  const req: Record<string | symbol, unknown> = { headers: { cookie: 'a=b' } };
  const ctx = {
    getHandler: () => () => undefined,
    getClass: () => class {},
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
  return { guard, ctx, req, warn, getSession };
}
const seeded = (): RequestContext => ({
  workspaceId: undefined,
  userId: undefined,
  sessionId: undefined,
  correlationId: 'corr-1',
  traceparent: undefined,
});
const inRequest = <T>(fn: (store: RequestContext) => Promise<T>): Promise<T> => {
  const store = seeded();
  return requestContextStorage.run(store, () => fn(store));
};

describe('the principal carries the session’s active context as the workspace', () => {
  it('workspaceId is the session’s contextId', async () => {
    const { guard, ctx } = guardFor({ session: sessionWith(CTX) });
    await inRequest(async (store) => {
      await guard.canActivate(ctx);
      expect(store.workspaceId).toBe(CTX);
      expect(store.userId).toBe('user-1');
    });
  });

  it('no context, or a value that is not a string, leaves it unset', async () => {
    for (const value of [undefined, null, 7, {}]) {
      const { guard, ctx } = guardFor({ session: sessionWith(value) });
      await inRequest(async (store) => {
        await guard.canActivate(ctx);
        expect(store.workspaceId).toBeUndefined();
      });
    }
  });

  it('the product hook wins over the context, and still cannot overwrite the user or the session', async () => {
    const hook: PrincipalHook = () => ({ workspaceId: 'ws-from-hook' });
    const { guard, ctx } = guardFor({ session: sessionWith(CTX), hook });
    await inRequest(async (store) => {
      await guard.canActivate(ctx);
      expect(store.workspaceId).toBe('ws-from-hook');
      expect(store.sessionId).toBe('session-1');
    });
  });
});

describe('markPreAuthenticated: a product guard that authenticated a non-browser credential', () => {
  it('SessionGuard stands aside: no session lookup, no session on the request, and the principal is the product’s', async () => {
    const { guard, ctx, req, getSession, warn } = guardFor({ session: null });
    await inRequest(async (store) => {
      setRequestPrincipal({ userId: 'token-user', sessionId: 'apitoken:7' });
      markPreAuthenticated(req);
      expect(await guard.canActivate(ctx)).toBe(true);
      expect(getSession).not.toHaveBeenCalled();
      expect(req['session']).toBeUndefined();
      expect(store.userId).toBe('token-user'); // untouched
      expect(warn).not.toHaveBeenCalled();
    });
  });

  it('an unmarked request is still authenticated by a session, or answered 401', async () => {
    const { guard, ctx, getSession } = guardFor({ session: null });
    await inRequest(async () => {
      await expect(guard.canActivate(ctx)).rejects.toMatchObject({ code: 'AUTH_UNAUTHENTICATED' });
      expect(getSession).toHaveBeenCalledTimes(1);
    });
  });

  it('only the registered symbol counts: a string key or another symbol does not', async () => {
    for (const mark of [
      'pre-authenticated',
      Symbol('@quynhonsemiconductor/identity:pre-authenticated'),
    ]) {
      const { guard, ctx, req } = guardFor({ session: null });
      req[mark as string] = true;
      await inRequest(async () => {
        await expect(guard.canActivate(ctx)).rejects.toMatchObject({
          code: 'AUTH_UNAUTHENTICATED',
        });
      });
    }
  });

  it('marking without a principal in the request context warns once, and does not fail the request', async () => {
    const { guard, ctx, req, warn } = guardFor();
    markPreAuthenticated(req);
    await inRequest(async () => {
      expect(await guard.canActivate(ctx)).toBe(true);
      expect(await guard.canActivate(ctx)).toBe(true);
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain('markPreAuthenticated');
  });

  it('@Public() still short-circuits first', async () => {
    const { guard, ctx, getSession } = guardFor({ isPublic: true });
    expect(await guard.canActivate(ctx)).toBe(true);
    expect(getSession).not.toHaveBeenCalled();
  });
});
