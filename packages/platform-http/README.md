# @quynhonsemiconductor/platform-http

The HTTP contract every QNSC product backend shares, and that the frontends depend on: the **error
taxonomy and its status mapping**, the **global exception filter** that renders one error envelope,
**pagination**, the **client address**, the **rate-limit guard** and **idempotency interceptor**, the
HTTP **access-log interceptor**, the request-context accessor, and input sanitising.

| in this package                                                                                       | in your product                                                                                                                |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `DomainException` + subclasses, `ErrorCategory` → status table, transport-level codes                 | your domain error **codes** (an append-only catalogue)                                                                         |
| `GlobalExceptionFilter`: the one wire envelope `{ error: { code, message, details, correlationId } }` | which exceptions your code throws                                                                                              |
| cursor and offset pagination (`PageQuerySchema`, `buildPageResult`, `encodeCursor` …)                 | which endpoints paginate, and their sort keys                                                                                  |
| `clientIp(req)`: signed edge IP (opt-in) → `cf-connecting-ip` → `x-forwarded-for` → socket            | nothing: stop reading `req.ip` / `x-real-ip`                                                                                   |
| `RateLimitGuard`, `@RateLimit(tier)`, tiers (`DEFAULT`, `STRICT`, `AUTH_LOGIN`, `AUTH_REFRESH`)       | **which route gets which tier**                                                                                                |
| `IdempotencyInterceptor` (`Idempotency-Key` on `POST`/`PUT`)                                          | which routes opt in                                                                                                            |
| `enableCorrelationId(app)`: the request's correlation id, validated, echoed, in the request context   | your own middleware, once its logger and exception filter read `observability`'s store (see [Rolling it out](#rolling-it-out)) |
| `HttpLoggingInterceptor` (one summary line per request; skips probe paths)                            | your log field names for anything else                                                                                         |
| `sanitizeString` / `sanitizeObject` (XSS stripping ahead of validation)                               | where it is applied                                                                                                            |

Divergence here is a **cross-repo contract break**: both frontends branch on the error `code`, so a 409 in
one product that is a 422 in another is a bug, not a style difference
([ADMISSION-TEST.md](../../docs/ADMISSION-TEST.md)). The wire behaviour is specified in
[PLATFORM-CONTRACT.md](../../docs/PLATFORM-CONTRACT.md) §7–§9.

## Install

```ini
# .npmrc
@quynhonsemiconductor:registry=https://npm.pkg.github.com
```

The token (`read:packages`) goes in your **user-level** `~/.npmrc`, **not** in this file: pnpm 11 ignores a token
in a project `.npmrc`. See [Authenticating to GitHub Packages](../../README.md#authenticating-to-github-packages).

```bash
pnpm add @quynhonsemiconductor/platform-http
```

Peer dependencies: `@nestjs/common`, `@nestjs/core`, `@nestjs/swagger` (`>=11`); `fastify` (`>=5`);
`ioredis`, `nestjs-zod`, `zod`; `@quynhonsemiconductor/platform-cache` (`>=2.0.0`) and
`@quynhonsemiconductor/observability` (`>=0.2.1`).

## Subpaths

| Import                                     | What                                                                                                                 |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `@quynhonsemiconductor/platform-http`      | everything below                                                                                                     |
| `@quynhonsemiconductor/platform-http/edge` | the **Worker / Pages Function** half of the [signed edge client IP](#signed-edge-client-ip): WebCrypto only, no Node |

The two pagination styles share names (`buildPageResult`, `PagedResult`),
so they are exported as namespaces: `cursorPagination` and `offsetPagination`.

## Error envelope

```ts
throw new NotFoundException('WORK_ITEM_NOT_FOUND', 'Work item not found'); // → 404
```

```json
{
  "error": {
    "code": "WORK_ITEM_NOT_FOUND",
    "message": "Work item not found",
    "details": [],
    "correlationId": "…"
  }
}
```

The category fixes the status (`NOT_FOUND` 404, `CONFLICT` 409, `VALIDATION_FAILED` 422,
`PERMISSION_DENIED` 403, `PRECONDITION_FAILED` 412, `RATE_LIMITED` 429, `UNAUTHORIZED` 401, `INTERNAL`
500). Register `GlobalExceptionFilter` once as `APP_FILTER`. Internal detail never reaches the wire.
A framework `HttpException` maps to the code of the same name (`HttpErrorCodes`); `503` is
`SERVICE_UNAVAILABLE`, not `INTERNAL_ERROR`.

## Client address

```ts
import { clientIp } from '@quynhonsemiconductor/platform-http';

const ip = clientIp(req);
// signed edge address (only with EDGE_CLIENT_IP_SECRET) → cf-connecting-ip → first x-forwarded-for → socket
```

Used by request logging, the rate-limit keys, the anonymous idempotency key, and (through the
identity package's mount) Better Auth's rate limits and the session's IP. Behind Cloudflare Tunnel
`req.ip` is `cloudflared`'s address, and the first `x-forwarded-for` entry is whatever the client chose
to send; Cloudflare overwrites `cf-connecting-ip`, so a forged `x-forwarded-for` is ignored whenever it
is present. A header value that is not a literal IP address is skipped. `HttpLoggingInterceptor` does
not read `x-real-ip`.

> **Assumption.** `cf-connecting-ip` is authoritative only if the pods are reachable **only** through
> Cloudflare: the Tunnel and the gateway behind it, with no public listener and no `NodePort`, or an
> allow-list of Cloudflare's published ranges at the origin. Otherwise a caller reaches the origin
> directly and chooses its own `cf-connecting-ip`, so its own address and its own rate-limit bucket.
> **This applies to the signed header below too**: it protects against a forged _header_, not against a
> bypassed edge, and the origin must accept only Cloudflare traffic for either to mean anything.

### Signed edge client IP

Behind a **Cloudflare Worker or Pages Function** the address at the API may not be the visitor's
(a request across zones carries a Cloudflare-internal address, `2a06:98c0:3600::103`, for every user;
a same-zone Worker is unverified), and a plain header the Worker sets (`x-client-ip`) is only a header
to the API: any caller that reaches it can set the same one. So the Worker **signs** the address, and the
API believes it only when the signature verifies for _this_ request.

**Opt-in.** Set `EDGE_CLIENT_IP_SECRET` on the API (at least 32 characters; a random 32-byte value,
hex-encoded, is 64). Unset, nothing changes and `x-qnsc-edge-*` is ignored. Set, a verified address is
used **before** `cf-connecting-ip`, by every consumer of `clientIp()`.

**On the Worker** (the same secret, as a Worker secret):

```ts
import { forwardToOrigin } from '@quynhonsemiconductor/platform-http/edge';

export default {
  fetch(request: Request, env: { EDGE_CLIENT_IP_SECRET: string }): Promise<Response> {
    const target = new URL(request.url);
    target.hostname = 'api.qnsc.vn'; // the URL of the request SENT to the API, after any rewrite
    return forwardToOrigin(request, { secret: env.EDGE_CLIENT_IP_SECRET, target });
  },
};
```

`forwardToOrigin` is `fetch(await edgeForwardRequest(request, options))`, and `edgeForwardRequest`
builds the request the API should receive:

- **`redirect: 'manual'`.** A `fetch` follows redirects by default. A Worker that did would follow
  identity's `/callback/*` 302 itself: the browser would never receive the `Set-Cookie` that signs it in
  (OAuth sign-in breaks), and the signed headers and the visitor's cookies would be re-sent to wherever the
  redirect points. The response, a 302 and its `Set-Cookie` headers included, goes back to the browser as
  the API sent it. **If you build the request by hand, set `redirect: 'manual'` yourself.**
- **An allow-list of the visitor's headers** (`EDGE_FORWARD_HEADERS`: `cookie`, `authorization`,
  `content-type`, `origin`, `user-agent`, `idempotency-key`, `x-correlation-id`, `traceparent` …); add a
  product's own with `forwardHeaders: ['x-csrf-token']`. `x-forwarded-for`, `x-real-ip`, `cf-*`, a
  visitor's own `x-qnsc-edge-*` and anything not listed never reach the API.
- **The signed trio**, for the method and path of the request it builds: `x-qnsc-edge-ip` (the address,
  from `cf-connecting-ip` unless you pass `ip`), `x-qnsc-edge-ts` (now, in whole seconds) and
  `x-qnsc-edge-sig` (`base64url(HMAC-SHA256(secret, "ts|ip|METHOD|path"))`). With no usable address the
  request goes unsigned and the API falls back to its ordinary order.
- The body streamed through for methods that have one.

`applyEdgeClientIp(headers, …)` is the lower-level piece (strip every `x-qnsc-edge-*`, then sign). It
refuses a secret under 32 characters, a method that is not letters only, and an address that is not
shaped like one.

**The secret is trimmed on both ends.** A secret pasted into a Worker secret or an env file often carries
a trailing newline; the Worker and the API both trim it, and the 32-character minimum is measured after
trimming. If the two ends still differ (a typo, a half-finished rotation), every signature is a
`bad_signature` and the API silently falls back to the shared address: watch for it (below).

**On the API**, the address is accepted only if all of these hold; otherwise it is **ignored** and the
order above applies, exactly as without the feature:

- the three headers are present, each with the shape of what it is (a canonical timestamp, a 43-character
  signature, an address); a header sent twice reaches the API joined with `, ` by Node and so has no such
  shape: it is refused;
- `|now - ts| <= 60` seconds (clock skew between the Worker and the API counts against this);
- the HMAC over `ts|ip|METHOD|path` of **this request's** method and path (query string ignored, since
  proxies reorder it) matches, compared in constant time;
- the value is a literal IP address.

So a signature lifted from one request does not work on another path, another method or another
address, and the same request cannot be replayed after a minute. **Inside that minute, the same request
can be replayed from anywhere**: the signature binds the request, not the sender. What it proves is
who the visitor was, and an attacker with a captured header can at most repeat that same request as that
visitor. Keep the path in the signature, keep the origin closed to non-Cloudflare traffic, and do not
log `x-qnsc-edge-sig`.

**Rotation.** Set `EDGE_CLIENT_IP_SECRET_PREVIOUS` to the old value and `EDGE_CLIENT_IP_SECRET` to the new
one on the API, then change the Worker's secret, then remove the previous one. Both are accepted
meanwhile.

**Bad configuration fails startup, where it can.** A secret under 32 characters, or a previous one without
a current one, stops the application starting, naming the variable and never the value, when any of
`RateLimitGuard`, `IdempotencyInterceptor` or `HttpLoggingInterceptor` is registered (each checks at
boot). If you register none of them, call `assertEdgeClientIpEnv()` from `main.ts` yourself. Identity's
mount does not check: without one of those, an unusable value is logged once as an error and the feature
stays OFF (a request never fails on it).

**Observability.** Each refused header increments `edge_client_ip.rejected{reason}`, with `reason` one of
`bad_signature`, `stale`, `malformed`, `incomplete`, `unverifiable`, `not_ip`, and a warning with the
counts is logged at most once a minute (never a header value). A steady stream of `stale` means clocks
have drifted; `bad_signature` means the two secrets differ (or a rotation is half done), or the Worker
signs another path or method than the API receives, and the warning says so; `incomplete` means
something between the Worker and the API strips a header; `malformed` includes a header sent twice. There
is no automatic alarm on the rate: alert on `edge_client_ip.rejected` in the metrics, because every refusal
is a request that is rate-limited and logged under the shared address.

A request with no `x-qnsc-edge-*` headers at all costs nothing: no HMAC is computed and nothing is
counted. `clientIp()` answers **once per request** (memoised on the request object), so the rate-limit
guard, the access log, idempotency and identity's mount agree, and a refusal is counted once.

## Correlation id

```ts
// main.ts, after creating the application and before listen()
enableCorrelationId(app);
```

On every request, before any module middleware, guard or filter:

1. `X-Correlation-Id` is kept **only if** it is one value of **1 to 128 characters from `[A-Za-z0-9._:-]`**.
   Anything else (empty, longer, a space, a quote, a control character, CR/LF, a repeated header, which Node joins
   into one comma-separated value) is
   replaced by `crypto.randomUUID()`. A replacement is logged at DEBUG with the **reason and the length**,
   never the value. An absent header is simply generated.
2. The id is **echoed** on the response as `X-Correlation-Id`, including on 404s and error responses.
3. It is put in `observability`'s request context (with the `traceparent`, when well formed), so
   `correlationId` is on every log line, in the error envelope, and in
   `RequestContextService.getCorrelationId()`.

The character class is deliberate. A UUID-only rule would drop the ULIDs, hex trace ids and
`service:request` composites that upstream systems send and break correlation across a call chain. What
has to be excluded is anything that can inject: CR, LF, control characters, whitespace, quotes.

The browser can only read the response header if the product's CORS config lists it in
`exposedHeaders`.

### One fresh context per request

A new context is made for **every** request and nothing is copied from whatever context is active when
the middleware runs. That matters when the server was started inside a context (a bootstrap wrapped in
`withJobContext`, for instance): every request handled afterwards inherits it, and reusing it would hand
one mutable object to all of them, so they would share an id and a guard's `setAuthContext()` would write
one user into everybody's context. Register `enableCorrelationId` before any other middleware that enters
a context; it does not merge into one that is already there.

### Upgrading

`requestContextStorage` and `RequestContextService` exported by this package are now **`observability`'s
instance** (before, this package carried a second, private copy). The names, shapes and class are
unchanged, so nothing needs editing; a product that seeded this package's copy now seeds the one its
logger reads. `observability` (`>=0.2.1`) was already a peer dependency.

### Rolling it out

1. Upgrade, add `enableCorrelationId(app)`. If the product's own middleware still seeds the context, **it
   keeps working and there is still one id**: the id settled on here is written back to the request's
   `x-correlation-id`, so that middleware adopts it (and one that used to trust the raw header no longer
   reflects bad input). If it enters its own context, its id is the effective one and its `setHeader`
   wins, exactly as before.
2. Delete the product's middleware when convenient, **after checking which store the product reads.**
   This package seeds `observability`'s request context. The logger mixin, `RequestContextService` and the
   `REQUEST_CONTEXT` binding of `GlobalExceptionFilter` must read that same store, or the id is seeded
   where nothing looks:

   | product | reads today                                                                      | can delete its middleware                                   |
   | ------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------- |
   | rova    | `observability`'s store (its `request-context.ts` re-exports it)                 | yes                                                         |
   | opshub  | **its own** `AsyncLocalStorage` (`libs/platform/src/context/request-context.ts`) | **not yet**: first re-export `observability`'s, as rova did |

   What is tested, and what is not. The tests in this repository use **copies shaped like** the products'
   middleware, not the products' own classes: one with rova's pattern and header handling, one that trusts
   the raw header and validates nothing (the shape solodesk had, before it was retired on 2026-10-10), and
   one shaped like opshub's that enters **its own private store**.
   They pin: with the middleware kept there is one id in the response and in the product's own context for
   every kind of input; with it removed, opshub's private store sees nothing (the prerequisite above).
   Separately, rova's and opshub's actual middleware classes were booted once by hand, in throwaway specs
   inside clones of those repositories, against a tarball of this package. That run is not committed and is
   not in CI, so treat it as a one-off check and not as a guarantee.

3. A deployment that must not change yet sets **`CORRELATION_ID_MODE=disabled`**: nothing is registered.
   An unknown value fails the boot.

What changes for a product that deletes its own middleware (each product's rule today is different):

| product | accepts today                                                       | also reads `X-Request-ID`     | after this package                            |
| ------- | ------------------------------------------------------------------- | ----------------------------- | --------------------------------------------- |
| rova    | `[A-Za-z0-9_-]{8,64}`                                               | yes, when the other is absent | wider class; `X-Request-ID` is no longer read |
| opshub  | UUID-shaped only (`[0-9a-f-]{32,36}`); anything else is regenerated | no                            | non-UUID ids (ULIDs, `svc:req`) are now kept  |

A product that trusts the raw header, validates nothing and echoes nothing (solodesk did; retired 2026-10-10)
would go from "anything" to validated and echoed on the response. The tests keep that shape.

`X-Request-ID` is not read here: the contract names one header.

### Background work

A job does not run inside the request, so it must be handed the id. Put it in the payload when you
enqueue, and restore it when the handler starts. No dependency on `platform-jobs` is needed, and the
convention is the same whichever queue carries it:

```ts
// where the work is enqueued, inside the request
const correlationId = this.requestContext.getCorrelationId(); // RequestContextService
await jobs.send('mail.send', { ...message, correlationId }, { tx });

// in the handler
import { withJobContext } from '@quynhonsemiconductor/observability';

await withJobContext('mail.send', () => this.deliver(job.data), {
  correlationId: job.data.correlationId, // omit it and the job gets its own: `mail.send:<uuid>`
});
```

Every log line the handler writes then carries the request's id. The payload value came from this
package, so it is already validated; a handler fed from anywhere else should validate before trusting it.

## Rate limiting and idempotency need a cache

`RateLimitGuard` and `IdempotencyInterceptor` store their state in Valkey through
`CacheService`. `CacheModule` in `optional` mode with no URL turns the cache off, and both
then do nothing — silently, which on EKS meant no application rate limiting at all.

With `NODE_ENV=production` the application **fails at startup** in that state. Outside
production nothing changes (local development and CI run without Valkey).

| Variable           | Values                                     | Effect                                                                                                                                                                                           |
| ------------------ | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `RATE_LIMIT_MODE`  | `cache` (default), `edge-only`, `disabled` | `edge-only`: limits are enforced by Cloudflare rules only; the guard allows every request without touching the cache and logs a warning at startup. `disabled`: no limiting (dev/CI) — see below |
| `IDEMPOTENCY_MODE` | `cache` (default), `disabled`              | `disabled`: `Idempotency-Key` is not honoured; the interceptor passes every request through                                                                                                      |

An unknown value fails at startup too — a typo never silently means the default.

`RATE_LIMIT_MODE=disabled` replaces `DISABLE_RATE_LIMIT=true`, which still works as a
**deprecated alias** (and logs a deprecation warning at startup); an explicit
`RATE_LIMIT_MODE` wins over it, in which case the startup warning says the variable was
**ignored** and which mode is in force, so nobody keeps believing it still switches the
limiter off. In production a disabled limiter is a security control
turned off, so it is reported as a fail-open: a warning at startup carrying
`securityFailOpen: "rate_limit"`, and `SecurityMetrics.recordFailOpen('rate_limit')` at
startup and on every request it lets through, so an alert on either keeps firing while
it stays off. Outside production it is silent, as before.

A cache that exists but is unreachable _at request time_ still fails open, as before; it is
now reported both ways — the log line carries `securityFailOpen: "rate_limit"`
(`failOpenLog`) and `SecurityMetrics.recordFailOpen('rate_limit')` is called, both from
`@quynhonsemiconductor/observability` — so the alert on either can see it. Recording the
metric can never fail the request.

### Upgrading

Not a breaking change: no export was removed or changed. A product that registers the
guard or interceptor and runs production without a cache will now stop at boot. Either
configure the cache (the intended fix) or set the variable above to say it is deliberate.

## Probe paths in access logs

`HttpLoggingInterceptor` skips `PROBE_PATHS` from `@quynhonsemiconductor/observability`
(plus `/favicon.ico`) by default — the same list tracing ignores — matched on the path with
the query string removed. Passing `skipPaths` replaces that default.

This makes `@quynhonsemiconductor/observability` (`>=0.2.1`) a peer dependency. All three
products already install it.

## Testing your code

The guard, the interceptor and the filter are plain Nest providers. Unit-test a guard by constructing it
with a stub `CacheService` (`consumeRateLimit` is the only method it calls); test the interceptor the same
way with `{ instance: { get, set } }`. For behaviour against a real server (the sliding window itself),
see `platform-cache`. There is no `/testing` subpath.

## Known limits

- **NestJS + Fastify only.** The guard and interceptors are Nest constructs; the Express adapter is not
  supported.
- **Rate limiting and idempotency need a reachable cache.** A cache that goes away at request time
  **fails open** (reported as `securityFailOpen: "rate_limit"`); in production the application refuses to
  start without one unless `RATE_LIMIT_MODE` / `IDEMPOTENCY_MODE` say so.
- **`cf-connecting-ip` is trusted.** That is correct only if the pods are reachable solely through
  Cloudflare Tunnel (see the assumption above).
- The rate-limit tiers are fixed (`DEFAULT`, `STRICT`, `AUTH_LOGIN`, `AUTH_REFRESH`). `@RateLimit(tier)`
  selects one by name and `@SkipRateLimit()` opts a route out; a product cannot define a tier of its own
  without a change here. Which route gets which tier is the product's.
