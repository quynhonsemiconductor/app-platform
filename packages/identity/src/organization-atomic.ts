import { AsyncLocalStorage } from 'node:async_hooks';
import { runWithAdapter } from '@better-auth/core/context';
import type { Identity } from './create-identity';

/**
 * Better Auth's `organization/create` is two autocommit statements: the organization row, then the
 * owner's `member` row. A failure of the second (a missing grant, a deadlock, a statement timeout, a throw
 * from a hook) used to leave an organization with NO owner: nobody can manage or delete it, and its
 * slug is taken, so the caller's retry fails with `ORGANIZATION_ALREADY_EXISTS` (identity#206).
 *
 * The create now runs inside ONE transaction, on the adapter identity already configured with
 * `transaction: true` (whose `db.transaction` goes through `withTxCapture`, so a statement that fails
 * and is swallowed aborts the transaction into an error rather than a silent rollback, identity#191).
 * Both rows commit or neither does.
 *
 * Why not simply Better Auth's own `runWithTransaction`: it works for `auth.api.createOrganization`,
 * but the HTTP handler (`auth.handler`) starts every request with `runWithAdapter(context.adapter, …)`,
 * which REPLACES the current adapter, so a transaction opened outside the handler is not the one the
 * endpoint uses (measured: the organization survived the rollback). Instead the context's adapter is
 * replaced by a thin proxy that forwards every call to the transaction's adapter while a create is in
 * progress, and to the real adapter otherwise. The handler can reset the adapter as often as it likes;
 * what it resets it to is the proxy.
 *
 * `auth.api.createOrganization` never passes through `auth.handler`, so nothing there sets the current
 * adapter either: Better Auth's internal adapter (`findUserById`, `findSession`/`updateSession` when a
 * session is passed, `setActiveOrganization`) would use the pool directly and take a SECOND connection
 * while the first sits in the transaction (with a pool of one: a deadlock). The api path therefore runs
 * `runWithAdapter(proxy, …)` inside the transaction, as `auth.handler` does for every request.
 *
 * Two entry points need it, because Better Auth builds them separately:
 *  - `auth.api.createOrganization(...)`, how a product creates an organization while
 *    `allowOrganizationCreation` is false (server side);
 *  - `POST /api/auth/organization/create`, through `auth.handler`.
 */
const CREATE_PATH = '/organization/create';

type Adapter = Record<string, unknown> & {
  transaction<T>(callback: (trx: Record<string, unknown>) => Promise<T>): Promise<T>;
};
type ContextWithAdapter = { adapter: Adapter };

/** The transaction's adapter while an organization is being created in this async context. */
const current = new AsyncLocalStorage<{ trx: Record<string, unknown> }>();
const installed = new WeakSet<object>();

/**
 * Replace `context.adapter` with the forwarding proxy, once. Done as soon as the instance's context
 * exists, before any request: Better Auth reads `context.adapter` per request, so the proxy is what
 * every handler call (and every `runWithAdapter`) then sees.
 */
function install(context: ContextWithAdapter): Adapter {
  if (installed.has(context.adapter)) return context.adapter;
  const real = context.adapter;
  const proxy = new Proxy(real, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof value !== 'function') return value;
      if (property === 'transaction') {
        // Inside a create, a nested `transaction` joins the one that is open (the transaction's own
        // adapter runs its callback as is); it must never open a second, on a second connection.
        return (callback: (trx: Record<string, unknown>) => Promise<unknown>) => {
          const trx = current.getStore()?.trx;
          const nested = trx?.['transaction'] as
            ((cb: typeof callback) => Promise<unknown>) | undefined;
          if (trx) return nested ? nested.call(trx, callback) : callback(trx);
          return (value as (cb: typeof callback) => Promise<unknown>).call(target, callback);
        };
      }
      return (...args: unknown[]) => {
        const trx = current.getStore()?.trx;
        const owner = (trx ?? target) as Record<string | symbol, unknown>;
        const method = owner[property] as (...a: unknown[]) => unknown;
        return method.apply(owner, args);
      };
    },
  });
  installed.add(proxy);
  context.adapter = proxy;
  return proxy;
}

async function atomically<T>(auth: Identity, run: () => Promise<T>): Promise<T> {
  const context = (await auth.$context) as unknown as ContextWithAdapter;
  const adapter = install(context);
  // Already inside one (a nested call): join it, never open a second.
  if (current.getStore()) return run();
  return adapter.transaction((trx) =>
    // `runWithAdapter` is what `auth.handler` does at the start of every request: without it the
    // internal adapter of a server-side call is not the proxy and takes its own connection.
    current.run({ trx }, () => runWithAdapter(adapter as never, run)),
  );
}

/** Install the proxy as soon as the instance's context exists. */
export function prepareAtomicOrganizationCreate(auth: Identity): void {
  void (auth.$context as unknown as Promise<ContextWithAdapter>).then(
    (context) => install(context),
    () => undefined,
  );
}

/** `auth.api.createOrganization`, atomic. The other `api` calls are untouched. */
export function makeCreateOrganizationAtomic(auth: Identity): void {
  const api = auth.api as unknown as Record<string, unknown>;
  const original = api['createOrganization'];
  if (typeof original !== 'function') return;
  api['createOrganization'] = (...args: unknown[]) =>
    atomically(auth, () => (original as (...a: unknown[]) => Promise<unknown>)(...args));
}

/** Thrown inside the transaction to roll it back when Better Auth ANSWERED with an error. */
class RollbackWith extends Error {
  constructor(readonly response: Response) {
    super('rolled back');
  }
}

/**
 * `handler`, with `POST <basePath>/organization/create` inside one transaction. Better Auth turns an
 * error that happens after the organization row into an error RESPONSE, not a throw, so a response of
 * 400 or above rolls the transaction back too: an organization is never left behind by a request that
 * failed.
 */
export function withAtomicOrganizationCreate(
  handler: (request: Request) => Promise<Response>,
  auth: Identity,
  basePath: string,
): (request: Request) => Promise<Response> {
  const target = `${basePath}${CREATE_PATH}`;
  return async (request) => {
    if (request.method !== 'POST' || new URL(request.url).pathname !== target) {
      return handler(request);
    }
    // A transaction is a pooled connection: do not open one for a caller who cannot create anything.
    // Anonymous requests (20 of them were 21 pool acquisitions, before Better Auth's rate limit or its
    // 401) and requests whose session does not resolve go straight to the handler, which answers them.
    if (!(await hasSession(auth, request))) return handler(request);
    try {
      return await atomically(auth, async () => {
        const response = await handler(request);
        if (response.status >= 400) throw new RollbackWith(response);
        return response;
      });
    } catch (error) {
      if (error instanceof RollbackWith) return error.response;
      throw error;
    }
  };
}

/** Whether the request carries a credential that resolves to a session. No credential: no lookup at all. */
async function hasSession(auth: Identity, request: Request): Promise<boolean> {
  if (!request.headers.has('cookie') && !request.headers.has('authorization')) return false;
  try {
    const getSession = (auth.api as unknown as Record<string, unknown>)['getSession'] as (input: {
      headers: Headers;
      query: { disableRefresh: boolean };
    }) => Promise<unknown>;
    // `disableRefresh`: this is a question, not a request. A refresh here would update the session and
    // discard the Set-Cookie it produces, and the handler's own lookup would then find nothing due and
    // never send the client the refreshed cookie.
    return (
      (await getSession({ headers: request.headers, query: { disableRefresh: true } })) !== null
    );
  } catch {
    return false;
  }
}
