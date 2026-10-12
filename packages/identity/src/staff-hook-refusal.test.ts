import { describe, expect, it } from 'vitest';
import {
  rememberCreatedUser,
  rememberStaffSignIn,
  withCallbackErrorCodes,
} from './callback-errors';
import type { IdentityLogger } from './events';
import { staffSessionHooks } from './staff-session';

/**
 * A refusal at the session (the product's `onStaffSignIn` threw) removes the user THIS request created,
 * and only when it holds nothing but this Microsoft account and no session. The rows themselves are
 * asserted against PostgreSQL by the conformance kit; here every condition of the decision is pinned with
 * a fake adapter.
 */
const OID = '11111111-1111-4111-8111-111111111111';
const claims = {
  oid: OID,
  tid: 'tenant',
  email: 'jane@staff.example.test',
  guest: false,
  roles: [],
};

type Account = { providerId: string; accountId?: string };

function setup(options: {
  accounts?: Account[];
  sessions?: unknown[];
  hook?: () => Promise<void> | void;
  deleteUser?: () => Promise<void>;
}) {
  const deleted: string[] = [];
  const logs: Array<{ message: string; fields?: Record<string, unknown> | undefined }> = [];
  const logger: IdentityLogger = {
    warn: (message, fields) => void logs.push({ message, fields }),
    error: (message, fields) => void logs.push({ message, fields }),
  };
  const internalAdapter = {
    findUserById: async (id: string) => ({ id, email: claims.email }),
    findAccounts: async () => options.accounts ?? [{ providerId: 'microsoft', accountId: OID }],
    listSessions: async () => options.sessions ?? [],
    deleteSessions: async () => undefined,
    deleteUser: async (id: string) => {
      if (options.deleteUser) await options.deleteUser();
      deleted.push(id);
    },
  };
  const hooks = staffSessionHooks({
    staffDomains: ['staff.example.test'],
    getContext: async () => ({ internalAdapter }) as never,
    onStaffSignIn: options.hook ?? (() => undefined),
    logger,
  });
  /** One identity request: what `user.create.after` and the provider record, then the session hook. */
  const request = async (opts: { created: boolean; recordClaims?: boolean }) => {
    const handler = withCallbackErrorCodes(async () => {
      if (opts.created) rememberCreatedUser('u1');
      if (opts.recordClaims !== false) rememberStaffSignIn(claims);
      try {
        await hooks.create.before({ userId: 'u1' }, {
          path: '/callback/:id',
          params: { id: 'microsoft' },
          context: { internalAdapter },
        } as never);
        return new Response(null, { status: 200 });
      } catch (error) {
        return new Response(String((error as { body?: { code?: string } }).body?.code), {
          status: 403,
        });
      }
    });
    return handler(new Request('https://api.example.test/api/auth/callback/microsoft'));
  };
  return { request, deleted, logs };
}

const refuses = () => {
  throw new Error('role sync failed: the person is not provisioned');
};

describe('a refused staff sign-in removes the user this request created', () => {
  it('hook throws, user created now, only this Microsoft account, no session ⇒ deleted, and the sign-in is refused', async () => {
    const t = setup({ hook: refuses });
    const response = await t.request({ created: true });
    expect(response.status).toBe(403);
    expect(await response.text()).toBe('STAFF_SIGN_IN_REFUSED');
    expect(t.deleted).toEqual(['u1']);
  });

  it('the hook does not throw ⇒ nothing is deleted', async () => {
    const t = setup({});
    expect((await t.request({ created: true })).status).toBe(200);
    expect(t.deleted).toEqual([]);
  });

  it('the user was already there (not created by this request) ⇒ never deleted', async () => {
    const t = setup({ hook: refuses });
    expect((await t.request({ created: false })).status).toBe(403);
    expect(t.deleted).toEqual([]);
  });

  it('created now, but it holds another account (a credential, a second provider) ⇒ not deleted', async () => {
    for (const extra of [
      [{ providerId: 'credential' }],
      [{ providerId: 'google', accountId: 'g' }],
      [{ providerId: 'microsoft', accountId: 'another-oid' }],
    ]) {
      const t = setup({
        hook: refuses,
        accounts: [{ providerId: 'microsoft', accountId: OID }, ...extra],
      });
      await t.request({ created: true });
      expect(t.deleted, JSON.stringify(extra)).toEqual([]);
    }
  });

  it('created now, but its only Microsoft account is not the one in the token ⇒ not deleted', async () => {
    const t = setup({
      hook: refuses,
      accounts: [{ providerId: 'microsoft', accountId: 'someone-else' }],
    });
    await t.request({ created: true });
    expect(t.deleted).toEqual([]);
  });

  it('created now, but it already has a session (a concurrent sign-in) ⇒ not deleted', async () => {
    const t = setup({ hook: refuses, sessions: [{ id: 's1' }] });
    await t.request({ created: true });
    expect(t.deleted).toEqual([]);
  });

  it('no account at all ⇒ not deleted', async () => {
    const t = setup({ hook: refuses, accounts: [] });
    await t.request({ created: true });
    expect(t.deleted).toEqual([]);
  });

  it('a failure to delete is logged (class and code, never the message) and the sign-in is still refused', async () => {
    const t = setup({
      hook: refuses,
      deleteUser: async () => {
        throw new Error('secret connection string in this message');
      },
    });
    const response = await t.request({ created: true });
    expect(response.status).toBe(403);
    expect(await response.text()).toBe('STAFF_SIGN_IN_REFUSED');
    const text = JSON.stringify(t.logs);
    expect(text).toMatch(/could not be removed/);
    expect(text).not.toContain('secret connection string');
  });

  it('the hook’s own message is on neither the response nor the logs', async () => {
    const t = setup({ hook: refuses });
    const response = await t.request({ created: true });
    expect(await response.text()).not.toContain('role sync');
    expect(JSON.stringify(t.logs)).not.toContain('role sync');
  });

  it('a Microsoft session with no claims recorded is refused, and the user it created is removed too', async () => {
    const t = setup({});
    const response = await t.request({ created: true, recordClaims: false });
    expect(response.status).toBe(403);
    expect(t.deleted).toEqual(['u1']);
  });

  it('a user remembered as created in ANOTHER request is not "created by this request": never deleted', async () => {
    const t = setup({ hook: refuses });
    await withCallbackErrorCodes(async () => {
      rememberCreatedUser('u1'); // an earlier request, its own store
      return new Response(null);
    })(new Request('https://api.example.test/'));
    await t.request({ created: false });
    expect(t.deleted).toEqual([]);
  });
});
