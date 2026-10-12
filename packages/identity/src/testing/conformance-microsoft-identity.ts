import { randomUUID } from 'node:crypto';
import { SessionStoreUnavailableError, unlinkMicrosoftAccount } from '../create-identity';
import { verifiedUser } from './flows';
import {
  API,
  STAFF_DOMAIN,
  TEST_TENANT,
  startStack,
  strongPassword,
  uniqueEmail,
  type ConformanceInfra,
  type Stack,
} from './harness';
import { startMockIdp, type MockIdp } from './mock-idp';
import { microsoftSignIn, type TestApi } from './support';

/**
 * One Entra identity per user (opshub#355, issue #228). The `email` claim is an attribute: a recycled
 * mailbox, or anyone who can edit `mail`, gives a DIFFERENT Entra object (another `oid`) the address of an
 * existing user, and Better Auth links by address. A Microsoft sign-in must not be signed in as a user that
 * already holds another Microsoft identity; relinking is an explicit administrator operation.
 */
export function microsoftIdentityConformance(t: TestApi, infra: ConformanceInfra): void {
  const { describe, it, expect } = t;

  describe('a Microsoft identity never links to a user that holds another one; the UPN is on a staff domain', () => {
    let idp: MockIdp;
    t.beforeAll(async () => {
      idp = await startMockIdp();
    });
    t.afterAll(() => idp?.stop());

    const open = (staff: Record<string, unknown> = {}) =>
      startStack(infra, { presets: ['public', 'staff'], staff: { authority: idp.base, ...staff } });

    const identity = (email: string, extra: Record<string, unknown> = {}) => ({
      sub: 'x',
      oid: randomUUID(),
      tid: TEST_TENANT,
      email,
      name: 'Jane',
      ...extra,
    });
    const rows = async (stack: Stack) => {
      const count = async (table: string) =>
        Number(
          (await stack.pool.query(`select count(*)::int as n from identity."${table}"`)).rows[0].n,
        );
      return {
        user: await count('user'),
        account: await count('account'),
        session: await count('session'),
        verification: await count('verification'),
      };
    };
    const me = async (client: ReturnType<Stack['client']>) =>
      (await client.get(`${API}/get-session`)).json<{ user: { id: string } } | null>();
    const microsoftAccounts = async (stack: Stack, userId: string) =>
      (
        await stack.pool.query<{ account_id: string }>(
          `select account_id from identity.account where user_id = $1 and provider_id = 'microsoft' order by created_at`,
          [userId],
        )
      ).rows.map((r) => r.account_id);

    describe('two oids, one email', () => {
      it('the second identity is refused with MICROSOFT_IDENTITY_CHANGED, audited, and nothing is written: no second account, no session', async () => {
        const stack = await open();
        try {
          const email = `jane@${STAFF_DOMAIN}`;
          const [oid1, oid2] = [randomUUID(), randomUUID()];
          const first = await microsoftSignIn(stack, idp, identity(email, { oid: oid1 }));
          const owner = (await me(first.client))!.user.id;
          const before = await rows(stack);
          stack.events.length = 0;

          const second = await microsoftSignIn(
            stack,
            idp,
            identity(email, { oid: oid2, name: 'Mallory' }),
          );

          expect(second.callback.location ?? '').toContain('error=MICROSOFT_IDENTITY_CHANGED');
          expect(await me(second.client)).toBeNull();
          expect(await rows(stack)).toEqual(before);
          expect(await microsoftAccounts(stack, owner)).toEqual([oid1]);
          const audit = stack.events.filter((e) => e.name === 'account.microsoft_link_refused');
          expect(audit).toHaveLength(1);
          expect(audit[0]).toMatchObject({ userId: owner, detail: { reason: 'different_oid' } });
          // ids only: neither address nor either oid is in the event
          expect(JSON.stringify(audit)).not.toContain(email);
          expect(JSON.stringify(audit)).not.toContain(oid1);
          expect(JSON.stringify(audit)).not.toContain(oid2);
          // the owner is unaffected
          expect((await me(first.client))!.user.id).toBe(owner);
        } finally {
          await stack.stop();
        }
      });

      it('a KNOWN oid is never refused because its address now matches someone else: the recycled-mailbox case', async () => {
        const stack = await open();
        try {
          const emailA = `ada-${randomUUID().slice(0, 6)}@${STAFF_DOMAIN}`;
          const emailB = `bob-${randomUUID().slice(0, 6)}@${STAFF_DOMAIN}`;
          const [oidA, oidB, oidC] = [randomUUID(), randomUUID(), randomUUID()];
          const a = await microsoftSignIn(stack, idp, identity(emailA, { oid: oidA }));
          const userA = (await me(a.client))!.user.id;
          const b = await microsoftSignIn(stack, idp, identity(emailB, { oid: oidB }));
          const userB = (await me(b.client))!.user.id;
          expect(userB).not.toBe(userA);
          stack.events.length = 0;
          const before = await rows(stack);

          // Bob's mailbox moved: his token now carries Ada's old-address attribute. He is still Bob.
          const again = await microsoftSignIn(stack, idp, identity(emailA, { oid: oidB }));
          expect(again.callback.location ?? '').not.toContain('error=');
          expect((await me(again.client))!.user.id).toBe(userB);
          expect(stack.events.some((e) => e.name === 'account.microsoft_link_refused')).toBe(false);
          expect((await rows(stack)).user).toBe(before.user);
          expect(await microsoftAccounts(stack, userA)).toEqual([oidA]);
          expect(await microsoftAccounts(stack, userB)).toEqual([oidB]);

          // A stranger with that address is still refused: Ada's user is not theirs.
          const stranger = await microsoftSignIn(stack, idp, identity(emailA, { oid: oidC }));
          expect(stranger.callback.location ?? '').toContain('error=MICROSOFT_IDENTITY_CHANGED');
          expect(await microsoftAccounts(stack, userA)).toEqual([oidA]);
        } finally {
          await stack.stop();
        }
      });

      it('the same identity keeps signing in, whatever the case of the address', async () => {
        const stack = await open();
        try {
          const email = `jane@${STAFF_DOMAIN}`;
          const oid = randomUUID();
          const first = await microsoftSignIn(stack, idp, identity(email, { oid }));
          const owner = (await me(first.client))!.user.id;
          const again = await microsoftSignIn(
            stack,
            idp,
            identity(`Jane@${STAFF_DOMAIN.toUpperCase()}`, { oid }),
          );
          expect((await me(again.client))!.user.id).toBe(owner);
          expect(await microsoftAccounts(stack, owner)).toEqual([oid]);
          expect(stack.events.some((e) => e.name === 'account.microsoft_link_refused')).toBe(false);
        } finally {
          await stack.stop();
        }
      });

      it('a brand-new identity with a brand-new address is unaffected', async () => {
        const stack = await open();
        try {
          const { client } = await microsoftSignIn(stack, idp, identity(`new@${STAFF_DOMAIN}`));
          expect(await me(client)).not.toBeNull();
        } finally {
          await stack.stop();
        }
      });
    });

    describe('unlinkMicrosoftAccount: the explicit relink', () => {
      it('removes the Microsoft account, ends the sessions, audits it; then the NEW identity signs in as the SAME user and the old one is refused', async () => {
        const stack = await open();
        try {
          const email = `jane@${STAFF_DOMAIN}`;
          const [oid1, oid2] = [randomUUID(), randomUUID()];
          const first = await microsoftSignIn(stack, idp, identity(email, { oid: oid1 }));
          const owner = (await me(first.client))!.user.id;
          stack.events.length = 0;

          expect(await unlinkMicrosoftAccount(stack.auth, owner)).toBe(1);
          expect(await microsoftAccounts(stack, owner)).toEqual([]);
          expect(await me(first.client)).toBeNull(); // the old identity's session is gone
          const unlinked = stack.events.filter((e) => e.name === 'account.microsoft_unlinked');
          expect(unlinked).toHaveLength(1);
          expect(unlinked[0]).toMatchObject({ userId: owner, detail: { count: 1 } });
          expect(
            stack.events.some((e) => e.name === 'sessions.revoked' && e.userId === owner),
          ).toBe(true);

          // the same person under a new object: signs in as the same user (roles and history intact)
          const relinked = await microsoftSignIn(stack, idp, identity(email, { oid: oid2 }));
          expect((await me(relinked.client))!.user.id).toBe(owner);
          expect(await microsoftAccounts(stack, owner)).toEqual([oid2]);

          // and the old object can no longer come back as them
          const old = await microsoftSignIn(stack, idp, identity(email, { oid: oid1 }));
          expect(old.callback.location ?? '').toContain('error=MICROSOFT_IDENTITY_CHANGED');
          expect(await me(old.client)).toBeNull();
        } finally {
          await stack.stop();
        }
      });

      it('revokes the sessions FIRST: a cache failure changes nothing, and the retry finishes the job', async () => {
        const stack = await open();
        try {
          const email = `jane@${STAFF_DOMAIN}`;
          const oid = randomUUID();
          const first = await microsoftSignIn(stack, idp, identity(email, { oid }));
          const owner = (await me(first.client))!.user.id;
          stack.events.length = 0;

          const original = stack.cache.del.bind(stack.cache);
          stack.cache.del = (async () => {
            throw new Error('cache write failed');
          }) as typeof stack.cache.del;
          try {
            await expect(unlinkMicrosoftAccount(stack.auth, owner)).rejects.toBeInstanceOf(
              SessionStoreUnavailableError,
            );
          } finally {
            stack.cache.del = original;
          }
          // nothing changed: the account is still there, so the retry has something to do
          expect(await microsoftAccounts(stack, owner)).toEqual([oid]);
          expect(stack.events.some((e) => e.name === 'account.microsoft_unlinked')).toBe(false);

          expect(await unlinkMicrosoftAccount(stack.auth, owner)).toBe(1);
          expect(await microsoftAccounts(stack, owner)).toEqual([]);
          expect(await me(first.client)).toBeNull(); // and the old identity's session is dead
        } finally {
          await stack.stop();
        }
      });

      it('records who asked: actorId on the event; a bad actorId is a TypeError before anything changes', async () => {
        const stack = await open();
        try {
          const { client } = await microsoftSignIn(stack, idp, identity(`jane@${STAFF_DOMAIN}`));
          const owner = (await me(client))!.user.id;
          stack.events.length = 0;
          for (const bad of ['', 'x'.repeat(129), 'a\nb', 7 as unknown as string]) {
            await expect(
              unlinkMicrosoftAccount(stack.auth, owner, { actorId: bad }),
            ).rejects.toBeInstanceOf(TypeError);
          }
          expect(await microsoftAccounts(stack, owner)).toHaveLength(1);
          expect(await unlinkMicrosoftAccount(stack.auth, owner, { actorId: 'admin-42' })).toBe(1);
          const event = stack.events.find((e) => e.name === 'account.microsoft_unlinked');
          expect(event?.detail).toEqual({ count: 1, actorId: 'admin-42' });
        } finally {
          await stack.stop();
        }
      });

      it('is idempotent and harmless for what it does not own: an unknown user and a user without a Microsoft account return 0 and emit nothing; a password account is not touched', async () => {
        const stack = await open();
        try {
          const email = uniqueEmail('password-only');
          await verifiedUser(stack, email, strongPassword(), expect);
          const user = (
            await stack.pool.query<{ id: string }>(
              `select id from identity."user" where email = $1`,
              [email],
            )
          ).rows[0]!.id;
          const before = await rows(stack);
          stack.events.length = 0;

          expect(await unlinkMicrosoftAccount(stack.auth, user)).toBe(0);
          expect(await unlinkMicrosoftAccount(stack.auth, randomUUID())).toBe(0);
          expect(await rows(stack)).toEqual(before);
          expect(stack.events.filter((e) => e.name.startsWith('account.microsoft'))).toEqual([]);

          const jane = await microsoftSignIn(stack, idp, identity(`jane@${STAFF_DOMAIN}`));
          const owner = (await me(jane.client))!.user.id;
          expect(await unlinkMicrosoftAccount(stack.auth, owner)).toBe(1);
          expect(await unlinkMicrosoftAccount(stack.auth, owner)).toBe(0); // again: nothing left
        } finally {
          await stack.stop();
        }
      });

      it('refuses a userId that is not a UUID, and refuses while the cache is unavailable, changing nothing', async () => {
        const stack = await startStack(infra, {
          presets: ['public', 'staff'],
          staff: { authority: idp.base },
          appValkeyUrl: 'redis://127.0.0.1:1',
        });
        try {
          await expect(unlinkMicrosoftAccount(stack.auth, 'not-a-uuid')).rejects.toBeInstanceOf(
            TypeError,
          );
          await expect(unlinkMicrosoftAccount(stack.auth, randomUUID())).rejects.toBeInstanceOf(
            SessionStoreUnavailableError,
          );
        } finally {
          await stack.stop();
        }
      });
    });

    describe('the user principal name must be on a staff domain (requireUpnOnStaffDomain, default on)', () => {
      const refusals: Array<[string, Record<string, unknown>]> = [
        [
          'a UPN on the tenant’s onmicrosoft.com domain',
          { claims: { upn: 'jane@qnsc.onmicrosoft.com' } },
        ],
        [
          'a preferred_username on another domain when there is no upn claim',
          { claims: { preferred_username: 'jane@elsewhere.example' } },
        ],
        [
          'a UPN that is a sub-domain of a staff domain',
          { claims: { upn: `jane@sub.${STAFF_DOMAIN}` } },
        ],
        ['no UPN claim at all', { claims: { preferred_username: undefined } }],
        ['a UPN with no @', { claims: { upn: 'jane', preferred_username: undefined } }],
      ];
      for (const [name, extra] of refusals) {
        it(`${name}: refused, zero rows`, async () => {
          const stack = await open();
          try {
            const before = await rows(stack);
            const { client, callback } = await microsoftSignIn(
              stack,
              idp,
              identity(`jane@${STAFF_DOMAIN}`, extra),
            );
            expect(callback.location ?? '').toMatch(/error=UPN_NOT_ON_STAFF_DOMAIN/);
            expect(await me(client)).toBeNull();
            expect(await rows(stack)).toEqual(before);
          } finally {
            await stack.stop();
          }
        });
      }

      it('the refusal NAMES the UPN suffix for the admin, in an event and a log line, and never the person', async () => {
        const stack = await open();
        try {
          const local = `mallory-${randomUUID().slice(0, 6)}`;
          await microsoftSignIn(
            stack,
            idp,
            identity(`jane@${STAFF_DOMAIN}`, {
              claims: { upn: `${local}@qnsc.onmicrosoft.com` },
            }),
          );
          const refused = stack.events.filter((e) => e.name === 'staff.upn_refused');
          expect(refused).toHaveLength(1);
          expect(refused[0]!.detail).toEqual({
            reason: 'suffix_not_staff',
            suffix: 'qnsc.onmicrosoft.com',
          });
          const line = stack.logs.find(
            (l) => l.fields?.['code'] === 'identity.upn_not_on_staff_domain',
          );
          expect(line?.message).toContain('"qnsc.onmicrosoft.com"');
          expect(line?.message).toContain('requireUpnOnStaffDomain: false');
          expect(JSON.stringify([refused, stack.logs])).not.toContain(local);

          await microsoftSignIn(
            stack,
            idp,
            identity(`jane2@${STAFF_DOMAIN}`, { claims: { preferred_username: undefined } }),
          );
          expect(
            stack.events
              .filter((e) => e.name === 'staff.upn_refused')
              .map((e) => e.detail?.['reason']),
          ).toEqual(['suffix_not_staff', 'absent']);
        } finally {
          await stack.stop();
        }
      });

      it('a UPN on the staff domain (any case, upn or preferred_username) is admitted', async () => {
        const stack = await open();
        try {
          for (const extra of [
            { claims: { upn: `Jane@${STAFF_DOMAIN.toUpperCase()}` } },
            { claims: { preferred_username: `jane2@${STAFF_DOMAIN}` } },
          ]) {
            const { client } = await microsoftSignIn(
              stack,
              idp,
              identity(`${randomUUID().slice(0, 6)}@${STAFF_DOMAIN}`, extra),
            );
            expect(await me(client)).not.toBeNull();
          }
        } finally {
          await stack.stop();
        }
      });

      it('matches a "*." staff entry', async () => {
        const stack = await open({ domains: [`*.${STAFF_DOMAIN}`] });
        try {
          const email = `jane@sub.${STAFF_DOMAIN}`;
          const { client } = await microsoftSignIn(stack, idp, identity(email));
          expect(await me(client)).not.toBeNull();
        } finally {
          await stack.stop();
        }
      });

      it('requireUpnOnStaffDomain: false lets a member whose UPN is elsewhere in (the email check still applies)', async () => {
        const stack = await open({ requireUpnOnStaffDomain: false });
        try {
          const { client } = await microsoftSignIn(
            stack,
            idp,
            identity(`jane@${STAFF_DOMAIN}`, { claims: { upn: 'jane@qnsc.onmicrosoft.com' } }),
          );
          expect(await me(client)).not.toBeNull();
          const refused = await microsoftSignIn(
            stack,
            idp,
            identity('jane@elsewhere.example', { claims: { upn: 'jane@qnsc.onmicrosoft.com' } }),
          );
          expect(refused.callback.location ?? '').toMatch(/error=unable_to_get_user_info/);
        } finally {
          await stack.stop();
        }
      });

      it('a guest is exempt: the UPN of a guest is name_domain#EXT#@tenant', async () => {
        const stack = await open({ allowGuests: true });
        try {
          const { client } = await microsoftSignIn(
            stack,
            idp,
            identity('vendor@vendor.example', {
              claims: { acct: 1, upn: 'vendor_vendor.example#EXT#@qnsc.onmicrosoft.com' },
            }),
          );
          expect(await me(client)).not.toBeNull();
        } finally {
          await stack.stop();
        }
      });
    });
  });
}
