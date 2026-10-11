import { randomUUID } from 'node:crypto';
import { DEFAULTS } from '../defaults';
import { signDeviceValue } from '../known-device';
import { lockoutKeys } from '../lockout';
import { signIn } from './flows';
import {
  API,
  startStack,
  strongPassword,
  STAFF_DOMAIN,
  TEST_TENANT,
  uniqueEmail,
  type ConformanceInfra,
  type Stack,
} from './harness';
import { startMockIdp, type MockIdp } from './mock-idp';
import { microsoftSignIn, type TestApi } from './support';

/**
 * Cookie names and the rate limit of the two redirect endpoints (README, "Session cookies" and
 * "Client IP and rate limits").
 *
 * The cookie suite runs TWICE, once per mode: `__Secure-<product>.*` (the default) and
 * `__Host-<product>.*` (`hostCookies: true`). A mode that the kit did not exercise would be a mode
 * that silently broke on the next Better Auth bump.
 */
const FRESH = `${API}/get-session?disableCookieCache=true`;

const MODES = [
  { label: '__Secure- (the default)', hostCookies: false, prefix: '__Secure-conformance' },
  { label: '__Host- (hostCookies)', hostCookies: true, prefix: '__Host-conformance' },
] as const;

export function cookiesConformance(t: TestApi, infra: ConformanceInfra): void {
  const { describe, it, beforeAll, afterAll, expect } = t;

  for (const mode of MODES) {
    const other = MODES.find((m) => m !== mode)!;

    describe(`cookies, ${mode.label}`, () => {
      let stack: Stack;
      beforeAll(async () => {
        stack = await startStack(infra, mode.hostCookies ? { hostCookies: true } : {});
      });
      afterAll(() => stack?.stop());

      const newUser = async () => {
        const email = uniqueEmail('cookie');
        const password = strongPassword();
        const c = stack.client();
        await c.post(`${API}/sign-up/email`, { email, password, name: 'x' });
        await c.get(await stack.link(email));
        const res = await signIn(c, email, password);
        expect(res.status, res.body).toBe(200);
        return { email, password, c, res };
      };

      it('Better Auth is configured for the mode', () => {
        const advanced = stack.auth.options.advanced;
        expect(advanced?.useSecureCookies).toBe(!mode.hostCookies);
        expect(advanced?.cookiePrefix).toBe(
          mode.hostCookies ? '__Host-conformance' : 'conformance',
        );
      });

      it('the session and known-device cookies carry the mode prefix and HttpOnly, Secure, SameSite=Lax, Path=/, no Domain', async () => {
        const { res } = await newUser();
        for (const cookie of ['session_token', 'known_device']) {
          const line = res.setCookie.find((l) => new RegExp(`${cookie}=`).test(l))!;
          expect(line, `${cookie} was set`).toBeDefined();
          expect(line.split('=')[0]).toBe(`${mode.prefix}.${cookie}`);
          for (const attribute of [
            /;\s*HttpOnly/i,
            /;\s*Secure/i,
            /;\s*SameSite=Lax/i, // never Strict: it would drop the cookie on the provider's redirect back
            /;\s*Path=\//i,
          ]) {
            expect(attribute.test(line), `${cookie}: ${String(attribute)}`).toBe(true);
          }
          expect(/;\s*Domain=/i.test(line), `${cookie} has no Domain`).toBe(false);
        }
      });

      it('every cookie a sign-in sets has the mode prefix, and none has the other one', async () => {
        const { res } = await newUser();
        const names = res.setCookie.map((l) => l.split('=')[0]!);
        expect(names.length).toBeGreaterThan(0);
        for (const name of names) {
          expect(name.startsWith(`${mode.prefix}.`), name).toBe(true);
          expect(name.startsWith(other.prefix), name).toBe(false);
        }
        // Host-only means exactly that: nothing in this mode may ask for a Domain.
        expect(res.setCookie.some((l) => /;\s*Domain=/i.test(l))).toBe(false);
      });

      it('the session cookie authenticates; the same value under another name is no session (cookie tossing)', async () => {
        const { c, email } = await newUser();
        const [name, value] = Object.entries(c.cookies).find(([n]) =>
          n.endsWith('.session_token'),
        )!;
        expect(name).toBe(`${mode.prefix}.session_token`);

        const own = stack.client();
        own.setCookies({ [name]: value });
        expect(own.cookies).toHaveProperty(name);
        expect((await own.get(FRESH)).json<{ user: { email: string } }>().user.email).toBe(email);

        // What a sibling app on the parent domain could plant: the same token under the OTHER
        // mode's name, and under no prefix at all. The server only reads its own name.
        for (const foreign of [`${other.prefix}.session_token`, 'conformance.session_token']) {
          const tossed = stack.client();
          tossed.setCookies({ [foreign]: value });
          expect((await tossed.get(FRESH)).body, foreign).toBe('null');
        }
      });

      it('sign-out expires the session cookie under the same name', async () => {
        const { c } = await newUser();
        const out = await c.post(`${API}/sign-out`);
        const line = out.setCookie.find((l) => /session_token=/.test(l))!;
        expect(line).toBeDefined();
        expect(line.split('=')[0]).toBe(`${mode.prefix}.session_token`);
        expect(/Max-Age=0/i.test(line)).toBe(true);
      });

      describe('the known-device HMAC covers the cookie name', () => {
        const generation = async (subject: string) =>
          Number(await stack.get(lockoutKeys.gen(subject))) || 0;
        const floodCeiling = async (email: string) =>
          stack.seedCounter(
            lockoutKeys.account('signin', await generation(email), email),
            DEFAULTS.lockout.perAccount.ceiling,
            3600,
          );
        /** With the ceiling spent the RIGHT password is refused (429), unless the cookie is honoured. */
        const bypasses = async (
          email: string,
          password: string,
          cookie: { name: string; value: string },
        ) => {
          await floodCeiling(email);
          const browser = stack.client({
            ip: `198.51.100.${100 + Math.floor(Math.random() * 100)}`,
          });
          browser.setCookies({ [cookie.name]: cookie.value });
          return (await signIn(browser, email, password)).status === 200;
        };

        it('is honoured under its own name, and under no other', async () => {
          const { email, password, c } = await newUser();
          const [name, value] = Object.entries(c.cookies).find(([n]) =>
            n.endsWith('.known_device'),
          )!;
          expect(name).toBe(`${mode.prefix}.known_device`);

          expect(await bypasses(email, password, { name, value })).toBe(true);
          // The genuine value, carried under the other mode's name: no cookie of ours at all.
          expect(
            await bypasses(email, password, { name: `${other.prefix}.known_device`, value }),
          ).toBe(false);
        });

        it('a value signed for another cookie name is no cookie, even with a valid payload', async () => {
          const { email, password, c } = await newUser();
          const [name, value] = Object.entries(c.cookies).find(([n]) =>
            n.endsWith('.known_device'),
          )!;
          const secret = stack.env[DEFAULTS.secretEnv]!;
          const payload = value.slice(0, value.lastIndexOf('.'));

          for (const wrongName of [`${other.prefix}.known_device`, `${mode.prefix}.session_data`]) {
            const forged = signDeviceValue(secret, wrongName, payload);
            expect(await bypasses(email, password, { name, value: forged }), wrongName).toBe(false);
          }
          // ...and signing it for the right name is exactly what makes it valid again.
          expect(
            await bypasses(email, password, {
              name,
              value: signDeviceValue(secret, name, payload),
            }),
          ).toBe(true);
        });
      });
    });
  }

  for (const mode of MODES) {
    describe(`OAuth sign-in lands and signs in, ${mode.label}`, () => {
      let idp: MockIdp;
      let stack: Stack;
      beforeAll(async () => {
        idp = await startMockIdp();
        stack = await startStack(infra, {
          presets: ['staff'],
          staff: { authority: idp.base },
          ...(mode.hostCookies ? { hostCookies: true } : {}),
        });
      });
      afterAll(async () => {
        await stack?.stop();
        await idp?.stop();
      });

      it('the redirect back to /callback/* carries the state cookie, creates the session under the mode name, and it works', async () => {
        const email = `member-${randomUUID().slice(0, 6)}@${STAFF_DOMAIN}`;
        const c = stack.client();
        idp.loginAs({ sub: 's', oid: randomUUID(), tid: TEST_TENANT, email, name: 'Member' });

        const start = await c.post(`${API}/sign-in/social`, {
          provider: 'microsoft',
          callbackURL: '/',
        });
        expect(start.status).toBe(200);
        // The OAuth state cookie is named in the mode too.
        for (const line of start.setCookie)
          expect(line.startsWith(`${mode.prefix}.`), line).toBe(true);

        const authz = await c.get(start.json<{ url: string }>().url);
        const callback = await c.get(authz.location!);

        // The landing is a cross-site navigation from the provider: SameSite=Lax is what lets the
        // state cookie arrive, and what lets the new session cookie be set on the way back.
        expect(callback.status).toBe(302);
        const session = callback.setCookie.find((l) => /session_token=/.test(l))!;
        expect(session.split('=')[0]).toBe(`${mode.prefix}.session_token`);
        expect(/;\s*SameSite=Lax/i.test(session)).toBe(true);
        expect(/;\s*Domain=/i.test(session)).toBe(false);

        expect((await c.get(FRESH)).json<{ user: { email: string } }>().user.email).toBe(email);
      });

      it('microsoftSignIn works end to end in the mode (the helper every other suite uses)', async () => {
        const { client } = await microsoftSignIn(stack, idp, {
          sub: 'h',
          oid: randomUUID(),
          tid: TEST_TENANT,
          email: `helper-${randomUUID().slice(0, 6)}@${STAFF_DOMAIN}`,
          name: 'H',
        });
        expect(Object.keys(client.cookies).some((n) => n === `${mode.prefix}.session_token`)).toBe(
          true,
        );
      });
    });
  }

  describe('rate limit of the redirect endpoints (/sign-in/social, /callback/*)', () => {
    let idp: MockIdp;
    let stack: Stack;
    beforeAll(async () => {
      idp = await startMockIdp();
      // Combined instance: the staff redirect endpoints AND the public credential endpoints.
      stack = await startStack(infra, {
        presets: ['public', 'staff'],
        staff: { authority: idp.base },
      });
    });
    afterAll(async () => {
      await stack?.stop();
      await idp?.stop();
    });

    const { windowSeconds, max } = DEFAULTS.rateLimit.oauth;
    const start = (ip: string) =>
      stack
        .client({ ip })
        .post(`${API}/sign-in/social`, { provider: 'microsoft', callbackURL: '/' });

    it('is installed as Better Auth custom rules for exactly those two paths', () => {
      expect(stack.auth.options.rateLimit?.customRules).toEqual({
        '/sign-in/social': { window: windowSeconds, max },
        '/callback/*': { window: windowSeconds, max },
      });
    });

    it('an office behind one address can start its whole morning rush: far more than 3 per 10 s', async () => {
      const ip = '203.0.113.200';
      const statuses: number[] = [];
      for (let i = 0; i < 100; i += 1) statuses.push((await start(ip)).status);
      // Better Auth's own rule for /sign-in* is 3 per 10 s: this would be 3 x 200 then 97 x 429.
      expect(statuses.every((s) => s === 200)).toBe(true);
    });

    it('is still a limit: the request past the ceiling is a 429 with Retry-After, and another address is unaffected', async () => {
      const ip = '203.0.113.201';
      for (let i = 0; i < max; i += 1) expect((await start(ip)).status).toBe(200);
      const refused = await start(ip);
      expect(refused.status).toBe(429);
      expect(refused.headers.get('x-retry-after')).not.toBeNull();
      expect((await start('203.0.113.202')).status).toBe(200);
    });

    it('/callback/* has the same larger limit, per path', async () => {
      const ip = '203.0.113.203';
      const callback = (p: string) =>
        stack.client({ ip }).get(`${API}/callback/${p}?error=access_denied&state=x`);
      const statuses: number[] = [];
      for (let i = 0; i < 60; i += 1) statuses.push((await callback('microsoft')).status);
      expect(statuses.includes(429)).toBe(false);
      // Its own bucket: the other provider's callback and the redirect start are not charged to it.
      expect((await callback('google')).status).not.toBe(429);
      expect((await start(ip)).status).toBe(200);
    });

    it('the credential endpoints keep the strict limit: 3 sign-ins per 10 s per address', async () => {
      const ip = '203.0.113.204';
      const c = stack.client({ ip });
      const codes: number[] = [];
      for (let i = 0; i < 5; i += 1)
        codes.push((await signIn(c, uniqueEmail('strict'), strongPassword())).status);
      expect(codes).toEqual([401, 401, 401, 429, 429]);
    });

    it('is configurable by the consumer, and only for these two paths', async () => {
      const small = await startStack(infra, {
        presets: ['public', 'staff'],
        staff: { authority: idp.base },
        oauthRateLimit: { windowSeconds: 60, max: 5 },
      });
      try {
        expect(small.auth.options.rateLimit?.customRules).toEqual({
          '/sign-in/social': { window: 60, max: 5 },
          '/callback/*': { window: 60, max: 5 },
        });
        const ip = '203.0.113.210';
        const go = () =>
          small
            .client({ ip })
            .post(`${API}/sign-in/social`, { provider: 'microsoft', callbackURL: '/' });
        const codes: number[] = [];
        for (let i = 0; i < 7; i += 1) codes.push((await go()).status);
        expect(codes).toEqual([200, 200, 200, 200, 200, 429, 429]);

        // Loosening it does not loosen sign-in.
        const loose = await startStack(infra, {
          presets: ['public'],
          oauthRateLimit: { windowSeconds: 60, max: 10_000 },
        });
        try {
          const lc = loose.client({ ip: '203.0.113.211' });
          const codes2: number[] = [];
          for (let i = 0; i < 5; i += 1)
            codes2.push((await signIn(lc, uniqueEmail('still'), strongPassword())).status);
          expect(codes2).toEqual([401, 401, 401, 429, 429]);
        } finally {
          await loose.stop();
        }
      } finally {
        await small.stop();
      }
    }, 60_000);

    it('refuses a limit that would switch the limiter off or is not a number', async () => {
      for (const bad of [
        { windowSeconds: 0, max: 10 },
        { windowSeconds: 60, max: 0 },
        { windowSeconds: 60, max: 1.5 },
        { windowSeconds: 60, max: 100_000 },
        { windowSeconds: 7200, max: 10 },
        { windowSeconds: Number.NaN, max: 10 },
      ]) {
        await expect(startStack(infra, { oauthRateLimit: bad })).rejects.toThrow(/oauthRateLimit/);
      }
    });
  });

  describe('hostCookies needs an https base URL', () => {
    it('is refused over http: a browser would not store the cookie', async () => {
      await expect(
        (async () => {
          const { createIdentityInternal } = await import('../create-identity');
          return createIdentityInternal(
            {
              product: 'conformance',
              db: {},
              schema: {},
              cache: {} as never,
              baseURL: 'http://insecure.identity.test',
              trustedOrigins: ['http://insecure.identity.test'],
              presets: ['staff'],
              staff: {
                tenantId: TEST_TENANT,
                clientId: 'c',
                clientSecret: 's',
                domains: ['x.test'],
              },
              hostCookies: true,
              env: { NODE_ENV: 'development', [DEFAULTS.secretEnv]: 'x'.repeat(40) },
            },
            {},
          );
        })(),
      ).rejects.toThrow(/hostCookies needs an https baseURL/);
    });
  });
}
