import { createAuthMiddleware } from 'better-auth/api';
import type { BetterAuthPlugin } from 'better-auth';

/** How long "this user is not banned" is believed per process, and for how many users. */
const NOT_BANNED_TTL_MS = 30_000;
const MEMO_MAX = 10_000;

interface SessionAdapter {
  findSession(token: string): Promise<{
    session: Record<string, unknown> & { expiresAt: Date | string };
    user: Record<string, unknown> & { id?: unknown; banned?: unknown; banExpires?: unknown };
  } | null>;
  findUserById(id: string): Promise<{ banned?: unknown; banExpires?: unknown } | null>;
}

const isBannedRow = (user: { banned?: unknown; banExpires?: unknown }, now = Date.now()): boolean =>
  user.banned === true &&
  (user.banExpires == null || new Date(user.banExpires as string | Date).getTime() > now);

/**
 * A banned user's session is dead when it is READ, not only when it is created.
 *
 * Better Auth checks `banned` once, when a session is created. A sign-in already in flight when
 * `setUserBanned` runs (it passed the check, then the ban and the revoke happened, then its session row was
 * written) would mint a session nothing ever revokes. So every session Better Auth loads is checked:
 * the user it carries, and, for a user not known to be banned, a fresh read of the user row at most
 * every 30 s per process (a `PK` select, remembered per user). A banned user's session comes back
 * expired, which Better Auth answers by deleting it and answering `null`.
 *
 * The 30 s only bounds how long a session minted in that race can survive on a PROCESS that has just
 * believed its user not banned; everything created before the ban is gone by `setUserBanned` itself.
 * With the public preset's cookie cache, a session cookie is believed for its own window (5 min) before
 * this is consulted at all.
 */
export function bannedSessionGuard(): BetterAuthPlugin & {
  install(context: object): void;
  forget(userId: string): void;
  /** Is this user banned right now? The same memo and the same 30 s window as a session read (see {@link isUserBanned}). */
  isBanned(context: object, userId: string): Promise<boolean>;
} {
  const wrapped = new WeakSet<object>();
  const believedNotBanned = new Map<string, number>();
  const forget = (userId: string) => void believedNotBanned.delete(userId);

  function install(context: object): void {
    const adapter = (context as { internalAdapter?: SessionAdapter }).internalAdapter;
    if (!adapter || wrapped.has(adapter)) return;
    wrapped.add(adapter);
    const find = adapter.findSession.bind(adapter);
    adapter.findSession = async (token) => {
      const found = await find(token);
      if (!found) return found;
      const dead = () => ({
        ...found,
        session: { ...found.session, expiresAt: new Date(0) },
      });
      if (isBannedRow(found.user)) return dead();
      const id = found.user.id;
      if (typeof id !== 'string') return found;
      const until = believedNotBanned.get(id);
      if (until !== undefined && until > Date.now()) return found;
      const fresh = await adapter.findUserById(id);
      if (fresh && isBannedRow(fresh)) {
        believedNotBanned.delete(id);
        return dead();
      }
      if (believedNotBanned.size >= MEMO_MAX) {
        believedNotBanned.delete(believedNotBanned.keys().next().value as string);
      }
      believedNotBanned.set(id, Date.now() + NOT_BANNED_TTL_MS);
      return found;
    };
  }

  async function isBanned(context: object, userId: string): Promise<boolean> {
    const adapter = (context as { internalAdapter?: SessionAdapter }).internalAdapter;
    if (!adapter) throw new Error('identity: isUserBanned: no internal adapter');
    const until = believedNotBanned.get(userId);
    if (until !== undefined && until > Date.now()) return false;
    const fresh = await adapter.findUserById(userId);
    // An unknown user is not "banned", but is not a user either: the caller decides what that means.
    if (fresh && isBannedRow(fresh)) {
      believedNotBanned.delete(userId);
      return true;
    }
    if (believedNotBanned.size >= MEMO_MAX) {
      believedNotBanned.delete(believedNotBanned.keys().next().value as string);
    }
    believedNotBanned.set(userId, Date.now() + NOT_BANNED_TTL_MS);
    return false;
  }

  return {
    id: 'qnsc-banned-session-guard',
    install,
    forget,
    isBanned,
    hooks: {
      before: [
        {
          matcher: () => true,
          handler: createAuthMiddleware(async (ctx) => {
            install(ctx.context);
          }),
        },
      ],
    },
  };
}
