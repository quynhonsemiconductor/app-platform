import { randomUUID } from 'node:crypto';
import {
  clearContext,
  clearContextEverywhere,
  contextIdOf,
  isUserBanned,
  setContext,
  setUserBanned,
} from '../index';
import { verifiedUser } from './flows';
import {
  API,
  STAFF_DOMAIN,
  startStack,
  strongPassword,
  uniqueEmail,
  type ConformanceInfra,
  type Stack,
} from './harness';
import type { TestApi } from './support';

/**
 * The active context of a session (identity 8.4, plan §5.7 / D6): `session.contextId`, `POST /context/set`,
 * the lazy re-check, `clearContext*` and `setContext`.
 *
 * The product's tenancy is a stand-in here: `Members` is the `membership` port. What this suite proves is
 * that the package never lets a session hold a context the port did not approve, and notices when it stops
 * approving it.
 */
export function contextConformance(t: TestApi, infra: ConformanceInfra): void {
  const { describe, it, beforeAll, afterAll, expect } = t;

  /** The product's membership table, as a port. */
  class Members {
    private readonly map = new Map<string, Set<string>>();
    failing = false;
    readonly calls: Array<[string, string]> = [];
    add(user: string, context: string): this {
      (this.map.get(user) ?? this.map.set(user, new Set()).get(user)!).add(context);
      return this;
    }
    remove(user: string, context: string): this {
      this.map.get(user)?.delete(context);
      return this;
    }
    port = async (user: string, context: string): Promise<boolean> => {
      this.calls.push([user, context]);
      if (this.failing) throw new Error('SECRET-DETAIL membership is down');
      return this.map.get(user)?.has(context) ?? false;
    };
  }

  const CTX_A = randomUUID();
  const CTX_B = randomUUID();
  const CTX_C = randomUUID();

  /** A staff-shaped stack (like rova): test-login for sessions, the context option on top. */
  const open = (members: Members, extra: Record<string, unknown> = {}, initial?: () => unknown) =>
    startStack(infra, {
      presets: ['staff'],
      withoutMail: true,
      testLogin: true,
      env: { IDENTITY_TEST_LOGIN: 'enabled' },
      context: {
        membership: members.port,
        revalidateSeconds: 0,
        ...(initial ? { initial: initial as never } : {}),
        ...extra,
      },
    });

  async function signIn(stack: Stack) {
    const email = `ctx-${randomUUID().slice(0, 8)}@${STAFF_DOMAIN}`;
    const client = stack.client();
    const res = await client.post(`${API}/test-login`, { email });
    expect(res.status, res.body).toBe(200);
    const userId = res.json<{ user: { id: string } }>().user.id;
    return { client, userId, email };
  }
  const contextOf = async (client: ReturnType<Stack['client']>) =>
    contextIdOf((await client.get(`${API}/get-session`)).json());
  const rowContext = async (stack: Stack, userId: string) =>
    (
      await stack.pool.query<{ context_id: string | null }>(
        `select context_id from identity.session where user_id = $1 order by created_at`,
        [userId],
      )
    ).rows.map((r) => r.context_id);
  const set = (client: ReturnType<Stack['client']>, contextId: string | null) =>
    client.post(`${API}/context/set`, { contextId });

  describe('without the `context` option', () => {
    let stack: Stack;
    beforeAll(async () => {
      stack = await startStack(infra, {
        presets: ['staff'],
        withoutMail: true,
        testLogin: true,
        env: { IDENTITY_TEST_LOGIN: 'enabled' },
      });
    });
    afterAll(() => stack?.stop());

    it('there is no endpoint and a session has no context', async () => {
      const { client } = await signIn(stack);
      expect((await set(client, CTX_A)).status).toBe(404);
      expect(contextIdOf((await client.get(`${API}/get-session`)).json())).toBeNull();
    });
  });

  describe('the options are validated at start-up', () => {
    it('a missing membership port, a non-function initial and a bad interval are refused', async () => {
      const bad = [
        {},
        { membership: 'yes' },
        { membership: () => true, initial: 'a' },
        { membership: () => true, revalidateSeconds: -1 },
        { membership: () => true, revalidateSeconds: 1.5 },
        { membership: () => true, revalidateSeconds: 3601 },
      ];
      for (const context of bad) {
        await expect(
          startStack(infra, { presets: ['staff'], withoutMail: true, context: context as never }),
        ).rejects.toThrow(/context/);
      }
    });
  });

  describe('the context a session starts in', () => {
    it('is `initial()` when the user is a member of it, and none otherwise', async () => {
      const members = new Members();
      let answer: unknown = CTX_A;
      const stack = await open(members, {}, () => answer);
      try {
        const a = await signIn(stack);
        // Not a member yet: initial() named a context the port does not approve.
        expect(await contextOf(a.client)).toBeNull();

        members.add(a.userId, CTX_A);
        const again = stack.client();
        await again.post(`${API}/test-login`, { email: a.email });
        expect(await contextOf(again)).toBe(CTX_A);
        expect(await rowContext(stack, a.userId)).toContain(CTX_A);

        // A value that is not a UUID, a null and a throw are all "no context"; sign-in still succeeds.
        for (const bogus of ['not-a-uuid', null, undefined, 42]) {
          answer = bogus;
          const c = stack.client();
          const res = await c.post(`${API}/test-login`, { email: a.email });
          expect(res.status).toBe(200);
          expect(await contextOf(c)).toBeNull();
        }
      } finally {
        await stack.stop();
      }
    });

    it('a throwing initial() starts the session without a context, logs, and never fails the sign-in', async () => {
      const members = new Members();
      const stack = await open(members, {}, () => {
        throw new Error('SECRET-DETAIL initial is down');
      });
      try {
        const { client } = await signIn(stack);
        expect(await contextOf(client)).toBeNull();
        const logged = JSON.stringify(stack.logs);
        expect(logged).toContain('identity.context_port_failed');
        expect(logged).not.toContain('SECRET-DETAIL');
      } finally {
        await stack.stop();
      }
    });
  });

  describe('POST /context/set', () => {
    let stack: Stack;
    const members = new Members();
    beforeAll(async () => {
      stack = await open(members);
    });
    afterAll(() => stack?.stop());

    it('sets a context the user is a member of: the session, the row and the cache all say so; one event', async () => {
      const { client, userId } = await signIn(stack);
      members.add(userId, CTX_A);
      stack.events.length = 0;

      const res = await set(client, CTX_A);
      expect(res.status, res.body).toBe(200);
      expect(res.json()).toEqual({ contextId: CTX_A });
      expect(members.calls).toContainEqual([userId, CTX_A]);

      expect(await contextOf(client)).toBe(CTX_A);
      expect(await rowContext(stack, userId)).toEqual([CTX_A]);
      // The cache copy too: drop it, and the database row answers the same.
      await stack.flushCache();
      expect(await contextOf(client)).toBe(CTX_A);

      const events = stack.events.filter((e) => e.name === 'context.switched');
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ userId, detail: { from: 'none', to: CTX_A } });
    });

    it('switches between two contexts and clears with null', async () => {
      const { client, userId } = await signIn(stack);
      members.add(userId, CTX_A).add(userId, CTX_B);
      expect((await set(client, CTX_A)).status).toBe(200);
      expect((await set(client, CTX_B)).status).toBe(200);
      expect(await contextOf(client)).toBe(CTX_B);
      expect((await set(client, null)).status).toBe(200);
      expect(await contextOf(client)).toBeNull();
      expect(await rowContext(stack, userId)).toEqual([null]);
    });

    it('refuses a context the user is not a member of: 403 CONTEXT_FORBIDDEN, nothing changes, one event', async () => {
      const { client, userId } = await signIn(stack);
      members.add(userId, CTX_A);
      expect((await set(client, CTX_A)).status).toBe(200);
      stack.events.length = 0;

      const res = await set(client, CTX_C);
      expect(res.status).toBe(403);
      expect(res.json<{ code: string }>().code).toBe('CONTEXT_FORBIDDEN');
      expect(await contextOf(client)).toBe(CTX_A);
      expect(await rowContext(stack, userId)).toEqual([CTX_A]);
      expect(stack.events.map((e) => e.name)).toEqual(['context.refused']);
    });

    it('needs a session (401) and a UUID or null (400)', async () => {
      expect((await set(stack.client(), CTX_A)).status).toBe(401);
      const { client } = await signIn(stack);
      for (const body of [{ contextId: 'not-a-uuid' }, { contextId: 7 }, {}, { contextId: '' }]) {
        const res = await client.post(`${API}/context/set`, body);
        expect(res.status, JSON.stringify(body)).toBe(400);
      }
    });

    it('a request from another origin cannot switch the context, even with the session cookie (CSRF)', async () => {
      const { client, userId } = await signIn(stack);
      members.add(userId, CTX_A);
      const foreign = stack.client({ origin: 'https://evil.example' });
      foreign.setCookies(client.cookies);
      const res = await foreign.post(`${API}/context/set`, { contextId: CTX_A });
      expect(res.status).toBe(403);
      expect(await rowContext(stack, userId)).toEqual([null]);
    });

    it('a throwing membership() is the fixed 500 (the cause is only in the log, as CONTEXT_CHECK_FAILED), and changes nothing', async () => {
      const { client, userId } = await signIn(stack);
      members.add(userId, CTX_A);
      expect((await set(client, CTX_A)).status).toBe(200);
      members.failing = true;
      try {
        const res = await set(client, CTX_B);
        expect(res.status).toBe(500);
        // Every 5xx on /api/auth is the fixed envelope (README): the specific code is in the log only.
        expect(res.json<{ code: string }>().code).toBe('INTERNAL_ERROR');
        expect(res.body).not.toContain('SECRET-DETAIL');
        expect(JSON.stringify(stack.logs)).toContain('CONTEXT_CHECK_FAILED');
        expect(JSON.stringify(stack.logs)).not.toContain('SECRET-DETAIL');
      } finally {
        members.failing = false;
      }
      expect(await rowContext(stack, userId)).toEqual([CTX_A]);
    });

    it('only /context/set sets it: no other request can write contextId', async () => {
      const { client, userId } = await signIn(stack);
      members.add(userId, CTX_A);
      for (const [path, body] of [
        ['/update-session', { contextId: CTX_A }],
        ['/update-user', { contextId: CTX_A, name: 'x' }],
        ['/test-login', { email: `ctx-x@${STAFF_DOMAIN}`, contextId: CTX_A }],
      ] as const) {
        await client.post(`${API}${path}`, body);
      }
      expect(await rowContext(stack, userId)).toEqual([null]);
      expect(await contextOf(client)).toBeNull();
    });
  });

  describe('a session that loses its context', () => {
    it('falls back to initial() (or none) on its next read, stays signed in, and says so (revalidateSeconds 0)', async () => {
      const members = new Members();
      const holder: { fallback: string | null } = { fallback: null };
      const stack = await open(members, {}, () => holder.fallback);
      try {
        const { client, userId } = await signIn(stack);
        members.add(userId, CTX_A).add(userId, CTX_B);
        expect((await set(client, CTX_A)).status).toBe(200);
        stack.events.length = 0;

        // Removed from A, still a member of B, which initial() offers.
        members.remove(userId, CTX_A);
        holder.fallback = CTX_B;
        expect(await contextOf(client)).toBe(CTX_B);
        const me = (await client.get(`${API}/get-session`)).json<{
          user?: { id: string };
        } | null>();
        expect(me?.user?.id).toBe(userId);
        expect(await rowContext(stack, userId)).toEqual([CTX_B]);
        const revoked = stack.events.filter((e) => e.name === 'context.revoked');
        expect(revoked).toHaveLength(1);
        expect(revoked[0]).toMatchObject({
          userId,
          detail: { reason: 'membership_lost', to: CTX_B },
        });

        // Removed from B and nothing to fall back to: none.
        members.remove(userId, CTX_B);
        holder.fallback = null;
        expect(await contextOf(client)).toBeNull();
        expect(await rowContext(stack, userId)).toEqual([null]);
      } finally {
        await stack.stop();
      }
    });

    it('a failing membership() on a read keeps the context (fail-open) and logs only the class', async () => {
      const members = new Members();
      const stack = await open(members);
      try {
        const { client, userId } = await signIn(stack);
        members.add(userId, CTX_A);
        expect((await set(client, CTX_A)).status).toBe(200);
        members.failing = true;
        expect(await contextOf(client)).toBe(CTX_A);
        expect(JSON.stringify(stack.logs)).not.toContain('SECRET-DETAIL');
        expect(JSON.stringify(stack.logs)).toContain('identity.context_port_failed');
      } finally {
        await stack.stop();
      }
    });

    it('is believed for revalidateSeconds: membership is not asked again inside the window', async () => {
      const members = new Members();
      const stack = await open(members, { revalidateSeconds: 3600 });
      try {
        const { client, userId } = await signIn(stack);
        members.add(userId, CTX_A);
        expect((await set(client, CTX_A)).status).toBe(200);
        const asked = members.calls.length;
        await contextOf(client);
        await contextOf(client);
        expect(members.calls.length).toBe(asked);
        // Removed, and still believed: this is the window, and clearContext is the eager half.
        members.remove(userId, CTX_A);
        expect(await contextOf(client)).toBe(CTX_A);
        expect(await clearContext(stack.auth, { userId, contextId: CTX_A })).toBe(1);
        expect(await contextOf(client)).toBeNull();
      } finally {
        await stack.stop();
      }
    });
  });

  describe('clearContext and clearContextEverywhere', () => {
    it("clearContext takes the context from one user's sessions only, in the row and in the cache", async () => {
      const members = new Members();
      const stack = await open(members, { revalidateSeconds: 3600 });
      try {
        const one = await signIn(stack);
        const twoClient = stack.client();
        await twoClient.post(`${API}/test-login`, { email: one.email });
        const other = await signIn(stack);
        for (const id of [one.userId, other.userId]) members.add(id, CTX_A).add(id, CTX_B);
        expect((await set(one.client, CTX_A)).status).toBe(200);
        expect((await set(twoClient, CTX_A)).status).toBe(200);
        expect((await set(other.client, CTX_A)).status).toBe(200);

        const n = await clearContext(stack.auth, { userId: one.userId, contextId: CTX_A });
        expect(n).toBe(2);
        expect(await contextOf(one.client)).toBeNull();
        expect(await contextOf(twoClient)).toBeNull();
        expect(await contextOf(other.client)).toBe(CTX_A);
        expect(await rowContext(stack, one.userId)).toEqual([null, null]);
        // Sessions stay valid.
        expect(
          (await one.client.get(`${API}/get-session`)).json<{ user?: unknown } | null>()?.user,
        ).toBeDefined();
        // Re-running finds nothing.
        expect(await clearContext(stack.auth, { userId: one.userId, contextId: CTX_A })).toBe(0);
      } finally {
        await stack.stop();
      }
    });

    it('clearContextEverywhere takes one context from everyone and leaves the others', async () => {
      const members = new Members();
      const stack = await open(members, { revalidateSeconds: 3600 });
      try {
        const a = await signIn(stack);
        const b = await signIn(stack);
        for (const id of [a.userId, b.userId]) members.add(id, CTX_A).add(id, CTX_B);
        expect((await set(a.client, CTX_A)).status).toBe(200);
        expect((await set(b.client, CTX_B)).status).toBe(200);
        expect(await clearContextEverywhere(stack.auth, CTX_A)).toBe(1);
        expect(await contextOf(a.client)).toBeNull();
        expect(await contextOf(b.client)).toBe(CTX_B);
      } finally {
        await stack.stop();
      }
    });

    it('refuses what is not a UUID, and needs the option', async () => {
      const members = new Members();
      const stack = await open(members);
      try {
        await expect(clearContext(stack.auth, { userId: 'x', contextId: CTX_A })).rejects.toThrow(
          /UUID/,
        );
        await expect(clearContextEverywhere(stack.auth, 'x')).rejects.toThrow(/UUID/);
      } finally {
        await stack.stop();
      }
      const without = await startStack(infra, { presets: ['staff'], withoutMail: true });
      try {
        await expect(clearContextEverywhere(without.auth, CTX_A)).rejects.toThrow(/context/);
      } finally {
        await without.stop();
      }
    });
  });

  describe('setContext, service side', () => {
    it("does what POST /context/set does, with the caller's session cookie, and refuses the same way", async () => {
      const members = new Members();
      const stack = await open(members);
      try {
        const { client, userId } = await signIn(stack);
        members.add(userId, CTX_A);
        const cookie = Object.entries(client.cookies)
          .map(([k, v]) => `${k}=${v}`)
          .join('; ');

        const done = await setContext(stack.auth, { headers: { cookie }, contextId: CTX_A });
        expect(done.contextId).toBe(CTX_A);
        expect(await contextOf(client)).toBe(CTX_A);

        await expect(
          setContext(stack.auth, { headers: { cookie }, contextId: CTX_C }),
        ).rejects.toMatchObject({ body: { code: 'CONTEXT_FORBIDDEN' } });
        await expect(
          setContext(stack.auth, { headers: {}, contextId: CTX_A }),
        ).rejects.toMatchObject({ statusCode: 401 });
        expect(await contextOf(client)).toBe(CTX_A);
      } finally {
        await stack.stop();
      }
    });
  });

  describe('the public preset (cookie cache)', () => {
    it('a switch refreshes the cached session cookie, so the next read does not show the old context', async () => {
      const members = new Members();
      const stack = await startStack(infra, {
        presets: ['public'],
        context: { membership: members.port, revalidateSeconds: 0 },
      });
      try {
        const email = uniqueEmail('ctx');
        const client = await verifiedUser(stack, email, strongPassword(), expect);
        const session = (await client.get(`${API}/get-session`)).json<{ user: { id: string } }>();
        members.add(session.user.id, CTX_A).add(session.user.id, CTX_B);
        expect((await set(client, CTX_A)).status).toBe(200);
        expect(await contextOf(client)).toBe(CTX_A);
        expect((await set(client, CTX_B)).status).toBe(200);
        // WITH the cookie cache (the default read): the refreshed cookie answers, not a stale one.
        expect(await contextOf(client)).toBe(CTX_B);
      } finally {
        await stack.stop();
      }
    });
  });

  describe('isUserBanned (what a pre-authenticating guard must ask)', () => {
    it('is false for a user in good standing and for one nobody knows, true as soon as setUserBanned runs, false again after the unban', async () => {
      const members = new Members();
      const stack = await open(members);
      try {
        const { userId } = await signIn(stack);
        expect(await isUserBanned(stack.auth, userId)).toBe(false);
        expect(await isUserBanned(stack.auth, randomUUID())).toBe(false);

        await setUserBanned(stack.auth, userId, true, 'test');
        expect(await isUserBanned(stack.auth, userId)).toBe(true);

        await setUserBanned(stack.auth, userId, false);
        expect(await isUserBanned(stack.auth, userId)).toBe(false);
      } finally {
        await stack.stop();
      }
    });

    it('refuses what is not a user id', async () => {
      const stack = await open(new Members());
      try {
        await expect(isUserBanned(stack.auth, 'not-a-uuid')).rejects.toThrow(/UUID/);
      } finally {
        await stack.stop();
      }
    });
  });

  describe('a context id is validated the same way on every path', () => {
    it('/context/set and initial() accept and refuse the same strings', async () => {
      const members = new Members();
      const stack = await open(members, {}, () => 'ffffffff-ffff-ffff-ffff-ffffffffffff');
      try {
        // A well-formed id with a version/variant nibble z.uuid() would reject is a UUID to both.
        const odd = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
        const { client, userId } = await signIn(stack);
        members.add(userId, odd);
        expect((await set(client, odd)).status).toBe(200);
        expect((await set(client, 'not-a-uuid')).status).toBe(400);
        const again = stack.client();
        await again.post(`${API}/test-login`, { email: (await signIn(stack)).email });
        // initial() offered `odd` to a user who is not a member: refused, exactly as the endpoint would
        expect(await contextOf(again)).toBeNull();
      } finally {
        await stack.stop();
      }
    });
  });

  describe('with the cache down', () => {
    it('a switch and a read still work from Postgres', async () => {
      const members = new Members();
      const stack = await startStack(infra, {
        presets: ['staff'],
        withoutMail: true,
        testLogin: true,
        env: { IDENTITY_TEST_LOGIN: 'enabled' },
        appValkeyUrl: 'redis://127.0.0.1:1',
        context: { membership: members.port, revalidateSeconds: 0 },
      });
      try {
        const { client, userId } = await signIn(stack);
        members.add(userId, CTX_A);
        expect((await set(client, CTX_A)).status).toBe(200);
        expect(await contextOf(client)).toBe(CTX_A);
        expect(await rowContext(stack, userId)).toEqual([CTX_A]);
      } finally {
        await stack.stop();
      }
    });
  });
}
