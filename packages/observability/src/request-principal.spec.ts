import { describe, expect, it } from 'vitest';
import { createLoggerOptions } from './logger.factory';
import {
  MAX_PRINCIPAL_FIELDS,
  getRequestPrincipal,
  requestContextStorage,
  setRequestPrincipal,
  type RequestContext,
} from './request-context';

const seeded = (): RequestContext => ({
  workspaceId: undefined,
  userId: undefined,
  sessionId: undefined,
  correlationId: 'corr-1',
  traceparent: undefined,
});
const inRequest = <T>(fn: (ctx: RequestContext) => T): T => {
  const ctx = seeded();
  return requestContextStorage.run(ctx, () => fn(ctx));
};
const mixin = () =>
  (
    createLoggerOptions({
      serviceName: 'svc',
      nodeEnv: 'test',
      serviceVersion: '1',
      level: 'info',
    }).pinoHttp as { mixin: () => Record<string, unknown> }
  ).mixin;

describe('setRequestPrincipal', () => {
  it('writes the user and the session into the request context, and getRequestPrincipal reads them back', () => {
    inRequest((ctx) => {
      expect(getRequestPrincipal()).toBeUndefined();
      expect(setRequestPrincipal({ userId: 'u-1', sessionId: 's-1' })).toBe(true);
      expect(ctx.userId).toBe('u-1');
      expect(ctx.sessionId).toBe('s-1');
      expect(getRequestPrincipal()).toEqual({ userId: 'u-1', sessionId: 's-1' });
    });
  });

  it('sets the workspace only when given, and leaves a seeded one alone otherwise', () => {
    inRequest((ctx) => {
      ctx.workspaceId = 'ws-seeded';
      setRequestPrincipal({ userId: 'u-1', sessionId: 's-1' });
      expect(ctx.workspaceId).toBe('ws-seeded');
      setRequestPrincipal({ userId: 'u-1', sessionId: 's-1', workspaceId: 'ws-2' });
      expect(ctx.workspaceId).toBe('ws-2');
    });
  });

  it('with no request context it does nothing and says so (false); it never creates one', () => {
    expect(requestContextStorage.getStore()).toBeUndefined();
    expect(setRequestPrincipal({ userId: 'u-1', sessionId: 's-1' })).toBe(false);
    expect(requestContextStorage.getStore()).toBeUndefined();
    expect(getRequestPrincipal()).toBeUndefined();
  });

  it('is per request: a principal set in one is not seen in another running at the same time', async () => {
    const seen: Array<string | undefined> = [];
    await Promise.all(
      ['a', 'b'].map((id) =>
        requestContextStorage.run(seeded(), async () => {
          await new Promise((r) => setTimeout(r, id === 'a' ? 5 : 1));
          setRequestPrincipal({ userId: `user-${id}`, sessionId: `s-${id}` });
          await new Promise((r) => setTimeout(r, 5));
          seen.push(getRequestPrincipal()?.userId);
        }),
      ),
    );
    expect(seen.sort()).toEqual(['user-a', 'user-b']);
  });

  describe('invalid input is a TypeError, not a half-written context', () => {
    it.each([
      ['an empty userId', { userId: '', sessionId: 's' }],
      ['a non-string userId', { userId: 7 as never, sessionId: 's' }],
      ['an over-long userId', { userId: 'u'.repeat(129), sessionId: 's' }],
      ['a userId with a control character', { userId: 'u\nx', sessionId: 's' }],
      ['an empty sessionId', { userId: 'u', sessionId: '' }],
      ['a bad workspaceId', { userId: 'u', sessionId: 's', workspaceId: 'w\r\n' }],
    ])('%s', (_name, principal) => {
      inRequest((ctx) => {
        expect(() => setRequestPrincipal(principal)).toThrow(TypeError);
        expect(ctx.userId).toBeUndefined();
        expect(ctx.sessionId).toBeUndefined();
      });
    });
  });

  describe('fields (the product’s own principal fields, on every log line of the request)', () => {
    it('are validated and then appear in the logger mixin next to userId and workspaceId', () => {
      inRequest(() => {
        setRequestPrincipal({
          userId: 'u-1',
          sessionId: 's-1',
          workspaceId: 'ws-1',
          fields: { role: 'admin', tier: 3, beta: true },
        });
        expect(mixin()()).toEqual({
          workspaceId: 'ws-1',
          userId: 'u-1',
          correlationId: 'corr-1',
          role: 'admin',
          tier: 3,
          beta: true,
        });
      });
    });

    it('the session id is not on log lines (it is context for the product, not a log field)', () => {
      inRequest(() => {
        setRequestPrincipal({ userId: 'u-1', sessionId: 'secret-session-id' });
        expect(JSON.stringify(mixin()())).not.toContain('secret-session-id');
      });
    });

    it('cannot shadow what the logger or the context owns', () => {
      for (const name of [
        'userId',
        'sessionId',
        'workspaceId',
        'correlationId',
        'trace.id',
        'span.id',
        'msg',
        'level',
        'time',
        'err',
      ]) {
        inRequest((ctx) => {
          expect(
            () => setRequestPrincipal({ userId: 'u', sessionId: 's', fields: { [name]: 'x' } }),
            name,
          ).toThrow(TypeError);
          expect(ctx.userId).toBeUndefined(); // nothing was written
        });
      }
    });

    it.each([
      ['an upper-case first letter', { Role: 'x' }],
      ['a name with a space', { 'a b': 'x' }],
      ['a name that is too long', { ['a'.repeat(41)]: 'x' }],
      ['an object value', { role: {} as never }],
      ['an array value', { role: ['a'] as never }],
      ['a null value', { role: null as never }],
      ['a NaN', { n: Number.NaN }],
      ['an Infinity', { n: Number.POSITIVE_INFINITY }],
      ['a long string', { role: 'x'.repeat(129) }],
      ['a string with a newline', { role: 'a\nb' }],
    ])('refuses %s', (_name, fields) => {
      inRequest(() => {
        expect(() => setRequestPrincipal({ userId: 'u', sessionId: 's', fields })).toThrow(
          TypeError,
        );
      });
    });

    it(`allows at most ${MAX_PRINCIPAL_FIELDS}`, () => {
      const many = (n: number) =>
        Object.fromEntries(Array.from({ length: n }, (_, i) => [`f${i}`, i]));
      inRequest(() => {
        expect(
          setRequestPrincipal({ userId: 'u', sessionId: 's', fields: many(MAX_PRINCIPAL_FIELDS) }),
        ).toBe(true);
        expect(() =>
          setRequestPrincipal({
            userId: 'u',
            sessionId: 's',
            fields: many(MAX_PRINCIPAL_FIELDS + 1),
          }),
        ).toThrow(TypeError);
      });
    });

    it('are replaced, not merged, by a later call, and frozen once set', () => {
      inRequest((ctx) => {
        setRequestPrincipal({ userId: 'u', sessionId: 's', fields: { role: 'admin' } });
        setRequestPrincipal({ userId: 'u', sessionId: 's', fields: { plan: 'free' } });
        expect(ctx.principalFields).toEqual({ plan: 'free' });
        expect(Object.isFrozen(ctx.principalFields)).toBe(true);
        setRequestPrincipal({ userId: 'u', sessionId: 's' });
        expect(ctx.principalFields).toBeUndefined();
      });
    });

    it('a key such as __proto__ cannot pollute anything', () => {
      inRequest(() => {
        expect(() =>
          setRequestPrincipal({
            userId: 'u',
            sessionId: 's',
            fields: JSON.parse('{"__proto__": "x"}') as never,
          }),
        ).toThrow(TypeError);
        expect(({} as Record<string, unknown>)['x']).toBeUndefined();
      });
    });
  });
});
