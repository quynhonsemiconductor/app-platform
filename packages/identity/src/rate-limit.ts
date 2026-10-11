import { DEFAULTS } from './defaults';

/** How often, per client address and per path, an endpoint may be called. */
export interface OAuthRateLimit {
  windowSeconds: number;
  max: number;
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

/**
 * Better Auth `customRules` for the endpoints that only start or finish an identity-provider
 * redirect (see `DEFAULTS.rateLimit.oauth`). `limit` is the consumer's override; absent, the
 * default. Both values are bounded: a window of an hour and 10 000 requests are far beyond any
 * office, and a typo must not switch the limiter off (`max: 1e9`, `windowSeconds: 0`).
 */
export function oauthRateLimitRules(limit?: OAuthRateLimit): Record<string, Rule> {
  const d = DEFAULTS.rateLimit.oauth;
  const windowSeconds =
    limit === undefined
      ? d.windowSeconds
      : integer('windowSeconds', limit.windowSeconds, 1, MAX_WINDOW_SECONDS);
  const max = limit === undefined ? d.max : integer('max', limit.max, 1, MAX_REQUESTS);
  return Object.fromEntries(d.paths.map((path) => [path, { window: windowSeconds, max }]));
}
