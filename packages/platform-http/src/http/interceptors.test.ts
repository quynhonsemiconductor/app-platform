import 'reflect-metadata';
import type { CacheService } from '@quynhonsemiconductor/platform-cache';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { lastValueFrom, of, throwError } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import {
  RequestContextService,
  requestContextStorage,
  type RequestContext,
} from './request-context.service';
import { HttpLoggingInterceptor } from './http-logging.interceptor';
import { resetPrincipalWarningsForTesting } from './principal';
import { IdempotencyInterceptor } from './idempotency.interceptor';
import { PROBE_PATHS, setRequestPrincipal } from '@quynhonsemiconductor/observability';

function makeHttpContext(req: Record<string, unknown>, statusCode = 200): ExecutionContext {
  return {
    getType: () => 'http',
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => ({ statusCode }),
    }),
  } as unknown as ExecutionContext;
}

const emptyContext = (): RequestContext => ({
  workspaceId: undefined,
  userId: undefined,
  sessionId: undefined,
  correlationId: 'corr-test',
  traceparent: undefined,
});
/** Run `fn` as a request that the authentication layer has identified (`setRequestPrincipal`). */
const asUser = <T>(userId: string | undefined, fn: () => T): T =>
  requestContextStorage.run(emptyContext(), () => {
    if (userId) setRequestPrincipal({ userId, sessionId: `s-${userId}` });
    return fn();
  });

function makeHandler<T>(value: T, spy?: () => void): CallHandler {
  return {
    handle: () => {
      spy?.();
      return of(value);
    },
  } as CallHandler;
}

describe('RequestContextService', () => {
  const svc = new RequestContextService();
  const base: RequestContext = {
    workspaceId: undefined,
    userId: undefined,
    sessionId: undefined,
    correlationId: 'corr-1',
    traceparent: undefined,
  };

  it('runs a function within a context and exposes getters', () => {
    const result = svc.run({ ...base }, () => {
      expect(svc.getCorrelationId()).toBe('corr-1');
      expect(svc.get()).toBeDefined();
      expect(requestContextStorage.getStore()?.correlationId).toBe('corr-1');
      return 42;
    });
    expect(result).toBe(42);
    // Outside the run scope there is no context.
    expect(svc.get()).toBeUndefined();
  });

  it('getOrThrow throws outside a context', () => {
    expect(() => svc.getOrThrow()).toThrow('No request context');
  });

  it('setAuthContext mutates the active context', () => {
    svc.run({ ...base }, () => {
      svc.setAuthContext('ws-9', 'user-9', 'sess-9');
      expect(svc.getWorkspaceId()).toBe('ws-9');
      expect(svc.getUserId()).toBe('user-9');
      expect(svc.get()?.sessionId).toBe('sess-9');
    });
  });
});

describe('HttpLoggingInterceptor', () => {
  it('passes through non-http contexts', async () => {
    const interceptor = new HttpLoggingInterceptor();
    const ctx = { getType: () => 'rpc' } as unknown as ExecutionContext;
    let called = false;
    const out = await lastValueFrom(
      interceptor.intercept(
        ctx,
        makeHandler('ok', () => (called = true)),
      ),
    );
    expect(called).toBe(true);
    expect(out).toBe('ok');
  });

  it('skips access logs for configured paths', async () => {
    const interceptor = new HttpLoggingInterceptor({ skipPaths: ['/health'] });
    const ctx = makeHttpContext({ method: 'GET', url: '/health', headers: {} });
    const out = await lastValueFrom(interceptor.intercept(ctx, makeHandler('ok')));
    expect(out).toBe('ok');
  });

  // Every probe path the tracing hook ignores must also be absent from access logs —
  // both derive from observability's PROBE_PATHS. `/livez` is the kubelet's liveness path.
  it.each([...PROBE_PATHS, '/favicon.ico', '/livez?verbose=1'])(
    'does not log the probe path %s by default',
    async (url) => {
      const interceptor = new HttpLoggingInterceptor();
      const logSpy = vi.spyOn(
        (interceptor as unknown as { logger: { log: () => void } }).logger,
        'log',
      );
      const ctx = makeHttpContext({ method: 'GET', url, headers: {} }, 200);
      await lastValueFrom(interceptor.intercept(ctx, makeHandler('ok')));
      expect(logSpy).not.toHaveBeenCalled();
    },
  );

  it('still logs a route that merely starts with a probe path', async () => {
    const interceptor = new HttpLoggingInterceptor();
    const logSpy = vi.spyOn(
      (interceptor as unknown as { logger: { log: () => void } }).logger,
      'log',
    );
    const ctx = makeHttpContext({ method: 'GET', url: '/livez/deep', headers: {} }, 200);
    await lastValueFrom(interceptor.intercept(ctx, makeHandler('ok')));
    expect(logSpy).toHaveBeenCalledTimes(1);
  });

  describe('the correlation id it logs', () => {
    const ctxOf = (correlationId: string): RequestContext => ({
      workspaceId: undefined,
      userId: undefined,
      sessionId: undefined,
      correlationId,
      traceparent: undefined,
    });

    async function logged(headers: Record<string, string>, store?: RequestContext) {
      const interceptor = new HttpLoggingInterceptor();
      const logSpy = vi.spyOn(
        (interceptor as unknown as { logger: { log: (o: unknown) => void } }).logger,
        'log',
      );
      const ctx = makeHttpContext({ method: 'GET', url: '/v1/things', headers }, 200);
      const run = () => lastValueFrom(interceptor.intercept(ctx, makeHandler('ok')));
      await (store ? requestContextStorage.run(store, run) : run());
      return logSpy.mock.calls[0][0] as Record<string, unknown>;
    }

    it('comes from the request context, not from the raw header', async () => {
      const line = await logged(
        { 'x-correlation-id': 'raw-caller-value' },
        ctxOf('validated-id-1'),
      );
      expect(line['correlationId']).toBe('validated-id-1');
    });

    it('never logs an unvalidated header when there is no context (CORRELATION_ID_MODE=disabled)', async () => {
      const forged = 'abc","level":60,"msg":"forged';
      const line = await logged({ 'x-correlation-id': forged });
      expect(line).not.toHaveProperty('correlationId');
      expect(JSON.stringify(line)).not.toContain('forged');
    });

    it("leaves the key out rather than setting it to undefined, so the logger's own value survives", async () => {
      // pino merges the log object OVER the mixin: an explicit `correlationId: undefined` would erase
      // the id the mixin adds from the context.
      const line = await logged({});
      expect(Object.keys(line)).not.toContain('correlationId');
    });
  });

  it('logs the client address from cf-connecting-ip, ignoring a forged x-forwarded-for', async () => {
    const interceptor = new HttpLoggingInterceptor();
    const logSpy = vi.spyOn(
      (interceptor as unknown as { logger: { log: (o: unknown) => void } }).logger,
      'log',
    );
    const ctx = makeHttpContext(
      {
        method: 'GET',
        url: '/v1/things',
        ip: '10.42.0.9',
        headers: { 'cf-connecting-ip': '203.0.113.7', 'x-forwarded-for': '1.1.1.1' },
      },
      200,
    );
    await lastValueFrom(interceptor.intercept(ctx, makeHandler('ok')));
    expect(logSpy.mock.calls[0][0]).toMatchObject({ ip: '203.0.113.7' });
  });

  it('logs one line on success', async () => {
    const interceptor = new HttpLoggingInterceptor();
    const logSpy = vi.spyOn(
      (interceptor as unknown as { logger: { log: () => void } }).logger,
      'log',
    );
    const ctx = makeHttpContext(
      { method: 'GET', url: '/v1/things', headers: { 'x-correlation-id': 'c1' } },
      200,
    );
    await lastValueFrom(interceptor.intercept(ctx, makeHandler('ok')));
    expect(logSpy).toHaveBeenCalledTimes(1);
  });
});

/** A cache whose `get` misses and whose `set` records. */
function fakeValkey(): { svc: CacheService; evalSpy: ReturnType<typeof vi.fn> } {
  // The first eval is "read or claim": answer that the key was claimed.
  const evalSpy = vi.fn().mockResolvedValue(['claimed']);
  const set = vi.fn().mockResolvedValue('OK');
  return { svc: { instance: { set, eval: evalSpy } } as unknown as CacheService, evalSpy };
}

describe('who the user is: the request context, and only the request context', () => {
  const keyOf = async (req: Record<string, unknown>, userId: string | undefined) => {
    const { svc, evalSpy } = fakeValkey();
    const interceptor = new IdempotencyInterceptor(svc);
    const ctx = makeHttpContext({
      method: 'POST',
      url: '/v1/x',
      headers: { 'idempotency-key': 'k' },
      ...req,
    });
    await asUser(userId, () => lastValueFrom(interceptor.intercept(ctx, makeHandler('x'))));
    return evalSpy.mock.calls[0]?.[2] as string; // eval(script, 2, recordKey, claimKey, ...)
  };

  it('idempotency: an authenticated caller is keyed by the principal, whatever req.user says', async () => {
    expect(await keyOf({}, 'u1')).toMatch(/^idem:u1:[0-9a-f]{32}$/);
    expect(await keyOf({ user: { sub: 'someone-else', id: 'someone-else' } }, 'u1')).toMatch(
      /^idem:u1:[0-9a-f]{32}$/,
    );
  });

  it('idempotency: req.user alone does not authenticate a caller: it is keyed like an anonymous one', async () => {
    const withUser = await keyOf(
      {
        user: { sub: 'u9' },
        ip: '1.2.3.4',
        headers: { 'idempotency-key': 'k', 'user-agent': 'ua' },
      },
      undefined,
    );
    expect(withUser).not.toContain('u9');
    expect(withUser).toMatch(/^idem:[0-9a-f]{16}:[0-9a-f]{32}$/);
  });

  describe('the access log', () => {
    const userIdLogged = async (
      req: Record<string, unknown>,
      userId: string | undefined,
      fail = false,
    ) => {
      const interceptor = new HttpLoggingInterceptor();
      const spies = ['log', 'warn', 'error'].map((level) =>
        vi.spyOn(
          (interceptor as unknown as { logger: Record<string, (o: unknown) => void> }).logger,
          level,
        ),
      );
      const ctx = makeHttpContext(
        { method: 'GET', url: '/v1/things', headers: {}, ...req },
        fail ? 500 : 200,
      );
      const handler: CallHandler = fail
        ? ({ handle: () => throwError(() => new Error('boom')) } as CallHandler)
        : makeHandler('ok');
      await asUser(userId, () =>
        lastValueFrom(interceptor.intercept(ctx, handler)).catch(() => undefined),
      );
      const call = spies.flatMap((spy) => spy.mock.calls)[0]?.[0] as Record<string, unknown>;
      return call;
    };

    it('logs the principal, on success and on error', async () => {
      expect((await userIdLogged({}, 'u1'))['userId']).toBe('u1');
      expect((await userIdLogged({}, 'u1', true))['userId']).toBe('u1');
    });

    it('does not read req.user.id', async () => {
      expect(
        (await userIdLogged({ user: { id: 'u9', sub: 'u9' } }, undefined))['userId'],
      ).toBeUndefined();
      expect((await userIdLogged({ user: { id: 'u9' } }, 'u1'))['userId']).toBe('u1');
    });

    it('warns ONCE when a request has req.user but no principal (a guard that never called setRequestPrincipal)', async () => {
      resetPrincipalWarningsForTesting();
      const interceptor = new HttpLoggingInterceptor();
      const logger = (interceptor as unknown as { logger: Record<string, (o: unknown) => void> })
        .logger;
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
      vi.spyOn(logger, 'log').mockImplementation(() => undefined);
      for (let i = 0; i < 3; i += 1) {
        await asUser(undefined, () =>
          lastValueFrom(
            interceptor.intercept(
              makeHttpContext({
                method: 'GET',
                url: '/v1/things',
                headers: {},
                user: { sub: 'u9' },
              }),
              makeHandler('ok'),
            ),
          ),
        );
      }
      const messages = warn.mock.calls
        .map((c) => String(c[0]))
        .filter((m) => /setRequestPrincipal/.test(m));
      expect(messages).toHaveLength(1);
    });

    it('a principal set while the handler runs (a guard that ran late) is the one logged', async () => {
      const interceptor = new HttpLoggingInterceptor();
      const spy = vi.spyOn(
        (interceptor as unknown as { logger: { log: (o: unknown) => void } }).logger,
        'log',
      );
      const ctx = makeHttpContext({ method: 'GET', url: '/v1/things', headers: {} });
      const handler = {
        handle: () => {
          setRequestPrincipal({ userId: 'late', sessionId: 's' });
          return of('ok');
        },
      } as CallHandler;
      await requestContextStorage.run(emptyContext(), () =>
        lastValueFrom(interceptor.intercept(ctx, handler)),
      );
      expect((spy.mock.calls[0]![0] as Record<string, unknown>)['userId']).toBe('late');
    });
  });
});
