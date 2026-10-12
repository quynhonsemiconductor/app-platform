import { describe, expect, it } from 'vitest';
import { DEFAULTS } from './defaults';
import { oauthRateLimitRules } from './rate-limit';

describe('oauthRateLimitRules', () => {
  it('limits exactly the four redirect endpoints: start 120 per 60 s, callback 100 per 10 s', () => {
    expect(oauthRateLimitRules()).toEqual({
      '/sign-in/social': { window: 60, max: 120 },
      '/sign-in/sso': { window: 60, max: 120 },
      '/callback/*': { window: 10, max: 100 },
      '/sso/callback/*': { window: 10, max: 100 },
    });
  });

  it('never names a credential endpoint', () => {
    const paths = Object.keys(oauthRateLimitRules({ start: { windowSeconds: 60, max: 10_000 } }));
    for (const path of paths) {
      expect(path).not.toMatch(
        /sign-in\/email|sign-up|change-|reset|forget|two-factor|verify|send-verification/,
      );
    }
  });

  it('the callback default is not stricter than the 100 per 10 s Better Auth already gave it', () => {
    // Better Auth has no special rule for /callback/*, so the global 100 per 10 s applied. A longer
    // window with a smaller-looking number (120 per 60 s) would have been five times STRICTER.
    const { windowSeconds, max } = DEFAULTS.rateLimit.callback;
    expect((max * 10) / windowSeconds).toBeGreaterThanOrEqual(100);
  });

  it('the start default is sized for about a hundred staff in one minute', () => {
    const { windowSeconds, max } = DEFAULTS.rateLimit.start;
    expect(windowSeconds).toBe(60);
    expect(max).toBeGreaterThanOrEqual(100);
  });

  it('takes each group on its own and keeps the default of the one left out', () => {
    expect(oauthRateLimitRules({ start: { windowSeconds: 30, max: 9 } })).toEqual({
      '/sign-in/social': { window: 30, max: 9 },
      '/sign-in/sso': { window: 30, max: 9 },
      '/callback/*': { window: 10, max: 100 },
      '/sso/callback/*': { window: 10, max: 100 },
    });
    expect(oauthRateLimitRules({ callback: { windowSeconds: 20, max: 7 } })).toMatchObject({
      '/sign-in/social': { window: 60, max: 120 },
      '/callback/*': { window: 20, max: 7 },
      '/sso/callback/*': { window: 20, max: 7 },
    });
  });

  it.each([
    ['a zero window', { start: { windowSeconds: 0, max: 10 } }],
    ['a negative window', { callback: { windowSeconds: -1, max: 10 } }],
    ['a window past an hour', { start: { windowSeconds: 3601, max: 10 } }],
    ['a zero ceiling', { start: { windowSeconds: 60, max: 0 } }],
    ['a fractional ceiling', { callback: { windowSeconds: 60, max: 1.5 } }],
    ['a ceiling so large it is no limit', { start: { windowSeconds: 60, max: 100_000 } }],
    ['NaN', { start: { windowSeconds: Number.NaN, max: 10 } }],
    ['Infinity', { callback: { windowSeconds: 60, max: Number.POSITIVE_INFINITY } }],
    ['a string', { start: { windowSeconds: '60' as unknown as number, max: 10 } }],
    ['a group without its fields', { start: { max: 10 } as never }],
    ['a group that is not an object', { start: 'lots' as never }],
    ['the shape of an earlier draft', { windowSeconds: 60, max: 10 } as never],
    ['an unknown group', { login: { windowSeconds: 60, max: 10 } } as never],
    ['a null', null as never],
  ])('refuses %s, naming the setting', (_label, limit) => {
    expect(() => oauthRateLimitRules(limit)).toThrow(/identity: oauthRateLimit/);
  });

  it('accepts the bounds themselves', () => {
    expect(() => oauthRateLimitRules({ start: { windowSeconds: 1, max: 1 } })).not.toThrow();
    expect(() =>
      oauthRateLimitRules({ callback: { windowSeconds: 3600, max: 10_000 } }),
    ).not.toThrow();
  });

  it('keeps DEFAULTS frozen, so a product cannot loosen it by mutation', () => {
    for (const group of [DEFAULTS.rateLimit.start, DEFAULTS.rateLimit.callback]) {
      expect(Object.isFrozen(group)).toBe(true);
      expect(Object.isFrozen(group.paths)).toBe(true);
    }
    expect(Object.isFrozen(DEFAULTS.cookies)).toBe(true);
  });
});
