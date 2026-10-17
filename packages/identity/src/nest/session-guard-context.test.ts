import 'reflect-metadata';
import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import {
  requestContextStorage,
  setRequestPrincipal,
  type RequestContext,
} from '@quynhonsemiconductor/observability';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Identity } from '../create-identity';
import { markPreAuthenticated, SessionGuard, type PrincipalHook } from './session.guard';

// The ban check needs a real instance (it reads the ban guard's memo); here it is a stub the tests steer.
const banned = vi.hoisted(() => ({
  isUserBanned: vi.fn(async (_auth: unknown, _userId: string) => false),
}));
vi.mock('../create-identity', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isUserBanned: banned.isUserBanned,
}));

const CTX = '0194a000-0000-7000-8000-000000000001';
const USER = '0194a000-0000-7000-8000-0000000000aa';

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

describe('the principal hook cannot erase the session’s context', () => {
  it('a hook that returns workspaceId: undefined (or any undefined key) leaves the context as the workspace', async () => {
    const hook: PrincipalHook = () => ({ workspaceId: undefined, fields: undefined });
    const { guard, ctx } = guardFor({ session: sessionWith(CTX), hook });
    await inRequest(async (store) => {
      await guard.canActivate(ctx);
      expect(store.workspaceId).toBe(CTX);
    });
  });
});

describe('markPreAuthenticated: a product guard that authenticated a non-browser credential', () => {
  beforeEach(() => {
    banned.isUserBanned.mockReset();
    banned.isUserBanned.mockResolvedValue(false);
  });

  it('SessionGuard stands aside: no session lookup, no session on the request, and the principal is the product’s', async () => {
    const { guard, ctx, req, getSession, warn } = guardFor({ session: null });
    await inRequest(async (store) => {
      setRequestPrincipal({ userId: USER, sessionId: 'apitoken:7' });
      markPreAuthenticated(req);
      expect(await guard.canActivate(ctx)).toBe(true);
      expect(getSession).not.toHaveBeenCalled();
      expect(req['session']).toBeUndefined();
      expect(store.userId).toBe(USER); // untouched
      expect(warn).not.toHaveBeenCalled();
      expect(banned.isUserBanned).toHaveBeenCalledWith(expect.anything(), USER);
    });
  });

  it('a BANNED user’s token is refused (401): the session path’s ban check never ran for it', async () => {
    banned.isUserBanned.mockResolvedValue(true);
    const { guard, ctx, req } = guardFor({ session: null });
    await inRequest(async () => {
      setRequestPrincipal({ userId: USER, sessionId: 'apitoken:7' });
      markPreAuthenticated(req);
      await expect(guard.canActivate(ctx)).rejects.toMatchObject({ code: 'AUTH_UNAUTHENTICATED' });
    });
  });

  it('FAILS CLOSED when a request context exists but the product guard wrote no principal: 401, logged at error', async () => {
    const { guard, ctx, req } = guardFor({ session: null });
    const error = vi.spyOn(
      (guard as unknown as { logger: { error: (message: string) => void } }).logger,
      'error',
    );
    await inRequest(async () => {
      markPreAuthenticated(req);
      await expect(guard.canActivate(ctx)).rejects.toMatchObject({ code: 'AUTH_UNAUTHENTICATED' });
    });
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0]![0])).toContain('setRequestPrincipal');
    expect(banned.isUserBanned).not.toHaveBeenCalled();
  });

  it('with NO request context the passed userId is what the ban check runs on: warned once, let through', async () => {
    const { guard, ctx, req, warn } = guardFor();
    markPreAuthenticated(req, { userId: USER });
    expect(requestContextStorage.getStore()).toBeUndefined();
    expect(await guard.canActivate(ctx)).toBe(true);
    expect(await guard.canActivate(ctx)).toBe(true);
    expect(banned.isUserBanned).toHaveBeenCalledWith(expect.anything(), USER);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain('markPreAuthenticated');
  });

  it('with NO request context a banned userId is refused too: the ban check always runs', async () => {
    banned.isUserBanned.mockResolvedValue(true);
    const { guard, ctx, req } = guardFor();
    markPreAuthenticated(req, { userId: USER });
    await expect(guard.canActivate(ctx)).rejects.toMatchObject({ code: 'AUTH_UNAUTHENTICATED' });
  });

  it('with NO request context and NO userId the request cannot be named: refused, and the ban check is not skipped silently', async () => {
    const { guard, ctx, req } = guardFor();
    markPreAuthenticated(req);
    await expect(guard.canActivate(ctx)).rejects.toMatchObject({ code: 'AUTH_UNAUTHENTICATED' });
    expect(banned.isUserBanned).not.toHaveBeenCalled();
  });

  it('a user id that is not a UUID is a 401, not a TypeError (500), from the principal and from the argument', async () => {
    for (const bad of ['not-a-uuid', '', 'token-user']) {
      const viaArgument = guardFor();
      markPreAuthenticated(viaArgument.req, { userId: bad });
      await expect(viaArgument.guard.canActivate(viaArgument.ctx)).rejects.toMatchObject({
        code: 'AUTH_UNAUTHENTICATED',
      });

      const viaPrincipal = guardFor({ session: null });
      await inRequest(async () => {
        setRequestPrincipal({ userId: bad || 'x', sessionId: 'apitoken:7' });
        markPreAuthenticated(viaPrincipal.req);
        await expect(viaPrincipal.guard.canActivate(viaPrincipal.ctx)).rejects.toMatchObject({
          code: 'AUTH_UNAUTHENTICATED',
        });
      });
    }
    expect(banned.isUserBanned).not.toHaveBeenCalled();
  });

  it('a userId that disagrees with the principal the guard wrote is refused', async () => {
    const { guard, ctx, req } = guardFor({ session: null });
    await inRequest(async () => {
      setRequestPrincipal({ userId: USER, sessionId: 'apitoken:7' });
      markPreAuthenticated(req, { userId: '0194a000-0000-7000-8000-0000000000ff' });
      await expect(guard.canActivate(ctx)).rejects.toMatchObject({ code: 'AUTH_UNAUTHENTICATED' });
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

  it('@Public() still short-circuits first', async () => {
    const { guard, ctx, getSession } = guardFor({ isPublic: true });
    expect(await guard.canActivate(ctx)).toBe(true);
    expect(getSession).not.toHaveBeenCalled();
    expect(banned.isUserBanned).not.toHaveBeenCalled();
  });
});
