# @quynhonsemiconductor/identity

One authentication system for every QNSC product backend, built on [Better Auth](https://better-auth.com).
Staff sign in with Microsoft Entra, public users with email + password or Google, partner organisations with
their own OIDC identity provider. The package owns the **mechanism** and its secure defaults; roles,
permissions, UI, email text and cookie names stay in the product (`docs/ADMISSION-TEST.md`).

**v8 is a breaking rewrite.** The Passport/JWT strategy, refresh-token service, BFF flow, Entra verifier and
`oidc/` broker are gone. See [MIGRATION-v7-to-v8.md](./MIGRATION-v7-to-v8.md).

Decisions and evidence: [ADR 0002](../../docs/adr/0002-identity-v8-better-auth.md) (the WP-9 spike and the
platform lead's decisions) and the identity v8 plan.

## Behaviour changes on a minor upgrade (read before upgrading to 8.2)

> **A staff member whose UPN is not on a `staff.domains` entry can no longer sign in.** `staff.requireUpnOnStaffDomain` is **on by
> default** from 8.2: a member's `upn` (else `preferred_username`) must match an **exact** `staff.domains` entry (`*.` entries
> match sub-domains). A member on `*.onmicrosoft.com`, a break-glass or service account, or any suffix you did not list is refused
> after the upgrade, with `?error=UPN_NOT_ON_STAFF_DOMAIN`, a `staff.upn_refused` event and a warning that names the **UPN
> suffix** (a domain, never the person), so the fix is one line:
>
> - add the suffix to `staff.domains` (preferred: it is a domain you verified in the tenant), or
> - set `staff.requireUpnOnStaffDomain: false` (opt-out; say why in the code).
>
> **Check before you deploy:** list your members' UPN suffixes in Entra and compare with `staff.domains`.
>
> Also new in 8.2: a Microsoft sign-in is **refused** (`MICROSOFT_IDENTITY_CHANGED`) when its address matches a user that already
> holds a _different_ Microsoft identity (recycled mailbox, edited `mail`); an administrator relinks on purpose with
> `unlinkMicrosoftAccount` ([below](#per-user-controls-revokeusersessions-setuserbanned-unlinkmicrosoftaccount)). A Microsoft
> identity that already has its own account is never refused for this.

## Migration from 7.x

[MIGRATION-v7-to-v8.md](./MIGRATION-v7-to-v8.md) lists what is removed, what to add (dependencies, environment,
tables, Entra settings), the data mapping with a SQL template, and the behaviour changes to design for.

## Install

```ini
# .npmrc
@quynhonsemiconductor:registry=https://npm.pkg.github.com
```

The token (`read:packages`) goes in your **user-level** `~/.npmrc`, **not** in this file: pnpm 11 ignores a token
in a project `.npmrc`. See [Authenticating to GitHub Packages](../../README.md#authenticating-to-github-packages).

```bash
pnpm add @quynhonsemiconductor/identity
```

Better Auth is a **dependency of this package, pinned exactly**. Products never import `better-auth`
themselves (one place to upgrade; every bump runs the conformance kit). It is ESM-only; this CommonJS
package loads it through `require(esm)`, which needs Node >= 22.12 (the repo is >= 24).

Peers: `@quynhonsemiconductor/platform-cache`, `platform-db`, `platform-http`, `drizzle-orm`, `pg`; for `/nest`:
`@nestjs/common`, `@nestjs/core`, `fastify`; optional `observability`, `ioredis`.

### Keeping Better Auth's optional peers out of the runtime image

Better Auth 1.7.7 declares **18 optional peer dependencies** (`drizzle-kit`, `vitest`, `react`, `react-dom`, `next`, `prisma`,
`mongodb`, `mysql2`, `svelte`, `vue` ...): its CLI, its framework clients, its test helpers, the databases it can run on. Identity
uses two of them, `drizzle-orm` and `pg`. pnpm resolves an optional peer against whatever the importing project has installed, so
a product with `vitest` or `drizzle-kit` in its `devDependencies` gets them written into Better Auth's lockfile entry as
`optionalDependencies`, and `pnpm install --prod` **follows optional dependencies**. The runtime image then holds vitest,
drizzle-kit and their trees (vite, rolldown, esbuild with its Go binary): that is how a Trivy CRITICAL on esbuild
(CVE-2025-68121) reached opshub's image. Any other of the 18 that a product happens to have installed leaks the same way.

Add this `.pnpmfile.cjs` at the root of the product, next to `pnpm-workspace.yaml`. It is the file the package ships
(`node_modules/@quynhonsemiconductor/identity/pnpmfile.cjs`, which also carries a header comment; a test keeps this snippet, that
file and the reference consumer's copy identical):

```js
const KEPT_PEERS_OF_BETTER_AUTH = ['drizzle-orm', 'pg'];

function readPackage(pkg) {
  if (pkg.name === 'better-auth') {
    for (const peer of Object.keys(pkg.peerDependencies ?? {})) {
      const optional = pkg.peerDependenciesMeta?.[peer]?.optional === true;
      if (optional && !KEPT_PEERS_OF_BETTER_AUTH.includes(peer)) {
        delete pkg.peerDependencies[peer];
        delete pkg.peerDependenciesMeta[peer];
      }
    }
  }
  return pkg;
}

module.exports = { hooks: { readPackage } };
```

It drops **every optional peer of Better Auth except `drizzle-orm` and `pg`**, not a fixed list of four: the other fourteen would
leak the same way, and a list would need a new entry whenever Better Auth adds a peer. It never touches a peer that is _not_
optional, so a future Better Auth that really requires something keeps it. Identity pins Better Auth exactly and runs its
conformance kit on every bump.

Then, once:

1. `pnpm install` (changing the file changes the lockfile; commit both).
2. **Every Docker stage that runs `pnpm install --frozen-lockfile` copies the file** (`COPY ... .npmrc .pnpmfile.cjs ./`).
   A frozen install checks the file's checksum against the lockfile: a stage that forgot it fails with
   `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH`, loudly, rather than shipping the tools.
3. Check: `pnpm install --frozen-lockfile --prod`, then `pnpm why esbuild vitest --prod` prints nothing, and
   `ls node_modules/.pnpm | grep -E '^(vitest|esbuild|drizzle-kit)@'` is empty. Better, assert it in CI for **every
   devDependency**, not these names: none may appear in `pnpm ls --prod --depth Infinity` (`@types/*` excepted: declaration
   files that `drizzle-orm` and others list as optional peers). `reference-consumer/check-prod-tree.sh` is a worked example.
4. **Keep your copy from drifting** from the shipped one when you bump identity:
   `cmp .pnpmfile.cjs node_modules/@quynhonsemiconductor/identity/pnpmfile.cjs` (a CI step; a difference means a new Better Auth
   peer or a changed rule). The header comment is part of the shipped file, so copy the file rather than the snippet.

**Which pnpm.** The leak happens on **pnpm 10.33.2**, the version opshub's Dockerfile pins; the file is **required** there.
pnpm 11.28.5 (rova's `packageManager`) did not put these into a `--prod` install in the tests below even without the file, so
on pnpm 11 it is defensive: it makes the lockfile say what the image holds, and keeps the product safe if it ever builds an
image on pnpm 10 or a later pnpm changes the default. A check that installs with pnpm 11 only cannot fail, which is why the
reference consumer's check runs both versions and a negative control (pnpm 10 without the file must leak).

**A tool that passes `--ignore-pnpmfile`** (Renovate's hosted app might; not verified here) re-resolves the lockfile without the
hook. On pnpm 10 that drops `pnpmfileChecksum` and brings the peers back (checked: `pnpm install --lockfile-only
--ignore-pnpmfile` on the reference consumer), and the next frozen install, which uses the file, fails with the same
`ERR_PNPM_LOCKFILE_CONFIG_MISMATCH`: a failed build, not a quietly fat image. Re-run `pnpm install` on the PR. On pnpm 11 the
checksum was kept.

Verified on a scratch project with `vitest`, `drizzle-kit`, `react` and `react-dom` (esbuild `0.18`, `0.25` and `0.28` in the
`--prod` tree on pnpm 10 without the file, none with it), and in the repository's `reference-consumer/` (vitest, vite and
rolldown in the pnpm 10 `--prod` tree without it, none with it; CI runs `check-prod-tree.sh` on every run). What was tried
instead, and why it is not the fix:

- **`overrides: { "better-auth>vitest": "-" }`** (in `pnpm-workspace.yaml` or `package.json`) removes the entry on pnpm 11 and
  does nothing on pnpm 10.33.2, and it is a list too.
- **`packageExtensions`** can add to a package's manifest but not remove a peer.
- **`auto-install-peers=false`** changes nothing: these peers are not auto-installed, they are matched to what the project has.
- **`pnpm install --prod --no-optional`** drops every optional dependency, including the platform binaries of
  `@node-rs/argon2` (identity's password hashing), which that package delivers as optional dependencies (13 of them in its
  manifest). Not run; it follows from the manifest, and it is not worth finding out in production.
- In a workspace where the dev tools live at the **root** and Better Auth in a package, `resolve-peers-from-workspace-root=false`
  also keeps them apart, but only for that layout.

Accepted cost: a product with the pnpmfile cannot use `better-auth/react`, `better-auth/test`, a framework client or the
`auth generate` CLI from the same install, because the peers they need are not resolved. Identity does not use them; if a
product needs one, add its name to `KEPT_PEERS_OF_BETTER_AUTH`, re-install, and accept the matching entry in the image.

## Subpaths

| Import                                   | What                                                                                    |
| ---------------------------------------- | --------------------------------------------------------------------------------------- |
| `@quynhonsemiconductor/identity`         | Framework-agnostic: `createIdentity`, `purgeUnverifiedAccounts`, ports, `DEFAULTS`      |
| `@quynhonsemiconductor/identity/nest`    | `IdentityModule`, global `SessionGuard`, `@Public()`, `@CurrentSession()`, error filter |
| `@quynhonsemiconductor/identity/testing` | The conformance kit, a test client, a mock IdP, the reference schema                    |

## Environment

Secrets and keys come from the environment only.

| Variable                  | Required when          | Meaning                                                                                                                                                              |
| ------------------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BETTER_AUTH_SECRET`      | always                 | 32+ characters. Signs cookies and encrypts 2FA secrets and OAuth tokens. Key Vault -> External Secrets                                                               |
| `IDENTITY_ENCRYPTION_KEY` | `organizations` preset | 32 random bytes, base64 (`openssl rand -base64 32`). Encrypts SSO client secrets at rest. Rotation: `v2=<b64>,v1=<b64>` (encrypt with the highest, decrypt with any) |
| `IDENTITY_TEST_LOGIN`     | end-to-end suites only | `enabled` loads `/test-login`, and only when `NODE_ENV` is exactly `test` or `development`                                                                           |
| `NODE_ENV`                | —                      | `production` requires an `https` `baseURL`                                                                                                                           |

## What a product writes

```ts
// apps/api/src/auth.ts
export const auth = createIdentity({
  product: 'lms',
  db, // the product's Drizzle instance (platform-db DATABASE_TOKEN)
  schema: identitySchema, // the product's auth tables, generated (see "Tables")
  cache, // platform-cache CacheService
  baseURL: env.PUBLIC_API_URL,
  trustedOrigins: [env.WEB_ORIGIN],
  presets: ['public', 'staff', 'organizations'],
  mail: { jobs, templates }, // platform-jobs / platform-mail; required with `public`, optional without (staff, organizations)
  staff: { tenantId, clientId, clientSecret, domains: ['qnsc.vn'], allowGuests: false }, // each domain exact; '*.qnsc.vn' opts into sub-domains
  google: { clientId, clientSecret },
  hooks: { onUserCreated, onStaffSignIn, onSsoProvisioned, ssoRole },
  hostCookies: true, // optional: `__Host-` cookie names (see "Session cookies")
  oauthRateLimit: { start: { windowSeconds: 60, max: 120 } }, // optional: the redirect endpoints (see "Client IP and rate limits")
  events, // security events -> observabilitySecurityEvents(logger) / audit
  logger, // Better Auth warnings and errors -> identityLoggerFrom(logger)
});
```

```ts
@Module({
  imports: [
    CacheModule.forRoot({/* … */}),
    DatabaseModule.forRootAsync({ schema: identitySchema }),
    IdentityModule.forRootAsync({
      inject: [DATABASE_TOKEN, CacheService, JOBS],
      useFactory: (db, cache, jobs) => createIdentity({/* … */}),
    }),
  ],
  providers: [
    // Order matters: Nest asks the LAST registered global filter first.
    { provide: APP_FILTER, useClass: GlobalExceptionFilter },
    { provide: APP_FILTER, useClass: AuthApiErrorFilter },
  ],
})
export class AppModule {}
```

The module mounts `auth.handler` on `/api/auth/*` as an encapsulated Fastify plugin that receives the raw body
(so form posts from SSO work) and leaves the rest of the app's parsers alone. It writes the client address,
resolved with `clientIp()` (a verified signed edge address first when `EDGE_CLIENT_IP_SECRET` is set, then
`cf-connecting-ip`; contract §8), into the one header Better Auth reads, discarding any the client sent.

**`/api/auth/*` follows Better Auth's wire protocol, plus the platform error envelope next to it.** `better-auth/client`,
which product frontends use, reads the top-level `code` and `message` of an error body and the HTTP status, so none of
those change. Every response of 400 or above also carries contract §7's envelope in an additive `error` field:

```json
{
  "code": "INVALID_EMAIL_OR_PASSWORD",
  "message": "Invalid email or password",
  "error": {
    "code": "INVALID_EMAIL_OR_PASSWORD",
    "message": "Invalid email or password",
    "details": [],
    "correlationId": "…"
  }
}
```

- **4xx:** Better Auth's status and its own fields are untouched (a missing `code`/`message` is added from the status);
  `error.code`/`error.message` repeat them, and `correlationId` is the request's (`unknown` if none was seeded). Its
  request-body validation (400 `VALIDATION_ERROR`) stays 400 and is `error.code: VALIDATION_FAILED` with the issues in
  `error.details`. A body that already has an `error` key (an OAuth-style `{ error, error_description }`) is left as it is.
- **5xx:** `code` and `error.code` are `INTERNAL_ERROR` and the message is the fixed "An unexpected error occurred", at the top
  level too, never an empty body; nothing Better Auth said about the failure is on the wire (it is in the log).
- Redirects (the OAuth and SSO callbacks) and successes are untouched.
- **`AuthApiErrorFilter` is a different path on purpose.** It maps an error raised through `auth.api.*` inside your own
  controller to a `DomainException`, and so answers the platform envelope alone with the platform's statuses (an
  unrecognised 4xx is 422). The mounted routes keep Better Auth's statuses (that 4xx is 400) because Better Auth's clients
  expect them. The same condition can therefore be a 400 on `/api/auth/*` and a 422 from your controller.

Better Auth's router no longer prints errors on raw stderr (`# SERVER_ERROR`, which carried the driver's message): identity makes it rethrow what it cannot answer, and logs one structured line instead (`identity.auth_handler_threw`, or `identity.auth_server_error` with the status and Better Auth's code for a 5xx it raised itself). **Dashboards and alerts keyed on the old COMMIT-failure line (message `Error`, `source: better-auth`) must change to the `code` field `identity.auth_handler_threw`** (same `error`, `cause`, `errorCode`, `correlationId` fields).

A 500 from Better Auth is logged with the error's **class and code** (`error: "DrizzleQueryError"`, `cause`, `errorCode`:
the SQLSTATE) and the request's `correlationId`, never its message, which a database error fills with the statement or the row.

Every route needs a session unless it is `@Public()`. Authorization stays in the product's guard, which reads
`@CurrentSession()` / `@CurrentUser()`.

### Presets

| Preset          | Enables                                                                                                              |
| --------------- | -------------------------------------------------------------------------------------------------------------------- |
| `public`        | Email + password with verification, reset, Google, TOTP two-factor                                                   |
| `staff`         | Microsoft Entra restricted to the QNSC tenant (`tid` checked), no password endpoints, 12 h sessions, no cookie cache |
| `organizations` | Organizations, OIDC SSO per organization with verified domains and provisioning, encrypted secrets                   |

The `admin` plugin is always on, **without impersonation** (the endpoints do not exist in 8.0.0; 8.1 brings them back with
a required reason, a 1 h limit and an audit record). Passkeys, the `jwt` plugin, SAML and `contextId` are not in 8.0.0.

Better Auth's lifetime is per instance, so in an instance with both `staff` and `public` sessions are written with the
public lifetime and **the 12 h staff cap is enforced where sessions are written** (`session.create.before` and
`session.update.before`, so Better Auth's own endpoints honour it and a refresh cannot stretch it). Staff means a user
with a Microsoft account or an email on `staff.domains`. A staff session at its cap is never refreshed (Better Auth would
ask for a refresh on every read, and the clamp would write the same expiry back): reading it costs no database write, no
Valkey write and no `Set-Cookie`. The cookie cache is off whenever `staff` is present.

The cap is also enforced **when a session is read**, not only when one is refreshed: a staff session older than 12 h is
dead on its next read (`get-session`, `list-sessions`, the guard) whatever expiry it stores. That matters for a session that
was issued on the public lifetime and whose owner is staff _now_. A user **becomes staff** when a Microsoft account is
linked or when their email moves onto `staff.domains`; at that moment the sessions they hold that are not staff-shaped
(a stored expiry beyond `createdAt + 12 h`) are revoked, so they sign in again as staff, and their capped sessions are
left alone. **The same limit applies to that revocation**: it runs inside the request that linked the account or moved the
email, so it cannot refuse; if the cache is degraded at that moment (the signal is `onStorageDegraded`) the rows go from
Postgres but the cached copies stay, and come back when Valkey recovers. They are still staff sessions on a public
lifetime, so the read-time cap ends them within 12 h of their creation (`revokeAllSessions` cannot reach them: their rows are
already gone, so flush the product's cache keys for the user if that window matters); alert on `onStorageDegraded` if it
does. `list-sessions` and the admin's
`list-user-sessions` do not list a staff session past its cap as active. The staff test costs nothing in a session's first 12 h or for a staff-domain email; for anyone else it is one
`account` lookup, remembered per process for 30 s.

**Changing the presets of a running system** (adding `staff`, or moving from `public + staff` to `staff` only) does not
end the sessions issued under the old policy by itself. Staff ones end within 12 h of their creation; to end every session
now, call `revokeAllSessions(auth)` once at deploy. It deletes them in Postgres and in Valkey, returns how many it ended,
and everyone signs in again. **It refuses to run while the cache is unavailable** (it throws `SessionStoreUnavailableError`
before deleting anything) and stops, leaving the rows for a re-run, if the cache fails during the run: sessions are served
from Valkey first, Valkey's deletes are silent no-ops while it is down (`onStorageDegraded` fires), so rows deleted from
Postgres alone would leave cached sessions that come back to life when Valkey recovers. Run it again when the cache is
healthy; what it already revoked stays revoked:

```ts
import { createIdentity, revokeAllSessions } from '@quynhonsemiconductor/identity';

const auth = createIdentity({ ...options, presets: ['public', 'staff'] });
console.log(`revoked ${await revokeAllSessions(auth)} sessions`);
```

Organization creation is closed (`allowOrganizationCreation`, default `false`): organizations are created by the product,
because an organization owner can register an SSO provider.
**Creating an organization is atomic** (identity#206): the organization row and its owner's `member` row are written in one
transaction, through `auth.api.createOrganization` and through `POST /api/auth/organization/create` alike, so a failure of
the second (a grant, a deadlock, a throwing hook) leaves no organization behind and its slug stays free; over HTTP the
answer is the usual hybrid `500`. `setActiveOrganization` is inside the same transaction. Better Auth's handler resets the
current adapter at the start of every request, so the context's adapter is wrapped in a thin proxy that follows the
transaction while an organization is being created; a server-side call runs the same `runWithAdapter` the handler does, so
it never takes a second connection (it holds one, also with a pool of one). A transaction is only opened for a request
whose session resolves: anonymous requests acquire no connection.

### The principal in the request context, and the `principal` hook

`SessionGuard` writes **who the caller is** into the request context (`observability`'s store, seeded by `enableCorrelationId`):
`userId` and `sessionId` (the session's id, never its token). `platform-http`'s rate limit, idempotency key, access log and
exception filter read the user from there, so a product needs no session-principal bridge. Needs `observability` >= 0.2.3.
**`RateLimitGuard` must run AFTER `SessionGuard`, and a guard declared in the root module runs BEFORE the imported modules'.** Put it in a module of its own, imported after `IdentityModule`:

```ts
// rate-limit.module.ts: RateLimitGuard in a module of its own
@Module({ providers: [{ provide: APP_GUARD, useClass: RateLimitGuard }] })
export class RateLimitModule {}

// app.module.ts: IdentityModule first, RateLimitModule AFTER it
@Module({
  imports: [
    CacheModule.forRoot(/* ... */),
    IdentityModule.forRootAsync(/* ... */), // SessionGuard: authenticates, writes the principal
    RateLimitModule, //                         RateLimitGuard: reads it
  ],
  // NOT here: providers: [{ provide: APP_GUARD, useClass: RateLimitGuard }]
})
export class AppModule {}
```

If it is the other way round the whole NAT shares one bucket, and `SessionGuard` logs one warning saying so (it also warns once when there is no request context to write to). To add what only the product knows, pass `principal` to `IdentityModule.forRootAsync`:

```ts
IdentityModule.forRootAsync({
  inject: [DATABASE_TOKEN, CacheService, JOBS],
  useFactory: (db, cache, jobs) => createIdentity({ /* ... */ }),
  principal: (session) => ({
    workspaceId: workspaceOf(session.user), // goes on every log line as workspaceId
    fields: { role: roleOf(session.user) }, // at most 8: [a-z][A-Za-z0-9_.]{0,39}, string/number/boolean
  }),
}),
```

`principal` can also be `{ inject: [WorkspaceService], useFactory: (workspaces) => (session) => ({ workspaceId: workspaces.of(session.user.id) }) }` to build the hook from the application's providers; `PRINCIPAL_HOOK` is exported for tests. The hook runs after the session is resolved, on authenticated routes only; it can add a workspace and fields but **cannot overwrite `userId` or `sessionId`**. It is for observability, **never authorization**
(keep that in your own guard). If it throws or returns something invalid, the request continues with the user and session ids
alone and one warning (the error class, never its message) is logged. Without `enableCorrelationId` there is no context to
write to: authentication works and nothing is recorded.

### Entra claims at sign-in: `hooks.onStaffSignIn`

`onStaffSignIn(user, { oid, tid, email, guest, roles })` runs on **every** Microsoft staff sign-in, after the user exists (created or
linked) and **before the session is returned**.

- `roles` is the Entra **App Roles** claim validated as `string[]`: `[]` when the token carries none (or a claim of the wrong
  shape), entries that are not non-empty strings are dropped, duplicates removed.
- `guest` says whether the token is for a **B2B guest** of the tenant (`acct = 1`, an `idp` other than the issuer, or `#EXT#` in the
  UPN). It can only be `true` when `staff.allowGuests` is set; otherwise guests are refused before the hook.
- **A throw refuses the sign-in**: the browser is redirected back with `?error=STAFF_SIGN_IN_REFUSED`, and no session row, cookie
  or cache entry exists.
- **The user this sign-in created is removed again.** The hook is given the user, so it runs once Better Auth has written the
  user and the Microsoft account (one transaction; the session is a separate step). When the hook refuses, identity deletes
  them if **this request created the user**, the user holds **nothing but this Microsoft account**, and has **no session**: a
  person the product refused leaves no row, so a later, legitimate sign-in of the same person is a first sign-in again (an
  offboarded person who is reinstated is not stuck behind a stale user). A user who was already there is never touched, nor is
  one with another account or a session. The check and the delete run in **one database transaction** (and the check is repeated inside it, on the database's own
  rows, not only the cache), so a delete that fails part-way rolls back instead of leaving a bare user with no account, and a
  session created in the meantime stops the delete. It is best effort: if the delete fails, the failure is logged (class and code)
  and the sign-in is refused all the same. Two limits: **`hooks.onUserCreated` already ran** for that user and nothing undoes what the
  product did in it, so make it idempotent (or do the work in `onStaffSignIn`, where a refusal can still be observed); and
  between the check and the delete a concurrent sign-in of the same new person could, in theory, gain a session that the delete
  then removes with the user (the person signs in again).
- **Keep the hook for what needs your data.** Put every rule identity can decide from the token (domain, tenant, guest) in
  `staff` options, where it is refused with nothing written.
- **The product's error message is on neither the wire nor the logs.** One `identity.staff_sign_in_refused` line carries the
  error's class and code only.
- **It cannot be skipped.** The Microsoft provider takes the authorization-code flow only: the id_token sign-in
  (`signInSocial({ idToken })`) is disabled, because it accepts any token valid for the client id with no nonce and would mint
  a session around the hook. And if a Microsoft session is ever about to be created with no claims recorded for the request, or
  for a user who does not hold the token's `oid`, it is refused, not minted.
- It is never called for a refused sign-in (another tenant, a B2B guest when `allowGuests` is false, an address off
  `staff.domains`), for password or Google sign-in, for SSO, or for `/test-login`.

### Per-user controls: `revokeUserSessions`, `setUserBanned`, `unlinkMicrosoftAccount`

Service-side, no admin session needed (the admin endpoints of the admin plugin need one): offboarding, a suspected compromise.

```ts
import {
  revokeUserSessions,
  setUserBanned,
  unlinkMicrosoftAccount,
} from '@quynhonsemiconductor/identity';

await revokeUserSessions(auth, userId); // -> how many sessions it ended (0 for an unknown user)
await setUserBanned(auth, userId, true, 'offboarded'); // ban + end every session
await setUserBanned(auth, userId, false); // unban
await unlinkMicrosoftAccount(auth, userId, { actorId: adminId }); // -> how many Microsoft accounts it removed (0 for none)
```

- Both delete the user's sessions in **Valkey and Postgres** (the per-user session list included) and move `user.updatedAt`,
  which ends the user's remembered devices (the known-device cookie of a password user). They are effective on the next
  request; with the public cookie cache a session can still be believed for up to 5 minutes (the staff preset has none). They
  emit `sessions.revoked` (and `admin.user_banned`) with the user id and a count, nothing personal.
- **Cookie cache.** With the `public` preset's cookie cache (5 minutes) a banned user's session cookie can still be
  believed for up to that window, because the cache answers before the session is looked up; the session itself is gone at
  once. The `staff` preset has no cookie cache. A sign-in that was already in flight when the ban ran mints a session that is
  refused on its first use: the user is checked whenever a session is read (at most 30 s stale per process).
- **`unlinkMicrosoftAccount` is the relink path.** A Microsoft sign-in is refused (`MICROSOFT_IDENTITY_CHANGED`) when the user it
  matches already holds a different Microsoft `oid`. When your administrator has decided the new identity **is the same
  person**, call this from the admin UI: it deletes the user's Microsoft account rows and ends every session of the user (so the
  old identity cannot sign in as them any more), emits `account.microsoft_unlinked` (user id and a count), and the next Microsoft
  sign-in with that address links the **new** identity to the **same** user, roles and history intact. **Sessions are revoked first**, so a
  retry after a cache failure cannot leave the old identity's sessions alive (if the final sweep fails the accounts are already gone:
  call `revokeUserSessions` when the cache is healthy). Pass `{ actorId }` (the administrator, at most 128 characters) and it is on
  the `account.microsoft_unlinked` event. **Identity cannot know who is calling: your product MUST gate who may call this** (an
  admin role, ideally a second approver) and log the actor yourself. The old identity is then
  the one that is refused. To keep nothing of the previous person, delete the user in your product instead. Returns `0` (and
  emits nothing) for a user without a Microsoft account or an unknown one; password and Google accounts are not touched. Who may
  call it is the product's decision, and it should be logged there: identity has no admin role of its own.
- `userId` must be a UUID: anything else is a `TypeError` at once, never a database error quoting it.
- A **banned user cannot sign in**, with any provider (Better Auth's admin plugin refuses the session). `reason` is stored in
  `user.ban_reason` as given (at most 500 characters): keep personal data out of it. `setUserBanned` throws for an unknown user.
- **They refuse while the cache is unavailable** (`SessionStoreUnavailableError`, before changing anything), the same rule as
  `revokeAllSessions` and for the same reason: Valkey is read first and its deletes are silent no-ops while it is down, so rows
  deleted from Postgres alone would leave sessions that come back when it recovers. If the cache fails _during_ the run the rows
  of the failing batch are kept for a re-run. For a ban that means the user is already unable to sign in and
  `SessionStoreUnavailableError` is thrown: call `revokeUserSessions` when the cache is healthy. **Unbanning touches no session and
  does not need the cache.**

### Session cookies: `__Secure-` or `__Host-`

By default every identity cookie is named `__Secure-<product>.*`: `HttpOnly`, `Secure`, `SameSite=Lax`, no
`Domain`. That is host-only **as set by this server**, but a `__Secure-` name only promises `Secure`. Any
other app on `*.qnsc.vn` can set `__Secure-<product>.session_token` itself, with `Domain=qnsc.vn`, and the
browser will send it to this API: **cookie tossing**, which lets a sibling app (or an XSS on one) plant a
session id the victim then signs in under (session fixation).

`hostCookies: true` names them `__Host-<product>.*` instead. A browser stores a `__Host-` cookie only if it
is `Secure`, has `Path=/` and has **no `Domain` attribute**, so a sibling host cannot set one for this host.
It covers every identity cookie: session, session cache, known-device, 2FA and the OAuth state.

```ts
createIdentity({ /* … */ hostCookies: true });
```

- **Opt-in**, because it changes cookie names. It must be exactly `true` or `false` (or left out): a string such
  as `'true'` from an environment variable is refused at startup, because `=== true` would quietly read it as off.
  Switching it on **signs everyone out** at the browser (the old cookies are ignored, which is also what
  defeats a cookie tossed under the old name) and **forgets every known device** (the known-device HMAC covers
  the cookie name, so a value minted under one name is not valid under the other; a user's next successful
  sign-in mints a new one, and until then the account-wide throttle applies). Switching it off does the same
  in reverse.
- **Switching does not end the old sessions on the server.** They stay valid in the database under the old
  cookie name and come back to life if you switch back (or if a browser still holds the old cookie and the
  mode is reverted). **Revoke all sessions when you switch:** `await revokeAllSessions(auth)` once, from the
  deploy or a one-off job (it deletes them from the cache first, then the database, and refuses while the cache
  is down; re-run it if it stops). Do it before or with the deploy that changes the mode.
- **Needs an https `baseURL`.** A `__Host-` cookie must be `Secure`, and a browser refuses it over http
  (`createIdentity` throws, rather than let sign-in silently not stick). It is incompatible with
  cross-subdomain cookies (`Domain`), which identity never enables.
- **`SameSite` stays `Lax` in both modes.** `Strict` would withhold the cookie when the identity provider
  redirects the browser back to `/callback/*` — a cross-site navigation, and the one request every OAuth
  sign-in lands on — and the sign-in would fail at the last step. `Lax` still blocks the cookie on cross-site
  sub-requests and form posts, and the origin and CSRF checks stay on.
- If something in front of the API checks for the session cookie by name (a middleware using Better Auth's
  `getSessionCookie`), pass the prefix: `getSessionCookie(request, { cookiePrefix: '__Host-<product>' })`.
  Better Auth's own guard (`auth.api.getSession`, what `@CurrentSession()` uses) needs nothing.
- The conformance kit runs the cookie checks in **both** modes: names and attributes of the session and
  known-device cookies, that a session token planted under the other mode's name (or unprefixed) is no
  session, that the known-device value is only valid under its own name, and the OAuth landing and sign-out.

### Client IP and rate limits

Better Auth rate-limits per client address **and per path**. Its built-in rule for everything under
`/sign-in*`, `/sign-up*`, `/change-password*` and `/change-email*` is **3 requests per 10 seconds**, and the
address it keys on is `clientIp()` (the signed edge address when enabled, then `cf-connecting-ip`; see contract §8). An office of a hundred people
behind one NAT shares one address, so the morning's staff sign-ins share one bucket and the fourth person gets
a 429.

Four endpoints take **no credential** and so do not need that. They only start, or finish, a redirect to an
identity provider:

- **`/sign-in/social`** answers with the provider's URL. Id-token sign-in is **disabled for both providers**
  (Google as well as Microsoft: `signInSocial({ idToken })` verifies a token with no nonce binding and mints a
  session from it), so a token cannot be posted to it either.
- **`/sign-in/sso`** (organizations) takes an email address and answers whether a provider exists for its
  domain, and nothing else: no session, no password check.
- **`/callback/*`** and **`/sso/callback/*`** are the provider handing the browser back. Better Auth has no
  special rule for them, so they already ran at its global **100 per 10 s**.

Guessing a password is not stopped at any of these but by the **device lockout** on the account (5 wrong
passwords per address and account in 15 minutes, and the account-wide delay and ceiling).

| Endpoint                          | Limit (per client address, per path)                                                              |
| --------------------------------- | ------------------------------------------------------------------------------------------------- |
| `/sign-in/social`, `/sign-in/sso` | **120 per 60 s** by default; `oauthRateLimit.start: { windowSeconds, max }`                       |
| `/callback/*`, `/sso/callback/*`  | **100 per 10 s** by default (Better Auth's global rule, made explicit); `oauthRateLimit.callback` |
| `/sign-in/email`, `/sign-up/*`, … | 3 per 10 s (Better Auth's rule, unchanged, **not configurable**)                                  |
| reset and verification mail       | 3 per hour per email address, dropped silently                                                    |

- **`start`** is sized for about a hundred staff behind one address signing in within the same minute: each
  sign-in is one request on each path, and each path has its own bucket. It is still a limit: two a second per
  address, per path.
- **`callback` is not lowered.** A bigger window with a smaller number would be a stricter limit, not a looser
  one (120 per 60 s would have been a fifth of the 100 per 10 s these paths had). It is only made explicit so
  it is ours and configurable.
- **Why `/sign-in/sso` is relaxed too.** An SSO organization's staff behind one NAT have exactly the same
  morning rush, and 3 per 10 s was Better Auth's blanket `/sign-in*` rule, not a decision about this endpoint.
  What it can leak is that a provider exists for a domain, which a company's email domain already says; at 2 a
  second per address it is still not a practical enumeration oracle, and the strict limit did not stop a
  distributed one anyway. Say so if you want it back to 3 per 10 s: it is one line in `DEFAULTS.rateLimit.start.paths`.

Raise or lower either group:

```ts
createIdentity({
  /* … */
  oauthRateLimit: {
    start: { windowSeconds: 60, max: 300 },
    callback: { windowSeconds: 10, max: 150 },
  },
});
```

Each group is optional (an absent one keeps its default). The values are checked (`windowSeconds` 1 to 3600,
`max` 1 to 10,000, integers, no unknown key), so a typo cannot switch the limiter off.

**Which address does the API see?** `clientIp()` reads a verified signed edge address first (only when
`EDGE_CLIENT_IP_SECRET` is set; below), then `cf-connecting-ip`, then the first `x-forwarded-for`, then the
socket (contract §8). It trusts a header only because the pods are reachable
**only** through Cloudflare (the Tunnel, or an allow-list of Cloudflare's addresses): otherwise
`cf-connecting-ip` itself is just a header a caller can set. What `cf-connecting-ip` holds depends on how the
request reached Cloudflare. **Only the first row is something this repository has relied on; the rest are
from Cloudflare's documentation or unverified, and none was observed against a live Worker or Pages Function.**

| Path of the request                                              | `cf-connecting-ip` at the API                                                                                                                                                                                          |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| browser → Cloudflare → Tunnel → API                              | the visitor's address                                                                                                                                                                                                  |
| browser → **Worker** → `fetch()` to the API in the **same** zone | documented by Cloudflare to reflect `x-real-ip`, the visitor's address. **Unverified here**                                                                                                                            |
| browser → **Pages Function** → the API                           | **unverified: assume `2a06:98c0:3600::103`.** A Pages Function on a custom domain probably runs in Pages' zone, not yours, which makes its subrequest cross-zone; community reports say the API then sees that address |
| browser → Worker or Pages Function → API in **another** zone     | documented by Cloudflare: **the same Cloudflare-internal address for every user** (`2a06:98c0:3600::103`); the visitor's address is deliberately not passed across zones                                               |

Assume the last address. Nothing fails when it happens; every user simply shares one rate-limit bucket (and
one `ip` in the request log), so the 3-per-10-seconds credential limit becomes 3 per 10 seconds **for the
whole company**.

- **The way to keep the visitor's address behind a Worker or Pages Function is the signed edge client IP**
  (`@quynhonsemiconductor/platform-http/edge` in the Worker, `EDGE_CLIENT_IP_SECRET` on the API; see
  `platform-http`'s README and contract §8). The Worker signs the address with a secret only it and the API
  hold, and `clientIp()` prefers it over `cf-connecting-ip` when the signature verifies: it cannot be
  spoofed by a caller who reaches the API, which a plain `x-forwarded-for` or custom header can. Nothing of this
  package's code changes (the mount calls `clientIp(request)`; the request log, rate-limit keys and Better Auth's
  keys all follow). **It needs `@quynhonsemiconductor/platform-http` 4.3.0 or later** (the release that added
  `/edge` and the signed address). Identity's peer range stays `>=4.1.0`, because nothing here depends on the
  new API: on an older `platform-http` the headers are simply ignored and the order is the old one. Enable it in
  the Worker and on the API together, and put `platform-http` >= 4.3.0 on the API first.
- **Do not make an unsigned header the source of truth.** A header the Worker sets (`x-client-ip`) is only a
  header to the API; any caller that reaches the API without the Worker could set it too, so `clientIp()` does
  not read one.
- **Or avoid the topology:** have the browser call the API directly (same-site, with CORS and `credentials`),
  so no Worker subrequest is involved.
- **Check it once on a real deployment.** Sign in through the front end and read the `ip` field of the API's
  request-summary log line (contract §4): it must be your own address, not `2a06:98c0:3600::103`.

### Tables

The product owns the auth tables, in its own database. Generate them with the Better Auth CLI against the same
`createIdentity` call and commit the result as a normal migration:

```bash
pnpm exec auth generate --config scripts/auth-cli-config.ts --output src/db/identity.schema.ts
```

House adjustments the package expects (see `scripts/regenerate-reference-schema.sh` for the exact edits): tables
in an `identity` schema, `uuid` id columns (ids are `uuidv7()`), `timestamptz`. The reference schema the
conformance kit uses is exported from `/testing`.

### Ports

Identity depends on two ports, never on the packages behind them:

- **`JobEnqueue`** — `send(queue, data, { tx, idempotencyKey, priority })` (the real `platform-jobs` `Jobs` type is assignable
  to it; `ports.types.test.ts` checks this at compile time). Auth emails are **enqueued, never awaited**, on queue
  `mail.send`, with idempotency key `purpose:userId:sha256(token)` and **priority 10** (`AUTH_MAIL_PRIORITY`), so a bulk
  digest on the same queue cannot delay a verification or reset mail. The sign-up verification mail joins Better Auth's own
  database transaction (rolled back with the user); the others enqueue on their own. **A transaction that cannot commit is
  never a 200:** if a statement in it fails (an SQL error in the enqueue, a revoked grant, a deadlock) Better Auth swallows
  the callback's error and PostgreSQL turns the `COMMIT` into a silent `ROLLBACK`; identity checks the transaction before
  it commits and fails the request instead, so sign-up answers `500` with Better Auth's top-level `code`/`message` (`INTERNAL_ERROR`, a fixed message)
  plus the platform envelope in `error` (with the request's `correlationId`), and `auth.api.signUpEmail` rejects. The log
  line says what failed: the error's class, its cause's class, the SQLSTATE and the correlation id, never the message. An enqueue that fails WITHOUT poisoning the transaction (a
  queue not registered in this process) still leaves the user, and is logged as `identity.mail_enqueue_failed`.
- **Retention is the queue's, not identity's.** Reset and verification links are bearer tokens in clear in the job row, so
  how long a finished job is kept matters (ADR 0002, decision 4). `platform-jobs` has no per-send retention; it is
  configured per queue, and `platform-mail` owns it for `mail.send` (`MAIL_QUEUE_CONFIG`: a completed job is deleted at
  once, a failed or dead-lettered one is kept 24 h). That guarantee holds **only if `mail.send` is registered through
  `platform-mail` in EVERY process that enqueues to it** (the API as well as the worker). An unregistered queue makes
  `send` throw: it fails closed and never falls back to the library's defaults, which would keep the links for days.
  Better Auth swallows a throwing email callback, so the sign-up still answers and the user can use "resend".
- **Correlation id.** The `mail.send` payload carries `correlationId` when the enqueue happens inside a request that has one:
  the id in `observability`'s request context, the store `platform-http`'s `enableCorrelationId` seeds, so one id follows
  the action from the API request into the worker's log lines (platform contract §7). It is included only if it is 1 to 128
  characters from `[A-Za-z0-9._:-]`, otherwise the key is omitted (an invalid value is never echoed); it is not part of the
  idempotency key. The field mirrors `platform-mail`'s `EmailMessage.correlationId`, so the two types are assignable both ways.
  `observability` is an optional peer: without it there is simply no id.
- **`AuthEmailTemplates`** — the product renders `verifyEmail` and `resetPassword`.

`EmailSender` and `EmailMessage` are exported as the **contract `platform-mail` implements** (`send(message) -> { id }`).
Identity never calls an `EmailSender`: auth emails go through the job queue, which is what calls it. The types are here so
the product and `platform-mail` agree on one shape.

### Logs and security events

If an auth email cannot be enqueued (typically `mail.send` was never registered in this process), Better Auth swallows the
throw and the request still answers 200. Identity therefore logs one **ERROR** line with the stable code
`identity.mail_enqueue_failed` and the fields `queue`, `purpose` and the error's class (never an address, a token, a link
or the error's message), then rethrows. **Alert on that code**: it is the only sign a product's mail is not being sent.

Pass `logger` (`{ warn, error }`) to receive Better Auth's own warnings and errors, and `events` to receive the security
events (`sign_in.success`/`failure` for password, social and SSO sign-ins, `account.locked`, `password.reset*`,
`sessions.revoked`, `admin.user_banned`, `account.unverified_replaced`/`purged`,
`account.microsoft_link_refused`, `account.microsoft_unlinked`, `staff.upn_refused`). `/nest` has adapters for
`observability`: `observabilitySecurityEvents(logger)` (a counter `identity.security_events{event}` and a log line with ids
only) and `identityLoggerFrom(pinoLogger)`. Events never contain an email address or a token.

### Scheduled work

```ts
// the worker process, once platform-jobs exists
await registerIdentityJobs(jobs, auth); // or
// until then, from an ExclusiveJob, hourly:
await purgeUnverifiedAccounts(auth);
```

`purgeUnverifiedAccounts` deletes accounts that are unverified, older than 72 h, hold only a password account and
never had a session. Safe to run concurrently.

## Secure defaults

Fixed in `DEFAULTS` and asserted by the conformance kit; a product cannot change them.

| Setting            | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Password hash      | argon2id, m = 19456 KiB, t = 2, p = 1; verifies existing argon2 hashes of any parameters                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Password policy    | 12..128 characters, no composition rules                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Email verification | Required before first sign-in                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Reset              | Single-use token, 15 minutes, stored hashed; every session revoked                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Sessions           | Public 7 d sliding (cookie cache 5 min); staff 12 h, no cache; stored in Postgres and Valkey                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Cookies            | `__Secure-<product>.*` (opt-in `hostCookies`: `__Host-<product>.*`, which a sibling `*.qnsc.vn` app cannot set), HttpOnly, Secure, SameSite=Lax (never Strict: the OAuth landing is a cross-site navigation), no Domain                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Origins            | `trustedOrigins` required; origin and callback-URL checks pinned **on** (Better Auth turns them off under `NODE_ENV=test`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Rate limits        | Per IP in Valkey (client IP from `clientIp()`); the redirect endpoints (`/sign-in/social`, `/sign-in/sso`: 120 per 60 s; `/callback/*`, `/sso/callback/*`: 100 per 10 s; `oauthRateLimit`) per IP and path, the credential endpoints Better Auth's 3 per 10 s; per account **and address** lockout (5 failures in 15 minutes) and, per account from any address, a progressive delay with a ceiling of 50 attempts an hour, on sign-in and on 2FA — a success or a password reset clears both. A browser that has signed in carries an HttpOnly **known-device** cookie (per account; our own HMAC over the cookie name and payload, 90 days enforced server-side from an `iat` inside the value, and bound to the credential: a password change or reset, "sign out everywhere", "sign out other sessions" or the admin's revoke-all invalidates it, also when called server-side with `auth.api`; "other sessions" keeps the asking browser by re-issuing its cookie in the same response, same device and expiry, new epoch; it is minted from a snapshot taken before the call and only if this call performed the bump, a compare-and-set, so two devices racing, or a password change racing, never leave more than one — or any — cookie behind; a cookie that is not valid for that user at that moment is never re-issued). With a valid one the account-wide delay and ceiling are skipped and only 5 failures per device in 15 minutes apply — and 20 an hour across all of the account's devices (spent only by attempts that passed their own device's limit, so one stolen cookie cannot use up the owner's other devices' share), after which a cookie counts for nothing — so a flood of guesses from many addresses cannot lock the owner out; reset/verification mail 3 per hour per email, dropped silently |
| Enumeration        | Identical responses; `request-password-reset`, `send-verification-email`, `sign-up` take at least 150 ms                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Account linking    | Only verified emails from the tenant or a verified SSO domain; SSO auto-links only members of the provider's organization                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| IDs                | `uuidv7()`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Telemetry          | Off                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

## Decisions the package enforces (ADR 0002, plan D9–D20)

- **SSO client secret** is stored as `enc:v1:<base64(iv|ciphertext|tag)>` (AES-256-GCM) in `sso_provider.oidc_config`;
  never logged or returned by an API.
- **Squatting.** Password sign-up is refused for staff domains and verified SSO domains (`USE_COMPANY_SIGN_IN`). When a
  provider asserts a verified email and the only account is unverified, password-only and never had a session, it is
  replaced (`account.unverified_replaced`). Unverified accounts are purged after 72 h.
- **Tenant and guests.** `tid` must equal the configured tenant. A tenant member is accepted only with an email on
  `staff.domains`, and **each entry matches exactly that domain**: `qnsc.vn` admits `jane@qnsc.vn`, not `jane@sub.qnsc.vn`
  (nor a look-alike such as `miqnsc.vn`, nor an address with two `@`). Sub-domains are an explicit opt-in:
  `domains: ['qnsc.vn', '*.qnsc.vn']` (`*.qnsc.vn` alone does not admit `qnsc.vn`). A wildcard on a top-level domain (`*.vn`) or a shared suffix (`*.com.vn`, `*.co.uk`,
  `*.github.io`) is a boot error: it would admit every company under it. That check is a heuristic (a short list of shared
  second levels and multi-tenant hosts), not the Public Suffix List; a wildcard is for a domain you own, and exact entries always work.
  Whatever is not staff stays **reserved** if it is under a staff domain: password and Google sign-up are refused for
  `sub.qnsc.vn` as for `qnsc.vn`, so a sub-domain you did not opt in has no way in rather than becoming a public account.
  Every one of these refusals, and the tenant and guest ones, happens in the Microsoft provider **before** Better Auth
  writes anything: a refused sign-in leaves no user, account, session or verification row (asserted by the conformance
  kit), and the product hook is not called. B2B guests are refused unless `staff.allowGuests`, and a guest **never auto-links**: if the address belongs
  to an existing account the sign-in is refused with `ACCOUNT_LINK_REQUIRED`.
- **One Microsoft identity per user.** The `email` claim is an attribute, not a person: a recycled mailbox, or anyone who can
  edit `mail`, gives a _different_ Entra object (another `oid`) the address of an existing user, and Better Auth links by
  address. A member whose address matches a user that **already holds a different Microsoft `oid`** is **refused** with
  `MICROSOFT_IDENTITY_CHANGED` (a redirect back with `?error=MICROSOFT_IDENTITY_CHANGED`; nothing is written, no second
  account, no session) and an `account.microsoft_link_refused` event with the user's id (never an address or an `oid`). The same
  identity keeps signing in, and so does **any Microsoft identity that already has an account of its own**, even when its address now
  matches someone else's (the owner of `(microsoft, oid)` is signed in as that account, as Better Auth does). A legitimate change (a rehire, a recreated account that _is_ the same person, a tenant migration)
  is an explicit administrator operation: [`unlinkMicrosoftAccount`](#per-user-controls-revokeusersessions-setuserbanned).
- **The member's UPN must be on a staff domain** (`staff.requireUpnOnStaffDomain`, default `true`; a behaviour change, see the top of this file). An Entra UPN suffix has to be
  a domain the tenant has verified, so this holds a member to the company's own domain on a claim the `mail` attribute cannot
  stand in for. It reads `upn`, else `preferred_username` (present in v2 id_tokens under the `profile` scope, which identity
  requests); with neither, or with one off every `staff.domains` entry, the member is refused with nothing written, with `?error=UPN_NOT_ON_STAFF_DOMAIN`, a `staff.upn_refused` event (`reason`: `suffix_not_staff` or `absent`; `suffix`: the UPN's domain) and a warning log line naming that suffix. The suffix is a domain, not an address: no local part is ever logged. Set it to
  `false` only if your members' UPNs are not on a staff domain (`*.onmicrosoft.com`) and say why. Guests are exempt (their UPN is
  `name_domain#EXT#@tenant`). This is not `xms_edov`: that needs the optional claim configured in the app registration, and it tells you the
  tenant owns the domain, not that the address belongs to this person.
- **Google** (public preset) is refused for staff and verified-SSO domains, like password sign-up.
- **IdP registration is default-deny** on `/sso/register` and `/sso/update-provider`. Only an organization owner or admin,
  only for the organization, never for a staff domain; the provider is unusable until its domain is verified. Asserted
  emails outside the provider's domain are rejected. SAML is refused (`SAML_NOT_SUPPORTED`). The client secret is not
  echoed in the response.
- **Linking.** An existing local account is linked by SSO automatically only if it is a member of the provider's
  organization; otherwise the sign-in is refused with `ACCOUNT_LINK_REQUIRED`.
- **SSRF.** Discovery, token, JWKS and userinfo URLs must be `https` and public, judged by Better Auth's
  `isPublicRoutableHost` (it sees through IPv4-mapped, NAT64, 6to4 and Teredo forms, benchmarking and CGNAT ranges) after
  resolving the name, and must not redirect. Checked at registration and update; at fetch time Better Auth's own guard
  applies. An error shows the caller a generic message; the reason is only in the log.
- **Test login.** `/test-login` loads only with `testLogin: true`, `IDENTITY_TEST_LOGIN=enabled` **and** `NODE_ENV` exactly
  `test` or `development` (an unset or unknown value is refused); asking for it otherwise throws at start-up.

## Testing

```ts
import { runIdentityConformance } from '@quynhonsemiconductor/identity/testing';

runIdentityConformance(
  { describe, it, beforeAll, afterAll, expect },
  {
    database: async () => ({ pool /* a fresh, empty PostgreSQL 18 database */ }),
    valkey: async () => ({ url, keyPrefix: `${randomUUID()}:` }),
  },
);
```

Run it in the package's CI (done) and in every consumer's CI. It builds an instance over the reference schema, drives
it in process through `auth.handler` and a local OIDC mock, and fails if any default or decision above is no longer in force.

## Known limits

- **Explicit account linking from a signed-in session is not implemented** (D15): a non-member's account is refused
  with `ACCOUNT_LINK_REQUIRED`; Better Auth's SSO callback exposes no session to the resolver.
- **No refresh-token family theft detection** (cookie sessions have no refresh token); mitigations are HttpOnly cookies,
  short staff sessions and immediate revocation.
- **The public cookie cache is a revocation window** of up to 5 minutes. Staff instances have none.
- `Identity` is the wide `Auth<BetterAuthOptions>` type; plugin endpoints are untyped through it.
- Entra behaviour (single-tenant app registration, the `email` optional claim, which claims mark a guest) and the DNS-TXT
  domain verification are proven only against a mock here; ADR 0002 lists them as manual checks.
- The conformance kit's `platform-jobs` / `platform-mail` stand-ins are not those packages; re-run `testing` against them when WP-7/WP-8 land.
