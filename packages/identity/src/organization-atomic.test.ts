import { describe, expect, it } from 'vitest';
import type { Identity } from './create-identity';
import {
  makeCreateOrganizationAtomic,
  prepareAtomicOrganizationCreate,
  withAtomicOrganizationCreate,
} from './organization-atomic';

/**
 * A stand-in adapter. `transaction` hands the callback a SECOND adapter and records begin/commit/
 * rollback; `create` records which of the two served the call, which is what "inside the
 * transaction" means for Better Auth.
 */
function fakeAuth(api: Record<string, unknown> = {}) {
  const events: string[] = [];
  const makeAdapter = (name: string) => ({
    create: async () => {
      events.push(`create@${name}`);
      return {};
    },
    // the transaction's own adapter runs a nested callback as is
    transaction: async <T>(callback: (trx: unknown) => Promise<T>): Promise<T> => {
      events.push(`nested@${name}`);
      return callback(makeAdapter(name));
    },
  });
  const real = {
    ...makeAdapter('real'),
    transaction: async <T>(callback: (trx: unknown) => Promise<T>): Promise<T> => {
      events.push('begin');
      try {
        const result = await callback(makeAdapter('trx'));
        events.push('commit');
        return result;
      } catch (error) {
        events.push('rollback');
        throw error;
      }
    },
  };
  const context = { adapter: real as Record<string, unknown> };
  const sessions = { signedIn: true, lookups: 0 };
  const auth = {
    $context: Promise.resolve(context),
    api: {
      getSession: async () => {
        sessions.lookups += 1;
        return sessions.signedIn ? { session: {} } : null;
      },
      ...api,
    },
  } as unknown as Identity;
  // what Better Auth's handler does at the start of every request: use context.adapter, whatever it is now
  const callAdapter = () => (context.adapter['create'] as () => Promise<unknown>)();
  return { auth, events, callAdapter, context, sessions };
}

const post = (path: string, headers: Record<string, string> = { cookie: 'session=1' }) =>
  new Request(`https://auth.example.test${path}`, { method: 'POST', headers });

describe('withAtomicOrganizationCreate', () => {
  it('serves POST /organization/create from ONE transaction, however often the handler re-reads context.adapter', async () => {
    const { auth, events, callAdapter } = fakeAuth();
    prepareAtomicOrganizationCreate(auth);
    await auth.$context;
    const handler = withAtomicOrganizationCreate(
      async () => {
        await callAdapter(); // the organization
        await callAdapter(); // its owner
        return new Response('{"id":"o"}', { status: 200 });
      },
      auth,
      '/api/auth',
    );
    expect((await handler(post('/api/auth/organization/create'))).status).toBe(200);
    expect(events).toEqual(['begin', 'create@trx', 'create@trx', 'commit']);
  });

  it('outside a create, calls go to the real adapter (nothing else is transactional)', async () => {
    const { auth, events, callAdapter } = fakeAuth();
    prepareAtomicOrganizationCreate(auth);
    await auth.$context;
    const handler = withAtomicOrganizationCreate(
      async () => {
        await callAdapter();
        return new Response('ok');
      },
      auth,
      '/api/auth',
    );
    await handler(post('/api/auth/organization/update'));
    await handler(post('/api/auth/sign-in/email'));
    await handler(new Request('https://auth.example.test/api/auth/organization/create'));
    expect(events).toEqual(['create@real', 'create@real', 'create@real']);
  });

  it('rolls back when Better Auth ANSWERED with an error, and returns that very response', async () => {
    const { auth, events, callAdapter } = fakeAuth();
    const failure = new Response('{"code":"X"}', { status: 400 });
    const handler = withAtomicOrganizationCreate(
      async () => {
        await callAdapter();
        return failure;
      },
      auth,
      '/api/auth',
    );
    expect(await handler(post('/api/auth/organization/create'))).toBe(failure);
    expect(events).toEqual(['begin', 'create@trx', 'rollback']);
  });

  it('rolls back and rethrows when the handler throws', async () => {
    const { auth, events } = fakeAuth();
    const handler = withAtomicOrganizationCreate(
      async () => {
        throw new Error('boom');
      },
      auth,
      '/api/auth',
    );
    await expect(handler(post('/api/auth/organization/create'))).rejects.toThrow('boom');
    expect(events).toEqual(['begin', 'rollback']);
  });

  it('two concurrent creates do not share a transaction', async () => {
    const { auth, events, callAdapter } = fakeAuth();
    const handler = withAtomicOrganizationCreate(
      async () => {
        await new Promise((r) => setTimeout(r, 5));
        await callAdapter();
        return new Response('ok');
      },
      auth,
      '/api/auth',
    );
    await Promise.all([
      handler(post('/api/auth/organization/create')),
      handler(post('/api/auth/organization/create')),
    ]);
    expect(events.filter((e) => e === 'begin')).toHaveLength(2);
    expect(events.filter((e) => e === 'create@trx')).toHaveLength(2);
  });
});

describe('what opens a transaction, and what a nested one does', () => {
  it('a request with no credential opens no transaction and looks up no session', async () => {
    const { auth, events, sessions } = fakeAuth();
    const handler = withAtomicOrganizationCreate(
      async () => new Response('{}', { status: 401 }),
      auth,
      '/api/auth',
    );
    for (let i = 0; i < 20; i += 1) {
      expect((await handler(post('/api/auth/organization/create', {}))).status).toBe(401);
    }
    expect(events).toEqual([]);
    expect(sessions.lookups).toBe(0);
  });

  it('a credential that resolves to no session opens no transaction either, and the handler answers it', async () => {
    const { auth, events, sessions } = fakeAuth();
    sessions.signedIn = false;
    const handler = withAtomicOrganizationCreate(
      async () => new Response('{}', { status: 401 }),
      auth,
      '/api/auth',
    );
    expect((await handler(post('/api/auth/organization/create'))).status).toBe(401);
    expect(events).toEqual([]);
    expect(sessions.lookups).toBe(1);
  });

  it('inside a create, a nested transaction JOINS the open one: the transaction adapter runs it, no second begin', async () => {
    const { auth, events, context } = fakeAuth();
    prepareAtomicOrganizationCreate(auth);
    await auth.$context;
    const handler = withAtomicOrganizationCreate(
      async () => {
        await (context.adapter['transaction'] as (cb: () => Promise<void>) => Promise<void>)(
          async () => undefined,
        );
        return new Response('ok');
      },
      auth,
      '/api/auth',
    );
    await handler(post('/api/auth/organization/create'));
    expect(events).toEqual(['begin', 'nested@trx', 'commit']);
  });
});

describe('makeCreateOrganizationAtomic', () => {
  it('runs auth.api.createOrganization in one transaction, passing arguments and result through', async () => {
    const harness = fakeAuth();
    (harness.auth.api as unknown as Record<string, unknown>)['createOrganization'] = async (input: {
      body: { slug: string };
    }) => {
      await harness.callAdapter();
      return { slug: input.body.slug };
    };
    makeCreateOrganizationAtomic(harness.auth);
    const api = harness.auth.api as unknown as { createOrganization(i: unknown): Promise<unknown> };
    expect(await api.createOrganization({ body: { slug: 'acme' } })).toEqual({ slug: 'acme' });
    expect(harness.events).toEqual(['begin', 'create@trx', 'commit']);
  });

  it('rolls back when the call throws', async () => {
    const harness = fakeAuth({
      createOrganization: async () => {
        throw new Error('member insert failed');
      },
    });
    makeCreateOrganizationAtomic(harness.auth);
    await expect(
      (
        harness.auth.api as unknown as { createOrganization(): Promise<unknown> }
      ).createOrganization(),
    ).rejects.toThrow('member insert failed');
    expect(harness.events).toEqual(['begin', 'rollback']);
  });

  it('leaves an instance without the endpoint alone', () => {
    const harness = fakeAuth({});
    expect(() => makeCreateOrganizationAtomic(harness.auth)).not.toThrow();
    expect((harness.auth.api as Record<string, unknown>)['createOrganization']).toBeUndefined();
  });
});
