import { betterAuth, type Auth, type BetterAuthOptions, type User } from 'better-auth';
import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { admin, organization, twoFactor } from 'better-auth/plugins';
import type { CacheService } from '@quynhonsemiconductor/platform-cache';
import { uuidv7 } from 'uuidv7';
import { normalizeStaffDomains, staffDomainsProblem, staffReservedDomains } from './domains';
import { reservedDomainCheck } from './reserved';
import { purgeWith, replaceUnverifiedAccount, type AccountContext } from './accounts';
import { DEFAULTS, type Preset } from './defaults';
import {
  consoleLogger,
  emitSafely,
  errorFields,
  noopSink,
  type IdentityLogger,
  type SecurityEventSink,
} from './events';
import { bannedSessionGuard } from './banned-guard';
import { accountLockout } from './lockout';
import { perEmailLimiter } from './mail-limit';
import { oauthRateLimitRules, type OAuthRateLimit } from './rate-limit';
import { AuthMail } from './mail-port';
import { argon2Password } from './password';
import { companyDomainSignUpGuard, securityEvents, ssoRegistrationGuard } from './plugins';
import type { AuthEmailTemplates, JobEnqueue } from './ports';
import {
  googleProvider,
  microsoftProvider,
  type GoogleOptions,
  type StaffOptions,
} from './providers';
import { defaultSsrfPolicy, type SsrfPolicy } from './ssrf';
import { parseKeyring } from './sso-crypto';
import { withEncryptedSsoSecrets } from './sso-protect';
import { ssoPlugin, type SsoHooks } from './sso';
import { valkeySecondaryStorage, type StorageDegraded } from './storage';
import { testLogin } from './test-login';
import {
  staffBecameHooks,
  staffClassifier,
  staffRefreshGuard,
  staffSessionHooks,
} from './staff-session';
import {
  rememberCreatedUser,
  withCallbackErrorCodes,
  type StaffSignInClaims,
} from './callback-errors';
import { withErrorEnvelope } from './error-envelope';
import {
  makeCreateOrganizationAtomic,
  prepareAtomicOrganizationCreate,
  withAtomicOrganizationCreate,
} from './organization-atomic';
import { withTimingFloor } from './timing';
import { withTxCapture } from './tx-context';

export const AUTH_BASE_PATH = '/api/auth';

/**
 * Deliberately the WIDE type. `betterAuth(options)` infers a type that references zod and
 * better-call internals by pnpm path (TS2883) and is too long to serialise (TS7056), so a package
 * built with `declaration: true` cannot export it inferred. Plugin endpoints (`api.createOrganization`,
 * `api.banUser`, …) are therefore untyped through `Identity` (WP-9, D1).
 */
export type Identity = Auth<BetterAuthOptions>;

export interface IdentityOptions {
  /** Product name: cookie prefix, 2FA issuer, app name. */
  product: string;
  /** The product's Drizzle instance from `platform-db` (`DATABASE_TOKEN`). */
  db: object;
  /** The product's Drizzle schema: the auth tables, generated with `auth generate`. */
  schema: Record<string, unknown>;
  cache: CacheService;
  baseURL: string;
  /** Static list. Provider origins for SSO are added by the package, after the SSRF check. */
  trustedOrigins: string[];
  presets: Preset[];
  /**
   * Auth emails are enqueued, never awaited (APP-PLATFORM-PLAN.md §4.3 case 1). **Required with the
   * `public` preset** (verification and password-reset mail); optional when no configured preset sends
   * any (`staff`, `organizations`): leaving it out there is the honest configuration.
   */
  mail?: { jobs: JobEnqueue; templates: AuthEmailTemplates };
  /**
   * May any signed-in user create an organization? Default `false`: organizations are created by
   * the product (an admin tool, onboarding of a partner). Open creation lets a stranger become an
   * organization owner and so register an SSO provider.
   */
  allowOrganizationCreation?: boolean;
  /**
   * Rate limits, per client address and per path, of the endpoints that only START or FINISH a redirect
   * to an identity provider and take no credential: `start` = `/sign-in/social` and `/sign-in/sso`
   * (default 120 per 60 s, sized for about a hundred staff behind one address in the same minute),
   * `callback` = `/callback/*` and `/sso/callback/*` (default 100 per 10 s, which is what Better Auth's
   * global rule already gave them). The strict limit of the credential endpoints (`/sign-in/email`,
   * `/sign-up/*`: 3 per 10 s) is NOT affected, and cannot be changed here. See README, "Client IP and
   * rate limits".
   */
  oauthRateLimit?: OAuthRateLimit;
  /**
   * Name the cookies `__Host-<product>.*` instead of `__Secure-<product>.*`. Opt-in.
   *
   * A `__Secure-` cookie only has to be `Secure`, so any app on `*.qnsc.vn` can set
   * `__Secure-<product>.session_token` with `Domain=qnsc.vn` and the browser will send it here
   * (cookie tossing: fixing a victim's session id). A `__Host-` cookie cannot carry a `Domain` at all:
   * the browser refuses to store one from a sibling host, and ours is `Secure`, `Path=/`, host-only.
   * It covers every identity cookie (session, session cache, known-device, 2FA, OAuth state).
   *
   * Requires an https `baseURL`. Switching it on signs everyone out and forgets every known device
   * (the names change; the known-device HMAC covers the name) — but it does NOT end the old sessions
   * on the server: they stay valid under the old cookie name and come back if you switch back. Call
   * `revokeAllSessions(auth)` when you switch. `SameSite` stays `Lax` either way:
   * `Strict` would drop the cookie on the provider's redirect back to `/callback/*`, the one request
   * every OAuth sign-in lands on.
   */
  hostCookies?: boolean;
  /** Required with the `staff` preset. */
  staff?: StaffOptions;
  /** Optional with the `public` preset. */
  google?: GoogleOptions;
  hooks?: SsoHooks & {
    onUserCreated?: (user: User) => Promise<void> | void;
    /**
     * Runs on EVERY Microsoft staff sign-in, after the user exists (created or linked) and before the
     * session is returned. `claims.roles` is the Entra App Roles claim, validated as `string[]`
     * (`[]` when the token carries none). A throw FAILS the sign-in and no session is minted, so a
     * product can reconcile its roles here and trust that nobody signs in with stale ones. Refused
     * sign-ins (another tenant, a guest, an address off `staff.domains`) never reach it, and write
     * nothing. The hook itself needs the user, so a throw from it happens after Better Auth wrote the
     * user and the Microsoft account: when this request created them, and they hold nothing else and
     * no session, they are deleted again (best effort). `onUserCreated` has already run for that user.
     */
    onStaffSignIn?: (user: User, claims: StaffSignInClaims) => Promise<void> | void;
  };
  /** Security events (`observability` metrics, the audit table). Default: dropped. */
  events?: SecurityEventSink;
  /** Better Auth's warnings and errors (`observability` logger). Default: Better Auth's own console output. */
  logger?: IdentityLogger;
  onStorageDegraded?: StorageDegraded;
  /** End-to-end suites only: loads the passwordless `/test-login` (identity plan D17). */
  testLogin?: boolean;
  /** Environment; defaults to `process.env`. A test seam, not configuration. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Options that exist for the package's own tests and are NOT part of the public API: they are not on
 * `IdentityOptions`, and `createIdentityInternal` is exported only to `/testing`, never from the root.
 */
export interface InternalOptions {
  /**
   * Lets an SSO provider live on localhost over http (the mock IdP). Refused when NODE_ENV is
   * `production`; the conformance kit asserts the default policy.
   */
  unsafeTestNetwork?: boolean;
}

const MIN_SECRET_LENGTH = 32;

function config(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`identity: ${message}`);
}

// Stand-in for `mail` when no configured preset sends any (it is required with `public`). Nothing calls
// it; if something ever does, it fails loudly instead of dropping a message.
const noMail: { jobs: JobEnqueue; templates: AuthEmailTemplates } = {
  jobs: {
    send: () => {
      throw new Error('identity: `mail` is not configured, and no configured preset sends mail');
    },
  },
  templates: {
    verifyEmail: () => {
      throw new Error('identity: `mail` is not configured');
    },
    resetPassword: () => {
      throw new Error('identity: `mail` is not configured');
    },
  },
};

// What a product handed us, for helpers that take the built instance (purgeUnverifiedAccounts).
const internals = new WeakMap<
  object,
  {
    getContext: () => Promise<AccountContext>;
    sink: SecurityEventSink;
    cache: CacheService;
    /** Forget that a user was believed not banned (see `banned-guard.ts`). */
    forgetBan: (userId: string) => void;
    /** How many times the session store (Valkey) has failed so far; see `revokeAllSessions`. */
    degradedCount: () => number;
  }
>();

/**
 * Build the configured Better Auth instance. Every secure default of identity plan §5.4 is set here
 * and is not exposed as an option; what a product chooses is typed policy (presets, providers,
 * guests, origins, templates).
 */
export function createIdentity(o: IdentityOptions): Identity {
  return createIdentityInternal(o, {});
}

export function createIdentityInternal(o: IdentityOptions, internal: InternalOptions): Identity {
  const env = o.env ?? process.env;
  const production = env['NODE_ENV'] === 'production';
  const has = (p: Preset) => o.presets.includes(p);
  const publicPreset = has('public');
  const staffPreset = has('staff');
  const orgPreset = has('organizations');

  config(o.presets.length > 0, 'at least one preset is required');
  config(o.trustedOrigins.length > 0, 'trustedOrigins must not be empty');
  config(!staffPreset || o.staff, 'the staff preset needs `staff` (tenant, client, domains)');
  config(
    !publicPreset || o.mail,
    'the public preset sends verification and password-reset mail: `mail` (jobs and templates) is required',
  );
  const secret = env[DEFAULTS.secretEnv];
  config(
    secret && secret.length >= MIN_SECRET_LENGTH,
    `${DEFAULTS.secretEnv} must be set (32+ characters)`,
  );
  config(!production || o.baseURL.startsWith('https://'), 'baseURL must be https in production');
  // Exactly a boolean. `'true'` from an environment variable is a string and `=== true` would
  // quietly read it as off, leaving a product that believes it is on `__Host-` on `__Secure-`.
  config(
    o.hostCookies === undefined || typeof o.hostCookies === 'boolean',
    'hostCookies must be a boolean (a string such as "true" from an environment variable is not one)',
  );
  const hostCookies = o.hostCookies === true;
  config(
    !hostCookies || o.baseURL.startsWith('https://'),
    'hostCookies needs an https baseURL: a __Host- cookie must be Secure, and a browser refuses it over http',
  );
  config(!(production && internal.unsafeTestNetwork), 'unsafeTestNetwork is refused in production');
  const ring = orgPreset ? parseKeyring(env[DEFAULTS.encryptionKeyEnv]) : undefined;

  const sink = o.events ?? noopSink;
  const onSinkError = (e: unknown) => o.onStorageDegraded?.('events', e);
  const ssrf: SsrfPolicy = {
    ...defaultSsrfPolicy,
    allowLocalNetwork: internal.unsafeTestNetwork === true,
  };
  const staffDomainsError = staffDomainsProblem(o.staff?.domains ?? []);
  config(staffDomainsError === undefined, `staff.domains: ${staffDomainsError}`);
  // Matched as written: each entry exactly, `*.x.y` for the sub-domains of x.y (domains.ts).
  const staffDomains = normalizeStaffDomains(o.staff?.domains ?? []);
  // Reserved is wider than staff: the domain itself AND its sub-domains, whichever way it is written.
  const reservedStaffDomains = staffReservedDomains(staffDomains);
  let degraded = 0;
  const storage = valkeySecondaryStorage(o.cache, (operation, error) => {
    degraded += 1;
    o.onStorageDegraded?.(operation, error);
  });
  const mail = new AuthMail(
    o.mail?.jobs ?? noMail.jobs,
    o.mail?.templates ?? noMail.templates,
    perEmailLimiter(storage),
    o.logger ?? consoleLogger,
  );

  // Assigned once below; the closures that read it are built first and only run later.
  // eslint-disable-next-line prefer-const
  let auth!: Identity;
  const getContext = () => auth.$context as unknown as Promise<AccountContext>;
  const lookup = async (email: string) =>
    (await getContext()).internalAdapter.findUserByEmail(email.toLowerCase(), {
      includeAccounts: true,
    }) as Promise<{
      accounts: Array<{ providerId: string; accountId: string }>;
    } | null>;
  const isReserved = reservedDomainCheck({
    staffDomains: reservedStaffDomains,
    withSso: orgPreset,
    getContext,
  });
  const onVerifiedEmail = (email: string) => replaceUnverifiedAccount(getContext, sink, email);

  const sessionPolicy =
    staffPreset && !publicPreset ? DEFAULTS.session.staff : DEFAULTS.session.public;
  // A staff preset anywhere turns the cookie cache off: a revoked staff session must die on the
  // next request, and the cache is per instance.
  const cookieCache = sessionPolicy.cookieCache && !staffPreset;

  const database = drizzleAdapter(withTxCapture(o.db), {
    provider: 'pg',
    schema: o.schema,
    // Without this user and credential account are two autocommit statements, and the sign-up
    // verification mail cannot join the transaction (WP-9, D4).
    transaction: true,
  });

  const staffPolicy = { staffDomains, getContext };
  const classifier = staffPreset ? staffClassifier(staffPolicy) : undefined;
  const staffBecame = classifier ? staffBecameHooks(staffPolicy, classifier) : undefined;
  const refreshGuard = classifier ? staffRefreshGuard(staffPolicy, classifier) : undefined;
  const bannedGuard = bannedSessionGuard();

  const options = {
    appName: o.product,
    baseURL: o.baseURL,
    secret,
    // STATIC, on purpose. Origins derived from SSO provider rows would be attacker-controlled (an
    // organization registers a provider whose origin is its own) and would make every redirectTo /
    // callbackURL check, including the password-reset link, accept that origin. Better Auth's own
    // fetch-time check (public hosts only) covers discovery.
    trustedOrigins: [...o.trustedOrigins],
    telemetry: { enabled: false },
    // Better Auth's router prints an error it cannot answer to raw stderr (`# SERVER_ERROR`, with the
    // driver's message: statements, ids). With `throw` it rethrows instead, and `withErrorEnvelope` logs it
    // as class, cause and SQLSTATE through the injected logger and answers the hybrid 500. Errors it CAN
    // answer (`APIError`) are answered as before.
    onAPIError: { throw: true },
    // Impersonation is OFF in 8.0.0 (review S8). It returns in 8.1 with a required reason, a 1 h limit
    // and an audit record; until then the endpoints do not exist.
    disabledPaths: ['/admin/impersonate-user', '/admin/stop-impersonating'],
    logger: o.logger
      ? {
          level: 'warn',
          log: (level: string, message: string, ...args: unknown[]) => {
            // Better Auth hands the error it is reporting as an extra argument, and its message is
            // just the error's name: "Error". Describe the error by class and code (never by message).
            const error = args.find((a): a is Error => a instanceof Error);
            const fields = error ? { source: 'better-auth', ...errorFields(error) } : undefined;
            if (level === 'error') o.logger!.error(message, fields);
            else if (level === 'warn') o.logger!.warn(message, fields);
          },
        }
      : { level: 'error' },
    database: ring ? withEncryptedSsoSecrets(database, ring) : database,
    secondaryStorage: storage,
    rateLimit: {
      enabled: true,
      storage: 'secondary-storage',
      // Better Auth's own rules stay for everything else (3 / 10 s on the credential endpoints).
      customRules: oauthRateLimitRules(o.oauthRateLimit),
    },
    emailAndPassword: publicPreset
      ? {
          enabled: true,
          requireEmailVerification: true,
          minPasswordLength: DEFAULTS.password.minLength,
          maxPasswordLength: DEFAULTS.password.maxLength,
          revokeSessionsOnPasswordReset: DEFAULTS.reset.revokeSessions,
          resetPasswordTokenExpiresIn: DEFAULTS.reset.tokenTtlSeconds,
          password: argon2Password,
          sendResetPassword: (data: { user: User; url: string; token: string }) =>
            mail.sendPasswordReset(data),
        }
      : { enabled: false },
    emailVerification: {
      sendOnSignUp: publicPreset,
      sendOnSignIn: publicPreset,
      // Only with `mail`. Left UNSET when no preset sends any, so Better Auth answers
      // `/send-verification-email` with a 4xx ("not enabled") instead of a 500 from a placeholder.
      ...(o.mail
        ? {
            sendVerificationEmail: (data: { user: User; url: string; token: string }) =>
              mail.sendVerification(data),
          }
        : {}),
    },
    socialProviders: {
      ...(staffPreset
        ? { microsoft: microsoftProvider(o.staff!, { onVerifiedEmail, lookup }) }
        : {}),
      ...(publicPreset && o.google
        ? { google: googleProvider(o.google, { onVerifiedEmail, isReserved }) }
        : {}),
    },
    session: {
      expiresIn: sessionPolicy.expiresInSeconds,
      updateAge: sessionPolicy.updateAgeSeconds,
      cookieCache: { enabled: cookieCache, maxAge: DEFAULTS.session.cookieCacheSeconds },
      // Sessions live in Postgres too: a Valkey restart must not sign everyone out, and the `sso`
      // resolver requires database-backed sessions.
      storeSessionInDatabase: true,
    },
    // Verification rows (reset tokens, OAuth state) in the DATABASE, identifiers hashed.
    verification: { storeInDatabase: true, storeIdentifier: 'hashed' },
    account: {
      encryptOAuthTokens: true,
      // Automatic linking only for providers whose address is proven: the tenant, or a verified
      // domain (and then only for members of the provider's organization, see `ssoPlugin`).
      // No provider is trusted by NAME: Microsoft members come with `emailVerified: true`, which
      // links them, and guests come with `false`, which makes Better Auth refuse (review S3).
      accountLinking: { enabled: true, trustedProviders: [] },
    },
    advanced: {
      // Default: `__Secure-<product>.*`. With `hostCookies`: `__Host-<product>.*`. Better Auth only
      // knows the first prefix, so the second is made the cookie prefix itself and the automatic
      // `__Secure-` is turned off (a name cannot carry both). `Secure` is then set explicitly,
      // and Domain stays unset (cross-subdomain cookies are never enabled).
      useSecureCookies: !hostCookies,
      cookiePrefix: hostCookies ? `${DEFAULTS.cookies.hostPrefix}${o.product}` : o.product,
      ...(hostCookies ? { defaultCookieAttributes: { secure: true, path: '/' } } : {}),
      // EXPLICIT, never left to the default: Better Auth turns the origin/callback-URL check off
      // whenever NODE_ENV === 'test' (WP-9, D6).
      disableOriginCheck: false,
      disableCSRFCheck: false,
      ipAddress: { ipAddressHeaders: [DEFAULTS.clientIpHeader] },
      database: { generateId: () => uuidv7() },
    },
    databaseHooks: {
      ...(staffPreset
        ? {
            session: staffSessionHooks({
              staffDomains,
              getContext,
              onStaffSignIn: o.hooks?.onStaffSignIn as never,
              logger: o.logger ?? consoleLogger,
            }) as never,
          }
        : {}),
      ...(staffPreset ? { account: staffBecame!.account as never } : {}),
      user: {
        create: {
          after: async (user: User) => {
            // Before the product's hook: a refused staff sign-in removes the user THIS request created.
            rememberCreatedUser(user.id);
            await o.hooks?.onUserCreated?.(user);
          },
        },
        ...(staffPreset ? { update: staffBecame!.user.update as never } : {}),
      },
    },
    plugins: [
      ...(orgPreset
        ? [
            organization({ allowUserToCreateOrganization: o.allowOrganizationCreation === true }),
            ssoPlugin({ hooks: o.hooks, getContext, sink }),
            ssoRegistrationGuard({ staffDomains: reservedStaffDomains, ssrf }),
          ]
        : []),
      admin({ allowImpersonatingAdmins: false }),
      ...(publicPreset ? [twoFactor({ issuer: o.product })] : []),
      ...(refreshGuard ? [refreshGuard] : []),
      bannedGuard,
      accountLockout(sink),
      companyDomainSignUpGuard(isReserved),
      securityEvents(sink, onSinkError),
      ...(o.testLogin ? [testLogin(env)] : []),
    ],
  } satisfies BetterAuthOptions;

  auth = betterAuth(options) as unknown as Identity;
  // Guard `internalAdapter.findSession` as soon as the instance's context exists, not at the first
  // request: a product may call it directly (a socket gateway) before any request has run.
  void (auth.$context as Promise<object>).then(
    (context) => bannedGuard.install(context),
    () => undefined,
  );
  if (refreshGuard) {
    void (auth.$context as Promise<object>).then(
      (context) => refreshGuard.install(context),
      () => undefined,
    );
  }
  // The organization and its owner commit together (identity#206), for both entry points.
  let handler = auth.handler;
  if (orgPreset) {
    prepareAtomicOrganizationCreate(auth);
    makeCreateOrganizationAtomic(auth);
    handler = withAtomicOrganizationCreate(handler, auth, AUTH_BASE_PATH);
  }
  auth.handler = withErrorEnvelope(
    withCallbackErrorCodes(withTimingFloor(handler, AUTH_BASE_PATH)),
    o.logger ?? consoleLogger,
  );
  internals.set(auth, {
    getContext,
    sink,
    cache: o.cache,
    forgetBan: bannedGuard.forget,
    degradedCount: () => degraded,
  });
  return auth;
}

/**
 * Delete unverified accounts older than 72 hours that never held a session and have no social or SSO
 * account (identity plan D20). Each product schedules this with `platform-jobs`; until WP-7 lands,
 * with `ExclusiveJob`. Safe to run concurrently. Returns how many accounts were deleted.
 */
export function purgeUnverifiedAccounts(
  auth: Identity,
  options: { now?: Date } = {},
): Promise<number> {
  const internal = internals.get(auth);
  if (!internal)
    throw new Error('identity: purgeUnverifiedAccounts needs an instance from createIdentity()');
  return purgeWith(internal.getContext, internal.sink, options);
}

/**
 * The session store (Valkey) cannot be written, so sessions cannot be revoked completely.
 *
 * Sessions are served from Valkey FIRST and from Postgres only when Valkey has no copy. While Valkey
 * is down, its deletes are silent no-ops (the storage degrades, `onStorageDegraded` fires): rows deleted
 * from Postgres would leave the cached copies behind, and they would come back to life when Valkey
 * recovers. So nothing is revoked until the store can take the deletes.
 */
export class SessionStoreUnavailableError extends Error {
  override readonly name = 'SessionStoreUnavailableError';
}

type Internal = NonNullable<ReturnType<typeof identityInternals>>;
type PurgeContext = {
  options: {
    secondaryStorage?: {
      get(key: string): Promise<unknown>;
      delete(key: string): Promise<void>;
    };
  };
  adapter: {
    findMany(args: {
      model: string;
      limit: number;
      where?: Array<{ field: string; value: unknown }>;
    }): Promise<Array<{ token?: unknown }>>;
  };
  internalAdapter: {
    deleteSessions(tokens: string[]): Promise<unknown>;
    findUserById(id: string): Promise<{ id: string } | null>;
    updateUser(id: string, data: Record<string, unknown>): Promise<unknown>;
  };
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Ids are UUIDs (`uuidv7()` for everything identity creates). Checked up front so that a malformed id
 * is a plain error here and never reaches PostgreSQL, whose `invalid input syntax for type uuid` would
 * surface as a raw driver error quoting the value.
 */
function assertUserId(userId: unknown, operation: string): asserts userId is string {
  if (typeof userId !== 'string' || !UUID.test(userId)) {
    throw new TypeError(`identity: ${operation}: userId must be a UUID`);
  }
}

function internalOf(auth: Identity, operation: string): Internal {
  const internal = internals.get(auth);
  if (!internal) throw new Error(`identity: ${operation} needs an instance from createIdentity()`);
  return internal;
}

function sessionStoreUnavailable(operation: string, detail: string) {
  return new SessionStoreUnavailableError(
    `identity: ${operation}: the session cache is not available (${detail}). Cached sessions would survive and come back when it recovers, so nothing more was revoked; run it again when the cache is healthy.`,
  );
}

/**
 * Delete sessions from the cache FIRST, verified, then from Postgres, in batches of 500: of one user
 * (`userId`) or of everyone. Stops, leaving the rows of the failing batch for a re-run, if the cache
 * fails. Returns how many sessions it ended.
 */
async function purgeSessions(
  internal: Internal,
  operation: string,
  userId?: string,
): Promise<number> {
  if (!internal.cache.isAvailable) throw sessionStoreUnavailable(operation, 'not connected');
  const ctx = (await internal.getContext()) as unknown as PurgeContext;
  const where = userId === undefined ? {} : { where: [{ field: 'userId', value: userId }] };
  let revoked = 0;
  let previous = '';
  for (;;) {
    const rows = await ctx.adapter.findMany({ model: 'session', limit: 500, ...where });
    const tokens = rows.map((r) => r.token).filter((t): t is string => typeof t === 'string');
    // The database decides when it is done; a batch that did not go away would loop forever.
    if (tokens.length === 0 || tokens[0] === previous) break;
    previous = tokens[0]!;
    // The cache first, and verified: a failed delete is swallowed by the storage (it counts it), and
    // the rows must stay in Postgres so that a re-run finds them.
    const failuresBefore = internal.degradedCount();
    await Promise.all(tokens.map((token) => ctx.options.secondaryStorage?.delete(token)));
    if (internal.degradedCount() !== failuresBefore || !internal.cache.isAvailable) {
      throw sessionStoreUnavailable(operation, `${revoked} revoked before it failed`);
    }
    await ctx.internalAdapter.deleteSessions(tokens);
    revoked += tokens.length;
  }
  if (userId !== undefined) {
    // The per-user list Better Auth keeps next to the sessions is a SECOND source of tokens: a session
    // whose Postgres row is already gone (a revoke that ran while the cache was degraded) can still be
    // served from Valkey. Delete those copies too, verified, and count what actually existed.
    const storage = ctx.options.secondaryStorage;
    const listKey = `active-sessions-${userId}`;
    const failuresBefore = internal.degradedCount();
    const raw = await storage?.get(listKey);
    const listed = new Set<string>();
    try {
      const entries: unknown = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (Array.isArray(entries)) {
        for (const entry of entries) {
          const token = (entry as { token?: unknown } | null)?.token;
          if (typeof token === 'string') listed.add(token);
        }
      }
    } catch {
      /* an unreadable list is deleted below */
    }
    for (const token of listed) {
      if ((await storage?.get(token)) == null) continue; // nothing cached under it
      await storage?.delete(token);
      revoked += 1;
    }
    await storage?.delete(listKey);
    if (internal.degradedCount() !== failuresBefore || !internal.cache.isAvailable) {
      throw sessionStoreUnavailable(operation, `${revoked} revoked before it failed`);
    }
  }
  return revoked;
}

/**
 * Revoke EVERY session of every user, in the database and in the cache. Call it when the session
 * policy of a running system changes: adding the `staff` preset, or moving from `public + staff` to
 * `staff` only. Sessions issued under the old policy would otherwise live on the old lifetime;
 * the read-time cap ends staff ones within 12 h of their creation, this ends them now. Everyone
 * signs in again. Returns how many sessions were revoked. Safe to re-run.
 *
 * **Refuses to run while the cache is unavailable** (throws {@link SessionStoreUnavailableError}
 * before deleting anything), and stops, without touching the database for that batch, if the cache
 * fails during the run. Re-run it when the cache is healthy: what it already revoked stays revoked.
 */
export async function revokeAllSessions(auth: Identity): Promise<number> {
  return purgeSessions(internalOf(auth, 'revokeAllSessions'), 'revokeAllSessions');
}

/**
 * Revoke every session of ONE user, service side (no admin session needed): offboarding, a suspected
 * compromise. Deletes them in the cache and in Postgres and ends the user's remembered devices (the
 * known-device cookie of a password user). Effective on the next request, also for the staff preset,
 * which has no cookie cache; with the public cookie cache a session can still be believed for up to
 * 5 minutes. Returns how many sessions it ended (0 for an unknown user). Safe to re-run.
 *
 * Same rule as {@link revokeAllSessions}: **refuses while the cache is unavailable**
 * ({@link SessionStoreUnavailableError}, before deleting anything), and stops leaving the rows for a
 * re-run if the cache fails during the run.
 */
export async function revokeUserSessions(auth: Identity, userId: string): Promise<number> {
  assertUserId(userId, 'revokeUserSessions');
  const internal = internalOf(auth, 'revokeUserSessions');
  const revoked = await purgeSessions(internal, 'revokeUserSessions', userId);
  const ctx = (await internal.getContext()) as unknown as PurgeContext;
  // Moving `user.updatedAt` is what invalidates the known-device cookies (README, lockout).
  if (await ctx.internalAdapter.findUserById(userId)) {
    await ctx.internalAdapter.updateUser(userId, { updatedAt: new Date() });
  }
  await emitSafely(internal.sink, { name: 'sessions.revoked', userId, detail: { count: revoked } });
  return revoked;
}

/**
 * Ban or unban a user, service side (no admin session needed). A banned user cannot sign in (Better
 * Auth's admin plugin refuses the session, for every provider) and every session they hold is ended
 * as {@link revokeUserSessions} does. `reason` is stored in `user.ban_reason` as given (at most 500
 * characters): keep personal data out of it.
 *
 * **Cookie cache:** with the `public` preset's cookie cache (5 minutes), a banned user's session COOKIE can
 * still be believed for up to that window, because the cache answers before the session is looked up;
 * the session itself is gone at once and a new request that reaches the store is refused. The `staff`
 * preset has no cookie cache. A session minted by a sign-in already in flight when the ban ran is refused
 * on its first use (the user is checked when a session is read, at most 30 s stale per process).
 *
 * Banning **refuses while the cache is unavailable**, before changing anything. If the cache then
 * fails DURING the revoke, the ban is already in place (the user cannot sign in again) and
 * {@link SessionStoreUnavailableError} is thrown: call {@link revokeUserSessions} when the cache is
 * healthy. Unbanning touches no session and does not need the cache. Throws for an unknown user.
 */
export async function setUserBanned(
  auth: Identity,
  userId: string,
  banned: boolean,
  reason?: string,
): Promise<void> {
  assertUserId(userId, 'setUserBanned');
  const internal = internalOf(auth, 'setUserBanned');
  if (banned && !internal.cache.isAvailable) {
    throw sessionStoreUnavailable('setUserBanned', 'not connected');
  }
  const ctx = (await internal.getContext()) as unknown as PurgeContext;
  if (!(await ctx.internalAdapter.findUserById(userId))) {
    throw new Error('identity: setUserBanned: no such user');
  }
  await ctx.internalAdapter.updateUser(userId, {
    banned,
    banReason: banned ? (reason?.slice(0, 500) ?? null) : null,
    banExpires: null,
    updatedAt: new Date(),
  });
  internal.forgetBan(userId);
  if (!banned) return;
  await emitSafely(internal.sink, { name: 'admin.user_banned', userId });
  await revokeUserSessions(auth, userId);
}

export function identityInternals(auth: Identity) {
  return internals.get(auth);
}
