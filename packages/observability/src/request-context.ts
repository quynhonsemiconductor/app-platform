import { Injectable } from '@nestjs/common';
import { requestContextStorage, type RequestContext } from './request-context-storage';

export { requestContextStorage, type RequestContext };

/** What the authentication layer tells the rest of the process about the caller of THIS request. */
export interface RequestPrincipal {
  /** The authenticated user's id: what rate limits, idempotency keys and logs call "the user". */
  userId: string;
  /** The session this request authenticated with. An id, never the session token. */
  sessionId: string;
  /** The product's tenant/workspace, if it has one. */
  workspaceId?: string | undefined;
  /**
   * Further fields for the product's log lines (a role, a plan, a branch). At most {@link MAX_PRINCIPAL_FIELDS};
   * keys `[a-z][A-Za-z0-9_.]{0,39}` that are not one of the logger's own; values a string of at most 128
   * characters, a finite number or a boolean. Observability only: nothing here is an authorization input.
   */
  fields?: Record<string, string | number | boolean> | undefined;
}

export const MAX_PRINCIPAL_FIELDS = 8;
const FIELD_KEY = /^[a-z][A-Za-z0-9_.]{0,39}$/;
const ID_MAX = 128;
/** Names the logger or the request context already owns: a product field may not shadow them. */
const RESERVED_FIELDS = new Set([
  'userId',
  'sessionId',
  'workspaceId',
  'correlationId',
  'traceparent',
  'time',
  'level',
  'msg',
  'message',
  'service',
  'env',
  'version',
  'err',
  'error',
  'req',
  'res',
  'pid',
  'hostname',
  'trace.id',
  'span.id',
]);

function assertId(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > ID_MAX) {
    throw new TypeError(
      `setRequestPrincipal: ${name} must be a non-empty string of at most ${ID_MAX} characters`,
    );
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    throw new TypeError(`setRequestPrincipal: ${name} must not contain control characters`);
  }
}

function validFields(
  fields: Record<string, string | number | boolean>,
): Readonly<Record<string, string | number | boolean>> {
  const entries = Object.entries(fields);
  if (entries.length > MAX_PRINCIPAL_FIELDS) {
    throw new TypeError(`setRequestPrincipal: at most ${MAX_PRINCIPAL_FIELDS} fields`);
  }
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of entries) {
    if (!FIELD_KEY.test(key) || RESERVED_FIELDS.has(key)) {
      throw new TypeError(`setRequestPrincipal: field name "${key.slice(0, 40)}" is not allowed`);
    }
    const ok =
      (typeof value === 'string' &&
        value.length <= ID_MAX &&
        !/[\u0000-\u001f\u007f]/.test(value)) || // eslint-disable-line no-control-regex
      (typeof value === 'number' && Number.isFinite(value)) ||
      typeof value === 'boolean';
    if (!ok) throw new TypeError(`setRequestPrincipal: field "${key}" has an unsupported value`);
    out[key] = value;
  }
  return Object.freeze(out);
}

const als = requestContextStorage;

@Injectable()
export class RequestContextService {
  run<T>(context: RequestContext, fn: () => T): T {
    return als.run(context, fn);
  }

  get(): RequestContext | undefined {
    return als.getStore();
  }

  getOrThrow(): RequestContext {
    const ctx = als.getStore();
    if (!ctx) throw new Error('No request context in AsyncLocalStorage');
    return ctx;
  }

  getWorkspaceId(): string | undefined {
    return als.getStore()?.workspaceId;
  }

  getUserId(): string | undefined {
    return als.getStore()?.userId;
  }

  getCorrelationId(): string | undefined {
    return als.getStore()?.correlationId;
  }

  /** Mutate workspace + user once populated from JWT in JwtAuthGuard */
  setAuthContext(workspaceId: string | undefined, userId: string, sessionId: string): void {
    const ctx = als.getStore();
    if (ctx) {
      ctx.workspaceId = workspaceId;
      ctx.userId = userId;
      ctx.sessionId = sessionId;
    }
  }
}

/**
 * Record WHO is calling, once authentication has succeeded, in the request context that
 * `enableCorrelationId` (or any other seeding) created. This is the contract between the authentication
 * layer and everything else: `platform-http`'s rate limit, idempotency key, access log and exception filter
 * read the user from here and from nowhere else (no `req.user`), so any guard that authenticates (identity's
 * `SessionGuard`, a product's own) calls this and nothing more.
 *
 * Returns `false` when there is no request context to write to (nothing seeded it): the call then does
 * nothing, and the rate limit falls back to the client address. Throws `TypeError` for an invalid value:
 * a programming error, never caller input.
 */
export function setRequestPrincipal(principal: RequestPrincipal): boolean {
  assertId(principal.userId, 'userId');
  assertId(principal.sessionId, 'sessionId');
  if (principal.workspaceId !== undefined) assertId(principal.workspaceId, 'workspaceId');
  const fields = principal.fields === undefined ? undefined : validFields(principal.fields);
  const ctx = requestContextStorage.getStore();
  if (!ctx) return false;
  ctx.userId = principal.userId;
  ctx.sessionId = principal.sessionId;
  if (principal.workspaceId !== undefined) ctx.workspaceId = principal.workspaceId;
  ctx.principalFields = fields;
  return true;
}

/** The principal of the current request, or `undefined` before authentication / outside a request. */
export function getRequestPrincipal(): Pick<RequestPrincipal, 'userId' | 'sessionId'> | undefined {
  const ctx = requestContextStorage.getStore();
  return ctx?.userId && ctx.sessionId
    ? { userId: ctx.userId, sessionId: ctx.sessionId }
    : undefined;
}
