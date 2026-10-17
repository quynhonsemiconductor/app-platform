import { createAuthEndpoint, sensitiveSessionMiddleware, APIError } from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import type { BetterAuthPlugin } from 'better-auth';
import * as z from 'zod';
import { isUuid } from './ids';
import { emitSafely, errorFields, type IdentityLogger, type SecurityEventSink } from './events';

/**
 * The active context of a session: the product's own tenancy unit (rova: the workspace), stored on the
 * session row as `contextId` (identity plan §5.7, decision D6).
 *
 * MECHANISM in the package, POLICY in the product. The package keeps the value on the session, refuses to
 * set it to something the product's `membership` port does not approve, and re-checks it while the session
 * lives. What a context IS, who may act in one, and what a member may do there stay with the product: the
 * context never authorizes anything by itself (the product's guard decides, per request, from its own tables).
 *
 * `contextId` is a UUID. Nothing a client sends can set it except through `POST /context/set`.
 */
export interface ContextOptions {
  /**
   * May this user act in this context? Called when a context is set, when a session is created with an
   * `initial` context, and (at most once per `revalidateSeconds` per process, per user and context) when a
   * session that holds one is read. A throw is treated as "could not tell": a set is refused with a 500,
   * and a read keeps the context it has (fail-open; the product authorizes per request regardless).
   */
  membership: (userId: string, contextId: string) => boolean | Promise<boolean>;
  /**
   * The context a new session starts in, and the one a session falls back to when it loses its context
   * (rova: the last-active workspace). Must be a context the user is a member of: the package asks
   * `membership` about it too and uses `null` if it says no, throws, or returns something that is not a UUID.
   */
  initial?: (userId: string) => string | null | undefined | Promise<string | null | undefined>;
  /**
   * How long "this user is a member of this context" is believed per process before a read asks
   * `membership` again. Default 60. `0` asks on every session read (tests; costs a call per request).
   * With the public preset's cookie cache a session is not read from the store until the cookie cache
   * expires (5 minutes), so the effective window there is the cache window plus this.
   */
  revalidateSeconds?: number;
}

export const DEFAULT_REVALIDATE_SECONDS = 60;
const MAX_REVALIDATE_SECONDS = 3600;
const MEMO_MAX = 10_000;

export const CONTEXT_PATH = '/context/set';

export function validateContextOptions(o: ContextOptions | undefined): void {
  if (o === undefined) return;
  if (o === null || typeof o !== 'object' || typeof o.membership !== 'function') {
    throw new Error('identity: context needs a `membership(userId, contextId)` function');
  }
  if (o.initial !== undefined && typeof o.initial !== 'function') {
    throw new Error('identity: context.initial must be a function');
  }
  const s = o.revalidateSeconds;
  if (s !== undefined && (!Number.isInteger(s) || s < 0 || s > MAX_REVALIDATE_SECONDS)) {
    throw new Error(
      `identity: context.revalidateSeconds must be an integer from 0 to ${MAX_REVALIDATE_SECONDS}`,
    );
  }
}

type Row = Record<string, unknown>;

/** The slice of Better Auth's internal adapter the guard needs. */
interface SessionAdapter {
  findSession(token: string): Promise<{
    session: Row & { token?: unknown; contextId?: unknown };
    user: Row & { id?: unknown };
  } | null>;
  updateSession(token: string, data: Row): Promise<unknown>;
}

export interface ContextRuntime {
  options: Required<Pick<ContextOptions, 'membership'>> & ContextOptions;
  /** Remember (or forget) that a user was just found to be a member of a context. */
  believe(userId: string, contextId: string): void;
  forget(userId: string, contextId?: string): void;
  /** The context a session of this user starts in, or `null`. Never throws. */
  fallback(userId: string): Promise<string | null>;
  /** The `databaseHooks.session.create.before` hook. */
  createBefore(session: Row): Promise<{ data: Row } | undefined>;
  /**
   * After a session write that went through `internalAdapter.updateSession`: if the store (Valkey) degraded DURING it, the
   * database row is updated and the cached copy is not, and Better Auth reads the cache first, so the old context would come
   * back (A -> B silently reverting to A) when Valkey recovers. Drop the cached copy, as `revokeUserSessions` does, and say so
   * if that cannot be done either. `degradedBefore` is `degradedCount()` taken before the write.
   */
  reconcile(
    storage: { delete(key: string): Promise<void> } | undefined,
    token: string,
    degradedBefore: number,
  ): Promise<void>;
  degradedCount(): number;
  plugin: BetterAuthPlugin;
  /** Wrap `findSession` of this context once (idempotent). */
  install(context: object): void;
}

export function createContextRuntime(
  options: ContextOptions,
  deps: {
    sink: SecurityEventSink;
    onSinkError: (e: unknown) => void;
    logger: IdentityLogger;
    /** How many times the session store (Valkey) has failed so far. */
    degradedCount: () => number;
  },
): ContextRuntime {
  validateContextOptions(options);
  const ttlMs = (options.revalidateSeconds ?? DEFAULT_REVALIDATE_SECONDS) * 1000;
  const believed = new Map<string, number>();
  const keyOf = (userId: string, contextId: string) => `${userId}\u0000${contextId}`;
  const emit = (event: Parameters<typeof emitSafely>[1]) =>
    emitSafely(deps.sink, event, deps.onSinkError);

  const believe = (userId: string, contextId: string) => {
    if (ttlMs === 0) return;
    const key = keyOf(userId, contextId);
    believed.delete(key);
    if (believed.size >= MEMO_MAX) believed.delete(believed.keys().next().value as string);
    believed.set(key, Date.now() + ttlMs);
  };
  const forget = (userId: string, contextId?: string) => {
    if (contextId !== undefined) {
      believed.delete(keyOf(userId, contextId));
      return;
    }
    const prefix = `${userId}\u0000`;
    for (const key of believed.keys()) if (key.startsWith(prefix)) believed.delete(key);
  };

  const logFailure = (what: string, error: unknown) =>
    deps.logger.warn(`identity.context: ${what}`, {
      code: 'identity.context_port_failed',
      ...errorFields(error),
    });

  async function fallback(userId: string): Promise<string | null> {
    if (!options.initial) return null;
    try {
      const candidate = await options.initial(userId);
      if (!isUuid(candidate)) return null;
      if (!(await options.membership(userId, candidate))) return null;
      believe(userId, candidate);
      return candidate;
    } catch (error) {
      logFailure('initial() failed; the session starts without a context', error);
      return null;
    }
  }

  async function createBefore(session: Row): Promise<{ data: Row } | undefined> {
    const userId = session['userId'];
    if (typeof userId !== 'string') return undefined;
    // Never trust a value that arrived with the row: only `fallback` (which asked `membership`) decides.
    const contextId = await fallback(userId);
    return { data: { contextId } };
  }

  function install(context: object): void {
    const adapter = (context as { internalAdapter?: SessionAdapter }).internalAdapter;
    if (!adapter || (adapter as { __qnscContext?: true }).__qnscContext) return;
    (adapter as { __qnscContext?: true }).__qnscContext = true;
    const find = adapter.findSession.bind(adapter);
    adapter.findSession = async (token) => {
      const found = await find(token);
      if (!found) return found;
      const contextId = found.session.contextId;
      const userId = found.user.id;
      if (!isUuid(contextId) || typeof userId !== 'string') return found;
      // An expired session (or one the ban guard just killed by expiring it) is about to be deleted by Better Auth:
      // do not spend a `membership` call or a write on it.
      const expiresAt = found.session.expiresAt;
      if (expiresAt !== undefined && new Date(expiresAt as string | Date).getTime() <= Date.now()) {
        return found;
      }
      const until = believed.get(keyOf(userId, contextId));
      if (until !== undefined && until > Date.now()) return found;
      let member: boolean;
      try {
        member = await options.membership(userId, contextId);
      } catch (error) {
        logFailure('membership() failed on a session read; the context is kept', error);
        return found;
      }
      if (member) {
        believe(userId, contextId);
        return found;
      }
      // The user is no longer in the context the session holds: move it to the fallback (or none) and
      // carry on. The session itself stays valid: a context is not authentication.
      forget(userId, contextId);
      const replacement = await fallback(userId);
      const sessionToken = typeof found.session.token === 'string' ? found.session.token : token;
      try {
        await adapter.updateSession(sessionToken, { contextId: replacement });
      } catch (error) {
        logFailure('the stale context could not be replaced', error);
      }
      await emit({
        name: 'context.revoked',
        userId,
        detail: { reason: 'membership_lost', to: replacement ?? 'none' },
      });
      return { ...found, session: { ...found.session, contextId: replacement } };
    };
  }

  async function reconcile(
    storage: { delete(key: string): Promise<void> } | undefined,
    token: string,
    degradedBefore: number,
  ): Promise<void> {
    if (deps.degradedCount() === degradedBefore || !storage) return;
    const beforeDelete = deps.degradedCount();
    try {
      await storage.delete(token);
    } catch {
      /* counted below */
    }
    if (deps.degradedCount() !== beforeDelete) {
      // The store is still down: the cached copy of this session may come back with the previous context when it recovers.
      // Authentication is unaffected; the next switch, a clearContext, or the session's end fixes it.
      deps.logger.warn(
        'identity.context: the cached copy of a session could not be updated or dropped',
        {
          code: 'identity.context_cache_stale',
        },
      );
    }
  }

  const plugin: BetterAuthPlugin = {
    id: 'qnsc-context',
    endpoints: {
      setContext: createAuthEndpoint(
        CONTEXT_PATH,
        {
          method: 'POST',
          // The SAME validator as initial(): a `z.uuid()` here would accept a narrower set than isUuid and make the two paths disagree.
          body: z.object({
            contextId: z
              .string()
              .refine(isUuid, { message: 'contextId must be a UUID' })
              .nullable(),
          }),
          use: [sensitiveSessionMiddleware],
          requireHeaders: true,
        },
        async (ctx) => {
          const { session, user } = (
            ctx.context as unknown as {
              session: {
                session: Row & { token: string; contextId?: unknown };
                user: Row & { id: string };
              };
            }
          ).session;
          const next = ctx.body.contextId;
          const previous = isUuid(session.contextId) ? session.contextId : null;
          if (next !== null) {
            let member: boolean;
            try {
              member = await options.membership(user.id, next);
            } catch (error) {
              logFailure('membership() failed while setting a context', error);
              throw APIError.from('INTERNAL_SERVER_ERROR', {
                code: 'CONTEXT_CHECK_FAILED',
                message: 'The context could not be checked.',
              });
            }
            if (!member) {
              await emit({ name: 'context.refused', userId: user.id });
              throw APIError.from('FORBIDDEN', {
                code: 'CONTEXT_FORBIDDEN',
                message: 'You are not a member of this context.',
              });
            }
          }
          const degradedBefore = deps.degradedCount();
          const updated = (await ctx.context.internalAdapter.updateSession(session.token, {
            contextId: next,
          })) as Row | null;
          await reconcile(
            (ctx.context.options as { secondaryStorage?: { delete(key: string): Promise<void> } })
              .secondaryStorage,
            session.token,
            degradedBefore,
          );
          // Believed only AFTER the write: a membership that was true when asked but a write that failed (or lost a race with a
          // clearContext) must not leave a believed membership behind for a context the session does not hold.
          if (next === null) forget(user.id, previous ?? undefined);
          else if (updated) believe(user.id, next);
          // The cookie cache (public preset) carries the session; refresh it, as `organization.setActive` does.
          await setSessionCookie(ctx, {
            session: (updated ?? { ...session, contextId: next }) as never,
            user: user as never,
          });
          await emit({
            name: 'context.switched',
            userId: user.id,
            detail: { from: previous ?? 'none', to: next ?? 'none' },
          });
          return ctx.json({ contextId: next });
        },
      ),
    },
  };

  return {
    options: options as ContextRuntime['options'],
    believe,
    forget,
    fallback,
    createBefore,
    reconcile,
    degradedCount: deps.degradedCount,
    plugin,
    install,
  };
}

/** The `contextId` of a session returned by `getSession`, or `null`. */
export function contextIdOf(session: unknown): string | null {
  const value = (session as { session?: { contextId?: unknown } } | null | undefined)?.session
    ?.contextId;
  return isUuid(value) ? value : null;
}

type HookResult = { data?: Row } | false | void | undefined;
type CreateBefore = (session: Row, context: unknown) => Promise<HookResult> | HookResult;

/**
 * Run several `session.create.before` hooks in order. A hook that throws or returns `false` stops the
 * chain (a refused staff sign-in must not reach the context hook); `{ data }` results are merged, and each
 * later hook sees the data the earlier ones added.
 */
export function chainCreateBefore(...hooks: Array<CreateBefore | undefined>): CreateBefore {
  const list = hooks.filter((h): h is CreateBefore => h !== undefined);
  return async (session, context) => {
    let current = session;
    let merged: Row | undefined;
    for (const hook of list) {
      const result = await hook(current, context);
      if (result === false) return false;
      if (result && typeof result === 'object' && result.data) {
        merged = { ...merged, ...result.data };
        current = { ...current, ...result.data };
      }
    }
    return merged ? { data: merged } : undefined;
  };
}
