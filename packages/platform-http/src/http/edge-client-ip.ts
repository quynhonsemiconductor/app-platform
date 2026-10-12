import { createHmac, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { Logger } from '@nestjs/common';
import { getMeter } from '@quynhonsemiconductor/observability';
import {
  EDGE_IP_HEADER,
  EDGE_MAX_SKEW_SECONDS,
  EDGE_SECRET_MIN_LENGTH,
  EDGE_SIG_HEADER,
  EDGE_TS_HEADER,
  edgePath,
  edgeSigningString,
} from './edge-protocol';

/** The secret the Worker signs with. Setting it turns the signed edge client IP on. */
export const EDGE_SECRET_ENV = 'EDGE_CLIENT_IP_SECRET';
/** The secret being retired, accepted alongside the current one while a rotation rolls out. */
export const EDGE_SECRET_PREVIOUS_ENV = 'EDGE_CLIENT_IP_SECRET_PREVIOUS';

/** Why an edge client IP was refused. A closed set: it is a metric label. */
export type EdgeRejection =
  | 'incomplete' // some of the three headers, not all
  | 'malformed' // a repeated header, or a timestamp/signature that is not the shape of one
  | 'unverifiable' // the request has no method or path to check the signature against
  | 'stale' // the timestamp is more than 60 s from now
  | 'bad_signature' // wrong secret, or the request is not the one that was signed
  | 'not_ip'; // validly signed, but the value is not an IP address

export const EDGE_REJECTED_METRIC = 'edge_client_ip.rejected';

type Headers = Record<string, string | string[] | undefined>;

/** The slice of a request the verifier reads. */
export interface EdgeRequest {
  headers?: Headers | undefined;
  method?: string | undefined;
  url?: string | undefined;
}

export interface EdgeConfig {
  /** Current secret first, then the previous one if there is one. */
  secrets: readonly string[];
}

/**
 * Read the secrets from the environment. `undefined` when `EDGE_CLIENT_IP_SECRET` is unset: the
 * feature is OFF and `clientIp()` behaves exactly as before. THROWS when it is set but unusable (too
 * short, or a previous secret without a current one), naming the variable and never its value.
 */
export function readEdgeConfig(env: NodeJS.ProcessEnv = process.env): EdgeConfig | undefined {
  const current = env[EDGE_SECRET_ENV]?.trim();
  const previous = env[EDGE_SECRET_PREVIOUS_ENV]?.trim();
  if (!current) {
    if (previous) {
      throw new Error(`${EDGE_SECRET_PREVIOUS_ENV} is set but ${EDGE_SECRET_ENV} is not.`);
    }
    return undefined;
  }
  for (const [name, value] of [
    [EDGE_SECRET_ENV, current],
    [EDGE_SECRET_PREVIOUS_ENV, previous],
  ] as const) {
    if (value !== undefined && value !== '' && value.length < EDGE_SECRET_MIN_LENGTH) {
      throw new Error(
        `${name} must be at least ${EDGE_SECRET_MIN_LENGTH} characters: it is a signing key.`,
      );
    }
  }
  return { secrets: previous ? [current, previous] : [current] };
}

/**
 * Check the edge settings at startup (the rate-limit guard calls it), so a short or half-set secret
 * is a boot error that names the variable, not a feature that quietly does nothing.
 */
export function assertEdgeClientIpEnv(env: NodeJS.ProcessEnv = process.env): void {
  readEdgeConfig(env);
}

function only(headers: Headers, name: string): string | undefined | 'repeated' {
  const value = headers[name];
  if (Array.isArray(value)) return value.length === 1 ? value[0] : 'repeated';
  return value;
}

const TS = /^\d{1,12}$/;
const SIG = /^[A-Za-z0-9_-]{43}$/;

/**
 * The visitor's address from a signed edge header, or `undefined` (with `reject` told why, unless the
 * headers were simply absent).
 *
 * Accepted only when ALL hold: the three headers are present once each; the timestamp is within
 * {@link EDGE_MAX_SKEW_SECONDS} of `nowSeconds` either way; the HMAC-SHA256 of
 * `ts|ip|METHOD|path` (this request's method and path) under the current or the previous secret
 * matches in constant time; and the value is a literal IP address. Anything else is ignored, so a
 * forged, replayed-elsewhere or stale header costs the caller nothing but the fallback.
 */
export function verifyEdgeClientIp(
  req: EdgeRequest,
  config: EdgeConfig,
  nowSeconds: number,
  reject: (reason: EdgeRejection) => void = () => undefined,
): string | undefined {
  const headers = req.headers ?? {};
  const ip = only(headers, EDGE_IP_HEADER);
  const ts = only(headers, EDGE_TS_HEADER);
  const sig = only(headers, EDGE_SIG_HEADER);

  if (ip === undefined && ts === undefined && sig === undefined) return undefined; // no edge: not a rejection
  if (ip === undefined || ts === undefined || sig === undefined) return fail('incomplete', reject);
  if (ip === 'repeated' || ts === 'repeated' || sig === 'repeated')
    return fail('malformed', reject);
  if (!TS.test(ts) || !SIG.test(sig)) return fail('malformed', reject);
  if (typeof req.method !== 'string' || typeof req.url !== 'string') {
    return fail('unverifiable', reject);
  }

  const signedAt = Number(ts);
  if (Math.abs(nowSeconds - signedAt) > EDGE_MAX_SKEW_SECONDS) return fail('stale', reject);

  const given = Buffer.from(sig, 'base64url');
  const input = edgeSigningString(signedAt, ip, req.method, edgePath(req.url));
  // Every secret is tried and the result OR-ed: no early exit says which one matched.
  let valid = false;
  for (const secret of config.secrets) {
    const expected = createHmac('sha256', secret).update(input).digest();
    valid = (given.length === expected.length && timingSafeEqual(given, expected)) || valid;
  }
  if (!valid) return fail('bad_signature', reject);
  if (isIP(ip) === 0) return fail('not_ip', reject);
  return ip;
}

function fail(reason: EdgeRejection, reject: (r: EdgeRejection) => void): undefined {
  reject(reason);
  return undefined;
}

// ── what clientIp() does with a rejection: count it, and say so at most once a minute ─────────────

let counter: { add(value: number, attributes: { reason: string }): void } | undefined;
const logger = new Logger('EdgeClientIp');
const WARN_EVERY_MS = 60_000;
const pending = new Map<EdgeRejection, number>();
let lastWarnAt = 0;

/**
 * Count one rejected signature (`edge_client_ip.rejected{reason}`) and log a summary at most once a
 * minute. Never throws, never logs a header value: the reason and a count only.
 */
export function reportEdgeRejection(reason: EdgeRejection, nowMs: number = Date.now()): void {
  try {
    counter ??= getMeter('platform-http').createCounter(EDGE_REJECTED_METRIC, {
      description: 'Signed edge client IPs refused, by reason',
    });
    counter.add(1, { reason });

    pending.set(reason, (pending.get(reason) ?? 0) + 1);
    if (nowMs - lastWarnAt >= WARN_EVERY_MS) {
      lastWarnAt = nowMs;
      const summary = [...pending].map(([r, n]) => `${r}=${n}`).join(' ');
      pending.clear();
      logger.warn(`Refused signed edge client IPs since the last report: ${summary}`);
    }
  } catch {
    // Telemetry must never fail a request.
  }
}

/** Test seam: forget the counter and the warning throttle. */
export function resetEdgeReportingForTesting(): void {
  counter = undefined;
  pending.clear();
  lastWarnAt = 0;
}

// ── configuration, read per call from the environment and cached by its text ──────────────────────

let cachedKey: string | undefined;
let cachedConfig: EdgeConfig | undefined;
let misconfigurationLogged = false;

/**
 * The edge configuration of THIS process, from the environment. Unusable settings are logged once
 * and treated as OFF here (a request must never fail on them); `assertEdgeClientIpEnv` is what makes
 * them a boot error.
 */
export function edgeConfigFromEnv(env: NodeJS.ProcessEnv = process.env): EdgeConfig | undefined {
  const key = `${env[EDGE_SECRET_ENV] ?? ''}\n${env[EDGE_SECRET_PREVIOUS_ENV] ?? ''}`;
  if (key === cachedKey) return cachedConfig;
  try {
    cachedConfig = readEdgeConfig(env);
  } catch (error) {
    cachedConfig = undefined;
    if (!misconfigurationLogged) {
      misconfigurationLogged = true;
      logger.error(`${(error as Error).message} The signed edge client IP is OFF.`);
    }
  }
  cachedKey = key;
  return cachedConfig;
}

/** Test seam. */
export function resetEdgeConfigForTesting(): void {
  cachedKey = undefined;
  cachedConfig = undefined;
  misconfigurationLogged = false;
}
