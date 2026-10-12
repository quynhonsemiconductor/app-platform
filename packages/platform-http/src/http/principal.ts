import { requestContextStorage } from './request-context.service';

/**
 * The authenticated user of the current request, or `undefined` (not authenticated yet, a public route, or
 * nothing seeded a request context).
 *
 * This is the ONLY place `platform-http` learns who is calling: the rate limit's `uid:` key, the
 * idempotency key, the access log's `userId`, and the exception filter's security log all read it. The
 * authentication layer writes it with `setRequestPrincipal` (from `@quynhonsemiconductor/observability`;
 * identity's `SessionGuard` does). Nothing here reads `req.user`, `req.user.sub` or `req.user.id`: a product
 * whose guard sets only those must also call `setRequestPrincipal`, or its authenticated callers are keyed
 * by address.
 *
 * Order matters: the guard that authenticates must run BEFORE `RateLimitGuard`.
 */
export function currentUserId(): string | undefined {
  return requestContextStorage.getStore()?.userId;
}

/**
 * Set on the request by {@link RateLimitGuard} when it keyed the caller by ADDRESS because the request context
 * held no principal yet. A guard that authenticates AFTER it (identity's `SessionGuard`, registered in the
 * wrong order) looks for this to say so: the whole NAT is then one bucket. `Symbol.for`, so the two packages
 * agree without importing each other.
 */
export const KEYED_BY_ADDRESS = Symbol.for('@quynhonsemiconductor/platform-http:keyed-by-address');

let warnedUnauthenticatedWithoutPrincipal = false;

/**
 * For the access log: the request carries what looks like an authenticated caller (`req.user` or `req.session`)
 * but the context holds no principal. That is the 5.0 migration trap (a guard that sets only `req.user`):
 * the rate limit keys by address and the log has no `userId`. Warns ONCE per process, says what to do.
 */
export function warnOnceIfAuthenticatedWithoutPrincipal(
  req: object,
  warn: (message: string) => void,
): void {
  if (warnedUnauthenticatedWithoutPrincipal || currentUserId() !== undefined) return;
  const r = req as { user?: unknown; session?: unknown };
  if (!r.user && !r.session) return;
  warnedUnauthenticatedWithoutPrincipal = true;
  warn(
    'A request is authenticated (req.user / req.session is set) but the request context holds no principal: ' +
      'the rate limit keys this caller by address and the access log has no userId. Call ' +
      '`setRequestPrincipal({ userId, sessionId })` from @quynhonsemiconductor/observability in the guard that ' +
      'authenticates, and register that guard BEFORE RateLimitGuard (see "Who the user is" in the platform-http README).',
  );
}

/** Test seam. */
export function resetPrincipalWarningsForTesting(): void {
  warnedUnauthenticatedWithoutPrincipal = false;
}
