import { describe, expect, it } from 'vitest';
import { DEFAULTS } from './defaults';
import { oauthRateLimitRules } from './rate-limit';

describe('oauthRateLimitRules', () => {
  it('limits exactly /sign-in/social and /callback/*, by default 120 per 60 s', () => {
    expect(oauthRateLimitRules()).toEqual({
      '/sign-in/social': { window: 60, max: 120 },
      '/callback/*': { window: 60, max: 120 },
    });
    expect(DEFAULTS.rateLimit.oauth.paths).toEqual(['/sign-in/social', '/callback/*']);
  });

  it('never names a credential endpoint', () => {
    for (const path of Object.keys(oauthRateLimitRules({ windowSeconds: 60, max: 10_000 }))) {
      expect(path).not.toMatch(/sign-in\/(email|sso)|sign-up|change-|reset|forget|two-factor/);
    }
  });

  it('takes the consumer’s window and ceiling for both paths', () => {
    expect(oauthRateLimitRules({ windowSeconds: 10, max: 7 })).toEqual({
      '/sign-in/social': { window: 10, max: 7 },
      '/callback/*': { window: 10, max: 7 },
    });
  });

  it('is sized for about a hundred staff in one minute: each sign-in is one request per path', () => {
    const { windowSeconds, max } = DEFAULTS.rateLimit.oauth;
    expect(windowSeconds).toBe(60);
    expect(max).toBeGreaterThanOrEqual(100);
  });

  it.each([
    ['a zero window', { windowSeconds: 0, max: 10 }],
    ['a negative window', { windowSeconds: -1, max: 10 }],
    ['a window past an hour', { windowSeconds: 3601, max: 10 }],
    ['a zero ceiling', { windowSeconds: 60, max: 0 }],
    ['a fractional ceiling', { windowSeconds: 60, max: 1.5 }],
    ['a ceiling so large it is no limit', { windowSeconds: 60, max: 100_000 }],
    ['NaN', { windowSeconds: Number.NaN, max: 10 }],
    ['Infinity', { windowSeconds: 60, max: Number.POSITIVE_INFINITY }],
    ['a string', { windowSeconds: '60' as unknown as number, max: 10 }],
  ])('refuses %s, naming the setting', (_label, limit) => {
    expect(() => oauthRateLimitRules(limit)).toThrow(/identity: oauthRateLimit\./);
  });

  it('accepts the bounds themselves', () => {
    expect(() => oauthRateLimitRules({ windowSeconds: 1, max: 1 })).not.toThrow();
    expect(() => oauthRateLimitRules({ windowSeconds: 3600, max: 10_000 })).not.toThrow();
  });

  it('keeps DEFAULTS frozen, so a product cannot loosen it by mutation', () => {
    expect(Object.isFrozen(DEFAULTS.rateLimit.oauth)).toBe(true);
    expect(Object.isFrozen(DEFAULTS.rateLimit.oauth.paths)).toBe(true);
    expect(Object.isFrozen(DEFAULTS.cookies)).toBe(true);
  });
});
