import { describe, expect, it } from 'vitest';
import {
  rememberStaffSignIn,
  withCallbackErrorCodes,
  type StaffSignInClaims,
} from './callback-errors';
import type { IdentityLogger } from './events';
import { staffSessionHooks } from './staff-session';

/** The guarantees around `onStaffSignIn` that no HTTP flow can reach: they are about what is missing. */
const claims: StaffSignInClaims = {
  oid: 'oid-1',
  tid: 'tid-1',
  email: 'a@staff.example.test',
  guest: false,
  roles: ['admin'],
};

const harness = (
  options: {
    hook?: (...args: never[]) => unknown;
    accounts?: Array<{ providerId: string; accountId: string }>;
  } = {},
) => {
  const logged: Array<{ message: string; fields?: Record<string, unknown> | undefined }> = [];
  const logger: IdentityLogger = {
    warn: () => undefined,
    error: (message, fields) => logged.push({ message, fields }),
  };
  const ia = {
    findUserById: async (id: string) => ({ id, email: claims.email }),
    findAccounts: async () => options.accounts ?? [{ providerId: 'microsoft', accountId: 'oid-1' }],
    deleteSessions: async () => undefined,
  };
  const context = (path: string, id?: string) => ({
    path,
    params: id ? { id } : {},
    context: { internalAdapter: ia },
  });
  const hooks = staffSessionHooks({
    staffDomains: ['staff.example.test'],
    getContext: async () => ({ internalAdapter: ia }) as never,
    logger,
    ...(options.hook ? { onStaffSignIn: options.hook as never } : {}),
  });
  const before = (ctx: ReturnType<typeof context>) =>
    (hooks.create.before as (s: object, c: unknown) => Promise<unknown>)({ userId: 'user-1' }, ctx);
  /** Run `before` as the OAuth callback would: inside the per-request slot, with the claims recorded. */
  const withRecorded = (ctx: ReturnType<typeof context>) =>
    withCallbackErrorCodes(async () => {
      rememberStaffSignIn(claims);
      await before(ctx);
      return new Response('ok');
    })(new Request('https://auth.example.test/api/auth/callback/microsoft'));
  return { logged, context, before, withRecorded };
};

const refused = async (promise: Promise<unknown>) => {
  const error = (await promise.then(
    () => undefined,
    (e: unknown) => e,
  )) as { body?: { code?: string } } | undefined;
  expect(error?.body?.code).toBe('STAFF_SIGN_IN_REFUSED');
};

describe('onStaffSignIn fails closed', () => {
  it('a Microsoft callback session with NO claims recorded is refused, and the hook is not run', async () => {
    let called = 0;
    const h = harness({ hook: () => void (called += 1) });
    await refused(h.before(h.context('/callback/:id', 'microsoft')));
    expect(called).toBe(0);
    expect(h.logged).toHaveLength(1);
    expect(h.logged[0]!.fields).toMatchObject({ code: 'identity.staff_sign_in_refused' });
  });

  it('only a Microsoft callback needs claims: a password sign-in or another provider is not refused', async () => {
    const h = harness({ hook: () => undefined });
    await h.before(h.context('/sign-in/email'));
    await h.before(h.context('/callback/:id', 'google'));
    expect(h.logged).toHaveLength(0);
  });

  it('with no hook configured nothing is required (there is nothing to bypass)', async () => {
    const h = harness();
    await h.before(h.context('/callback/:id', 'microsoft'));
    expect(h.logged).toHaveLength(0);
  });

  it('claims whose oid the session’s user does not hold are refused, and the hook is not run for them', async () => {
    let called = 0;
    const h = harness({
      hook: () => void (called += 1),
      accounts: [{ providerId: 'microsoft', accountId: 'someone-else' }],
    });
    await refused(h.withRecorded(h.context('/callback/:id', 'microsoft')));
    expect(called).toBe(0);
  });

  it('a hook that throws refuses the sign-in; only the class is logged, never the message', async () => {
    const h = harness({
      hook: () => {
        throw Object.assign(
          new TypeError('relation "roles" does not exist for a@staff.example.test'),
          {
            code: '42P01',
          },
        );
      },
    });
    await refused(h.withRecorded(h.context('/callback/:id', 'microsoft')));
    expect(h.logged).toHaveLength(1);
    expect(h.logged[0]!.fields).toMatchObject({
      code: 'identity.staff_sign_in_refused',
      error: 'TypeError',
      errorCode: '42P01',
    });
    expect(JSON.stringify(h.logged)).not.toMatch(/relation|roles|a@staff/);
  });

  it('a hook that succeeds lets the session through, and the claims are consumed once', async () => {
    const seen: StaffSignInClaims[] = [];
    const h = harness({ hook: (_user: never, c: StaffSignInClaims) => void seen.push(c) });
    await h.withRecorded(h.context('/callback/:id', 'microsoft'));
    expect(seen).toEqual([claims]);
  });
});
