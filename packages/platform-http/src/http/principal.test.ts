import 'reflect-metadata';
import type { ArgumentsHost } from '@nestjs/common';
import { setRequestPrincipal } from '@quynhonsemiconductor/observability';
import { describe, expect, it, vi } from 'vitest';
import { UnauthorizedException } from '../errors';
import { GlobalExceptionFilter } from './global-exception.filter';
import {
  KEYED_BY_ADDRESS,
  currentUserId,
  resetPrincipalWarningsForTesting,
  warnOnceIfAuthenticatedWithoutPrincipal,
} from './principal';
import { requestContextStorage, type RequestContext } from './request-context.service';

const seeded = (): RequestContext => ({
  workspaceId: undefined,
  userId: undefined,
  sessionId: undefined,
  correlationId: 'corr-7',
  traceparent: undefined,
});

describe('currentUserId', () => {
  it('is the principal in the request context, and undefined before authentication or outside a request', () => {
    expect(currentUserId()).toBeUndefined();
    requestContextStorage.run(seeded(), () => {
      expect(currentUserId()).toBeUndefined();
      setRequestPrincipal({ userId: 'u-1', sessionId: 's-1' });
      expect(currentUserId()).toBe('u-1');
    });
  });
});

describe('GlobalExceptionFilter with nothing bound to REQUEST_CONTEXT (no bridge)', () => {
  function run(exception: unknown, setup: () => void) {
    const filter = new GlobalExceptionFilter();
    const warn = vi.spyOn((filter as unknown as { logger: { warn: () => void } }).logger, 'warn');
    const sent: unknown[] = [];
    const reply = { status: () => ({ send: (body: unknown) => sent.push(body) }) };
    const host = {
      switchToHttp: () => ({
        getResponse: () => reply,
        getRequest: () => ({ user: { sub: 'from-req-user' } }),
      }),
    } as unknown as ArgumentsHost;
    requestContextStorage.run(seeded(), () => {
      setup();
      filter.catch(exception, host);
    });
    return { sent, warn };
  }

  it('puts the context’s correlation id in the envelope and the principal in the security log', () => {
    const { sent, warn } = run(
      new UnauthorizedException('AUTH_UNAUTHENTICATED', 'Sign in required'),
      () => setRequestPrincipal({ userId: 'u-1', sessionId: 's-1' }),
    );
    expect(sent[0]).toMatchObject({
      error: { code: 'AUTH_UNAUTHENTICATED', correlationId: 'corr-7' },
    });
    expect(warn.mock.calls[0]![0]).toMatchObject({ correlationId: 'corr-7', userId: 'u-1' });
  });

  it('never reads req.user', () => {
    const { warn } = run(new UnauthorizedException('AUTH_UNAUTHENTICATED', 'x'), () => undefined);
    expect((warn.mock.calls[0]![0] as { userId?: string }).userId).toBeUndefined();
    expect(JSON.stringify(warn.mock.calls)).not.toContain('from-req-user');
  });

  it('outside a request context the correlation id is "unknown", as before', () => {
    const filter = new GlobalExceptionFilter();
    const sent: unknown[] = [];
    const reply = { status: () => ({ send: (body: unknown) => sent.push(body) }) };
    filter.catch(new UnauthorizedException('AUTH_UNAUTHENTICATED', 'x'), {
      switchToHttp: () => ({ getResponse: () => reply }),
    } as unknown as ArgumentsHost);
    expect(sent[0]).toMatchObject({ error: { correlationId: 'unknown' } });
  });

  it('a bound accessor still wins (a product that reads from somewhere else)', () => {
    const filter = new GlobalExceptionFilter({
      getCorrelationId: () => 'bound',
      getUserId: () => 'bound-user',
    });
    const warn = vi.spyOn((filter as unknown as { logger: { warn: () => void } }).logger, 'warn');
    const sent: unknown[] = [];
    filter.catch(new UnauthorizedException('AUTH_UNAUTHENTICATED', 'x'), {
      switchToHttp: () => ({
        getResponse: () => ({ status: () => ({ send: (b: unknown) => sent.push(b) }) }),
      }),
    } as unknown as ArgumentsHost);
    expect(sent[0]).toMatchObject({ error: { correlationId: 'bound' } });
    expect(warn.mock.calls[0]![0]).toMatchObject({ userId: 'bound-user' });
  });
});

describe('warnOnceIfAuthenticatedWithoutPrincipal (the 5.0 migration trap)', () => {
  const run = (req: object, userId?: string) => {
    const warn = vi.fn();
    resetPrincipalWarningsForTesting();
    requestContextStorage.run(seeded(), () => {
      if (userId) setRequestPrincipal({ userId, sessionId: 's' });
      warnOnceIfAuthenticatedWithoutPrincipal(req, warn);
      warnOnceIfAuthenticatedWithoutPrincipal(req, warn);
    });
    return warn;
  };

  it('a request with req.user or req.session but no principal warns, once, saying what to call', () => {
    for (const req of [{ user: { sub: 'u1' } }, { session: { user: { id: 'u1' } } }]) {
      const warn = run(req);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0])).toMatch(/setRequestPrincipal/);
      expect(String(warn.mock.calls[0]![0])).toMatch(/BEFORE RateLimitGuard/);
    }
  });

  it('says nothing when there is a principal, or nothing looks authenticated', () => {
    expect(run({ user: { sub: 'u1' } }, 'u1')).not.toHaveBeenCalled();
    expect(run({})).not.toHaveBeenCalled();
  });

  it('the rate limit marks a request it keyed by address, for a later guard to notice', () => {
    expect(typeof KEYED_BY_ADDRESS).toBe('symbol');
    expect(KEYED_BY_ADDRESS).toBe(
      Symbol.for('@quynhonsemiconductor/platform-http:keyed-by-address'),
    );
  });
});
