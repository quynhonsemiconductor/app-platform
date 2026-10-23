import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyOptions } from 'jose';

/**
 * Cloudflare Access JWT verification — the origin side of the MCP plan (product-docs
 * `platform/MCP-PLAN.md` §5). Verifies the `Cf-Access-Jwt-Assertion` **request header** (the
 * Per-App token Cloudflare attaches to every authorized request); it is not the
 * `CF_Authorization` cookie, and nothing here reads cookies. This module is the only
 * MCP-adjacent code that touches auth: everything downstream already runs behind the app's own
 * guards.
 *
 * Verification is full and pinned:
 *  - signature against the team JWKS (`https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`),
 *    cached and rotation-safe: an unknown `kid` triggers a refresh (jose `createRemoteJWKSet`),
 *  - `iss` = the team domain, `aud` = the configured AUD tag(s), RS256 only,
 *  - `exp` + `nbf` with a small configurable tolerance.
 *
 * Identity mapping: the Entra object id arrives as a custom OIDC claim — its location is
 * configurable (dot path, default top-level `oid`). Falling back to the token's `email` is
 * opt-in and off by default: the email is verified by the IdP but can be reassigned, the `oid`
 * cannot (plan §5). Error messages here are for logs and tests, never echoed to clients.
 */

/** Failure reasons, stable strings — callers branch on `code`, never on message text. */
export type AccessJwtErrorCode =
  | 'malformed'
  | 'invalid_signature'
  | 'expired'
  | 'not_yet_valid'
  | 'bad_issuer'
  | 'bad_audience'
  | 'wrong_algorithm'
  | 'missing_principal'
  /** The JWKS could not be fetched (network outage, timeout). A 5xx, never a "bad token". */
  | 'jwks_unavailable';

export class AccessJwtError extends Error {
  constructor(
    public readonly code: AccessJwtErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AccessJwtError';
  }
}

export interface AccessJwtConfig {
  /** The Access team domain as an origin, e.g. `https://example-team.cloudflareaccess.com`. `iss` must equal it. */
  teamDomain: string;
  /** The Access application's AUD tag(s). A token minted for another app on the same team is rejected. */
  audience: string | readonly string[];
  /**
   * Where the Entra `oid` claim lives, as a dot path. Default `'oid'` (top-level, the custom OIDC
   * claim). Use e.g. `'custom.oid'` if the IdP namespaces it. Must not be empty.
   */
  oidClaimPath?: string;
  /**
   * Fall back to the token's `email` when the `oid` claim is absent. Off by default (plan §5:
   * IdP-verified, but emails can be reassigned; only gate (d)'s failure path enables this).
   */
  allowEmailFallback?: boolean;
  /** Clock tolerance for `exp`/`nbf`, in seconds. Default 60. */
  clockToleranceSeconds?: number;
  /** JWKS fetch timeout, in **seconds**. Default 10 (jose's default). A hang is `jwks_unavailable`. */
  jwksTimeoutSeconds?: number;
  /**
   * JWKS refresh cooldown after a fetch, in **seconds**. Default 30. (jose's own
   * `cooldownDuration` is milliseconds; this converts so callers think in seconds.)
   */
  jwksCooldownSeconds?: number;
}

/** Who the caller is, mapped from a verified Access JWT. */
export interface AccessPrincipal {
  /** Entra object id from the configured claim. `null` only under an enabled email fallback. */
  oid: string | null;
  /** Token `email` claim, when present. Apps decide whether to trust it beyond the fallback. */
  email: string | null;
  /** Token `sub` (the Access-stable identity of the person at this team). */
  sub: string;
}

const DEFAULT_CLOCK_TOLERANCE_SECONDS = 60;
const DEFAULT_JWKS_COOLDOWN_SECONDS = 30;
const DEFAULT_OID_CLAIM_PATH = 'oid';

/** Read a dot path (`'custom.oid'`) out of a JWT payload. Returns `undefined` for a miss. */
function claimAt(payload: JWTPayload, path: string): unknown {
  let node: unknown = payload;
  for (const segment of path.split('.')) {
    if (typeof node !== 'object' || node === null) return undefined;
    node = (node as Record<string, unknown>)[segment];
  }
  return node;
}

/**
 * Map a jose failure to our stable codes, with fixed message text (jose's own messages are
 * implementation detail — callers branch on `code`; UIs must never echo the message).
 * Order matters: the specific check before the generic.
 */
function classify(error: unknown): AccessJwtError {
  const code = (error as { code?: string } | null)?.code ?? '';
  switch (code) {
    case 'ERR_JWT_EXPIRED':
      return new AccessJwtError('expired', 'the Access JWT has expired');
    case 'ERR_JWT_MALFORMED':
      return new AccessJwtError('malformed', 'the Access JWT is malformed');
    case 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED':
    case 'ERR_JWS_SIGNATURE_VERIFICATION_INVALID':
    case 'ERR_JWS_KEY_NOT_FOUND':
    case 'ERR_JWKS_NO_MATCHING_KEY':
      return new AccessJwtError('invalid_signature', 'the Access JWT signature is invalid');
    case 'ERR_JWS_ALGORITHM_NOT_ALLOWED':
    case 'ERR_JOSE_ALG_NOT_ALLOWED':
      return new AccessJwtError('wrong_algorithm', 'the Access JWT `alg` is not RS256');
    case 'ERR_JWT_CLAIM_VALIDATION_FAILED': {
      const claim = (error as { claim?: string } | null)?.claim;
      if (claim === 'iss')
        return new AccessJwtError(
          'bad_issuer',
          'the Access JWT `iss` is not the configured team domain',
        );
      if (claim === 'aud')
        return new AccessJwtError(
          'bad_audience',
          'the Access JWT `aud` is not the configured AUD tag',
        );
      if (claim === 'nbf')
        return new AccessJwtError('not_yet_valid', 'the Access JWT is not yet valid (nbf)');
      break;
    }
    case 'ERR_JWKS_TIMEOUT': // the JWKS fetch exceeded `timeoutDuration`
    case 'ERR_JWKS_INVALID': // the JWKS response was not a usable JWK set
    case 'ERR_JWKS_MULTIPLE_MATCHING_KEYS': // the JWKS served the same kid twice
      // all three are JWKS-response problems, not token problems: a 5xx, never a "bad token"
      return new AccessJwtError('jwks_unavailable', 'the team JWKS could not be fetched');
    default:
      break;
  }
  // Availability problems, not bad tokens: an undici fetch failure surfaces as a plain TypeError
  // ("fetch failed"), a non-200 JWKS response as ERR_JOSE_GENERIC, a slow response as
  // ERR_JWKS_TIMEOUT (handled above). Callers map this code to a 5xx and must never echo the
  // message to clients — that goes for every code here.
  if (
    (code === '' || code === 'ERR_JOSE_GENERIC') &&
    /fetch|timed?\s*out|network|socket|ECONN|ENOTFOUND|expected 200 ok/i.test(
      (error as Error)?.message ?? '',
    )
  ) {
    return new AccessJwtError('jwks_unavailable', 'the team JWKS could not be fetched');
  }
  if (error instanceof AccessJwtError) return error;
  return new AccessJwtError('malformed', 'the Access JWT was rejected');
}

export interface AccessJwtVerifier {
  /** Verify a raw `Cf-Access-Jwt-Assertion` token and map it to the app principal. Throws {@link AccessJwtError}. */
  verify(token: string): Promise<AccessPrincipal>;
}

export function createAccessJwtVerifier(config: AccessJwtConfig): AccessJwtVerifier {
  const teamDomain = config.teamDomain.replace(/\/+$/, '');
  // `http` is accepted only for loopback hosts, so tests can run a local JWKS; production
  // configuration is always an https origin.
  const isLoopbackHttp = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(teamDomain);
  if (!/^https:\/\/[^/]+$/.test(teamDomain) && !isLoopbackHttp) {
    throw new AccessJwtError(
      'malformed',
      `teamDomain must be an https origin, got ${JSON.stringify(config.teamDomain)}`,
    );
  }
  if (config.audience === undefined || config.audience === null || config.audience === '') {
    throw new AccessJwtError(
      'malformed',
      'audience (the Access app AUD tag) is required — a token for another app must be rejected',
    );
  }
  const oidClaimPath = config.oidClaimPath ?? DEFAULT_OID_CLAIM_PATH;
  if (oidClaimPath.length === 0) {
    throw new AccessJwtError('malformed', 'oidClaimPath must not be empty');
  }
  const audience = Array.isArray(config.audience) ? [...config.audience] : [config.audience];
  const verifyOptions: JWTVerifyOptions = {
    issuer: teamDomain,
    audience,
    algorithms: ['RS256'], // pinned: an HS256/none token is rejected before any key is tried
    clockTolerance: config.clockToleranceSeconds ?? DEFAULT_CLOCK_TOLERANCE_SECONDS,
  };
  // jose caches the JWKS per key and refetches when a token carries an unknown `kid`
  // (rotation-safe); `cooldownDuration` — milliseconds here, seconds in our config —
  // throttles that refresh so a burst of bad kids cannot hammer the team domain.
  const jwks = createRemoteJWKSet(new URL('/cdn-cgi/access/certs', teamDomain), {
    cooldownDuration: (config.jwksCooldownSeconds ?? DEFAULT_JWKS_COOLDOWN_SECONDS) * 1000,
    timeoutDuration:
      config.jwksTimeoutSeconds === undefined ? undefined : config.jwksTimeoutSeconds * 1000,
  });

  async function verify(token: string): Promise<AccessPrincipal> {
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, jwks, verifyOptions));
    } catch (error) {
      throw classify(error);
    }

    const sub = payload.sub;
    if (typeof sub !== 'string' || sub.length === 0) {
      throw new AccessJwtError('missing_principal', 'the Access JWT carries no `sub`');
    }

    const oid = claimAt(payload, oidClaimPath);
    if (typeof oid === 'string' && oid.length > 0) {
      return { oid, email: typeof payload.email === 'string' ? payload.email : null, sub };
    }

    if (
      config.allowEmailFallback === true &&
      typeof payload.email === 'string' &&
      payload.email.length > 0
    ) {
      // Deliberate downgrade, enabled by config only after gate (d) proved the claim cannot
      // reach the origin (plan §5): the email is verified by the IdP but can be reassigned.
      return { oid: null, email: payload.email, sub };
    }
    throw new AccessJwtError(
      'missing_principal',
      `the Access JWT carries no \`${oidClaimPath}\` claim and the email fallback is not enabled`,
    );
  }

  return { verify };
}
