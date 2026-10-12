import { DEFAULTS } from './defaults';

/** How often, per client address and per path, an endpoint may be called. */
export interface RateLimit {
  windowSeconds: number;
  max: number;
}

/**
 * The limits of the endpoints that only start or finish a redirect to an identity provider. Each
 * group is optional; an absent one keeps its default (`DEFAULTS.rateLimit`).
 */
export interface OAuthRateLimit {
  /** `/sign-in/social` and `/sign-in/sso`. Default 120 per 60 s. */
  start?: RateLimit;
  /** `/callback/*` and `/sso/callback/*`. Default 100 per 10 s. */
  callback?: RateLimit;
}

/** What Better Auth's `rateLimit.customRules` takes for one path. */
type Rule = { window: number; max: number };

const MAX_WINDOW_SECONDS = 3600;
const MAX_REQUESTS = 10_000;

function integer(name: string, value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`identity: oauthRateLimit.${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function resolve(
  group: 'start' | 'callback',
  limit: RateLimit | undefined,
): { window: number; max: number } {
  const d = DEFAULTS.rateLimit[group];
  if (limit === undefined) return { window: d.windowSeconds, max: d.max };
  if (limit === null || typeof limit !== 'object') {
    throw new Error(`identity: oauthRateLimit.${group} must be { windowSeconds, max }`);
  }
  return {
    window: integer(`${group}.windowSeconds`, limit.windowSeconds, 1, MAX_WINDOW_SECONDS),
    max: integer(`${group}.max`, limit.max, 1, MAX_REQUESTS),
  };
}

/**
 * Better Auth `customRules` for the endpoints that only start or finish an identity-provider
 * redirect (see `DEFAULTS.rateLimit`). Both values are bounded: a window of an hour and 10 000
 * requests are far beyond any office, and a typo must not switch the limiter off (`max: 1e9`,
 * `windowSeconds: 0`). Anything that is not an object with those two integers is refused.
 */
export function oauthRateLimitRules(limit?: OAuthRateLimit): Record<string, Rule> {
  if (limit !== undefined && (limit === null || typeof limit !== 'object')) {
    throw new Error('identity: oauthRateLimit must be { start?, callback? }');
  }
  // Unknown keys are mistakes (an earlier draft took `{ windowSeconds, max }` directly): refuse them
  // rather than silently keep the defaults the consumer thought they had replaced.
  for (const key of Object.keys(limit ?? {})) {
    if (key !== 'start' && key !== 'callback') {
      throw new Error(
        `identity: oauthRateLimit.${key} is not a setting; use { start?, callback? }`,
      );
    }
  }
  const rules: Record<string, Rule> = {};
  for (const group of ['start', 'callback'] as const) {
    const rule = resolve(group, limit?.[group]);
    for (const path of DEFAULTS.rateLimit[group].paths) rules[path] = { ...rule };
  }
  return rules;
}
