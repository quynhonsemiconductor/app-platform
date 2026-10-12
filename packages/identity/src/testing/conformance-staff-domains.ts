import { randomUUID } from 'node:crypto';
import {
  API,
  STAFF_DOMAIN,
  TEST_TENANT,
  OTHER_TENANT,
  startStack,
  strongPassword,
  type ConformanceInfra,
  type Stack,
} from './harness';
import { startMockIdp, type MockIdp } from './mock-idp';
import { microsoftSignIn, type TestApi } from './support';

/**
 * `staff.domains` matches exactly, and every refusal of a staff sign-in happens before anything is
 * written (opshub#355: `jane@sub.qnsc.vn` was admitted as a sub-domain of `qnsc.vn`, a bare user row was
 * created, and only then did the product's hook refuse it).
 */
export function staffDomainsConformance(t: TestApi, infra: ConformanceInfra): void {
  const { describe, it, expect } = t;

  describe('staff.domains: exact by default; a refused staff sign-in writes nothing', () => {
    let idp: MockIdp;
    t.beforeAll(async () => {
      idp = await startMockIdp();
    });
    t.afterAll(() => idp?.stop());

    const hookCalls: string[] = [];
    const open = (staff: Record<string, unknown> = {}) =>
      startStack(infra, {
        presets: ['public', 'staff'],
        staff: { authority: idp.base, ...staff },
        hooks: { onStaffSignIn: (user) => void hookCalls.push(user.email) },
      });

    /** Rows of every table a sign-in writes to, for the whole database: a refusal must change none. */
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

    const sub = `jane@sub.${STAFF_DOMAIN}`;
    const identity = (email: string, extra: Record<string, unknown> = {}) => ({
      sub: 'x',
      oid: randomUUID(),
      tid: TEST_TENANT,
      email,
      name: 'Jane',
      ...extra,
    });

    const refusals: Array<[string, ReturnType<typeof identity>]> = [
      ['a sub-domain of the staff domain', identity(sub)],
      ['a deeper sub-domain', identity(`jane@a.b.${STAFF_DOMAIN}`)],
      ['a look-alike suffix (mi<domain>)', identity(`jane@mi${STAFF_DOMAIN}`)],
      ['the staff domain as a prefix of another', identity(`jane@${STAFF_DOMAIN}.evil.example`)],
      ['two @ signs, the staff domain between them', identity(`jane@${STAFF_DOMAIN}@evil.example`)],
      ['an address off every staff domain', identity('jane@elsewhere.example')],
      ['another tenant', identity(`jane@${STAFF_DOMAIN}`, { tid: OTHER_TENANT })],
      ['a guest marked acct = 1', identity(`jane@${STAFF_DOMAIN}`, { claims: { acct: 1 } })],
      [
        'a guest marked #EXT# in the user principal name',
        identity(`jane@${STAFF_DOMAIN}`, {
          claims: { upn: `jane_${STAFF_DOMAIN}#EXT#@qnsc.onmicrosoft.com` },
        }),
      ],
      [
        'a guest from a foreign identity provider (idp is not the issuer)',
        identity(`jane@${STAFF_DOMAIN}`, { claims: { idp: 'https://sts.windows.net/foreign/' } }),
      ],
    ];

    for (const [name, who] of refusals) {
      it(`${name}: refused, and no user, account, session or verification row is written, the product hook not called`, async () => {
        const stack = await open();
        try {
          const before = await rows(stack);
          hookCalls.length = 0;

          const { client, callback } = await microsoftSignIn(stack, idp, who);

          expect(callback.location).toMatch(/error=unable_to_get_user_info/);
          expect((await client.get(`${API}/get-session`)).json()).toBeNull();
          expect(await rows(stack)).toEqual(before);
          expect(hookCalls).toEqual([]);
        } finally {
          await stack.stop();
        }
      });
    }

    it('the admitted case, for contrast: the staff domain itself signs in, with the user, the account and the session written', async () => {
      const stack = await open();
      try {
        const before = await rows(stack);
        const { client } = await microsoftSignIn(stack, idp, identity(`jane@${STAFF_DOMAIN}`));

        expect((await client.get(`${API}/get-session`)).json()).not.toBeNull();
        const after = await rows(stack);
        expect(after.user).toBe(before.user + 1);
        expect(after.account).toBe(before.account + 1);
        expect(after.session).toBe(before.session + 1);
      } finally {
        await stack.stop();
      }
    });

    it('the domain match is case-insensitive', async () => {
      const stack = await open();
      try {
        const { client } = await microsoftSignIn(
          stack,
          idp,
          identity(`Jane@${STAFF_DOMAIN.toUpperCase()}`),
        );
        expect((await client.get(`${API}/get-session`)).json()).not.toBeNull();
      } finally {
        await stack.stop();
      }
    });

    it('a "*." entry is the explicit opt-in to sub-domains, at any depth, and does not admit the bare domain', async () => {
      const wildcardOnly = await open({ domains: [`*.${STAFF_DOMAIN}`] });
      try {
        for (const email of [sub, `jane@a.b.${STAFF_DOMAIN}`]) {
          const { client } = await microsoftSignIn(wildcardOnly, idp, identity(email));
          expect((await client.get(`${API}/get-session`)).json(), email).not.toBeNull();
        }
        const before = await rows(wildcardOnly);
        for (const email of [
          `jane@${STAFF_DOMAIN}`,
          `jane@mi${STAFF_DOMAIN}`,
          `jane@${STAFF_DOMAIN}.evil.example`,
        ]) {
          const refused = await microsoftSignIn(wildcardOnly, idp, identity(email));
          expect(refused.callback.location, email).toMatch(/error=unable_to_get_user_info/);
        }
        expect(await rows(wildcardOnly)).toEqual(before);
      } finally {
        await wildcardOnly.stop();
      }

      const both = await open({ domains: [STAFF_DOMAIN, `*.${STAFF_DOMAIN}`] });
      try {
        for (const email of [`jane@${STAFF_DOMAIN}`, sub]) {
          const { client } = await microsoftSignIn(both, idp, identity(email));
          expect((await client.get(`${API}/get-session`)).json(), email).not.toBeNull();
        }
      } finally {
        await both.stop();
      }
    });

    it('a sub-domain stays RESERVED when it is not staff: password sign-up is refused there too, so it is not a way around', async () => {
      const stack = await open();
      try {
        for (const email of [`jane@${STAFF_DOMAIN}`, sub]) {
          const response = await stack.client().post(`${API}/sign-up/email`, {
            email,
            password: strongPassword(),
            name: 'x',
          });
          expect(response.status, email).toBe(403);
          expect(response.json(), email).toMatchObject({ code: 'USE_COMPANY_SIGN_IN' });
        }
      } finally {
        await stack.stop();
      }
    });

    it('an address with two @ signs is never accepted for password sign-up on the strength of what comes after the first one', async () => {
      const stack = await open();
      try {
        const before = await rows(stack);
        for (const email of [
          `jane@${STAFF_DOMAIN}@evil.example`,
          `jane@evil.example@${STAFF_DOMAIN}`,
        ]) {
          const response = await stack.client().post(`${API}/sign-up/email`, {
            email,
            password: strongPassword(),
            name: 'x',
          });
          expect(response.status, email).toBeGreaterThanOrEqual(400);
        }
        expect(await rows(stack)).toEqual(before);
      } finally {
        await stack.stop();
      }
    });

    it('a "*." entry reserves the bare domain and its sub-domains for the company sign-in too', async () => {
      const stack = await open({ domains: [`*.${STAFF_DOMAIN}`] });
      try {
        for (const email of [`jane@${STAFF_DOMAIN}`, sub, `jane@a.b.${STAFF_DOMAIN}`]) {
          const response = await stack.client().post(`${API}/sign-up/email`, {
            email,
            password: strongPassword(),
            name: 'x',
          });
          expect(response.status, email).toBe(403);
          expect(response.json(), email).toMatchObject({ code: 'USE_COMPANY_SIGN_IN' });
        }
      } finally {
        await stack.stop();
      }
    });

    it('staff.domains is checked at boot: a top-level wildcard, a bare "*", an address, a path or a non-string is a boot error naming the entry', async () => {
      for (const [entry, message] of [
        ['*.vn', /staff\.domains.*"\*\.vn".*top-level/],
        ['*.com.vn', /staff\.domains.*"\*\.com\.vn".*public suffix/],
        ['*.co.uk', /staff\.domains.*"\*\.co\.uk".*public suffix/],
        ['*', /staff\.domains.*"\*"/],
        ['jane@qnsc.vn', /staff\.domains.*"jane@qnsc\.vn"/],
        ['qnsc.vn/path', /staff\.domains.*"qnsc\.vn\/path"/],
        ['*qnsc.vn', /staff\.domains.*"\*qnsc\.vn"/],
        ['qnsc..vn', /staff\.domains/],
        [42, /staff\.domains.*string/],
      ] as const) {
        await expect(
          startStack(infra, {
            presets: ['public', 'staff'],
            staff: { authority: idp.base, domains: [entry as unknown as string] },
          }),
        ).rejects.toThrow(message);
      }
    });
  });
}
