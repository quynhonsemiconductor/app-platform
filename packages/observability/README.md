# @quynhonsemiconductor/observability

Shared observability primitives for QNSC product backends: one OpenTelemetry
bootstrap, one pino configuration, and the AsyncLocalStorage context that ties log
lines to the request or job that produced them.

Every product previously carried its own copy of each of these, once per process.
The copies drifted — in one product the worker's logger config had lost the `redact`
list entirely, so a logged SDK error could have written credentials to the log sink.
That class of bug is the reason this package exists.

## Install

```ini
# .npmrc
@quynhonsemiconductor:registry=https://npm.pkg.github.com
```

The token (`read:packages`) goes in your **user-level** `~/.npmrc`, **not** in this file: pnpm 11 ignores a token
in a project `.npmrc`. See [Authenticating to GitHub Packages](../../README.md#authenticating-to-github-packages).

```bash
pnpm add @quynhonsemiconductor/observability
```

Peer dependencies are the OpenTelemetry SDK packages and `nestjs-pino`, which the
consuming app already has.

## OpenTelemetry bootstrap

```ts
// apps/api/src/otel.ts — MUST be the very first import in main.ts
import { startOtel, shutdownOtel } from '@quynhonsemiconductor/observability/otel';

export { shutdownOtel };

startOtel({ defaultServiceName: 'rova-api' });
```

```ts
// apps/worker/src/otel.ts
import { startOtel, shutdownOtel } from '@quynhonsemiconductor/observability/otel';

export { shutdownOtel };

startOtel({
  defaultServiceName: 'rova-worker',
  serviceNameEnvVar: 'OTEL_WORKER_SERVICE_NAME',
});
```

> **Import from the `/otel` subpath, not the package root.** Auto-instrumentation
> patches modules as they are required, so pulling in the package barrel (which
> reaches Nest and pino) before `startOtel()` would leave those modules unpatched and
> silently produce no spans. The subpath export exists to make that impossible.

Call `shutdownOtel()` from the process signal handler **before** closing the Nest
app, so in-flight spans are exported rather than dropped.

`startOtel` is a **no-op unless `OTEL_ENABLED=true`**, so adopting this package
changes nothing until a collector endpoint exists. It returns `true` when tracing
actually started — worth logging, since it is the cheapest way to tell
"observability is off" from "observability is broken".

### Environment

| Variable                      | Default                 | Purpose                                                                                                                                                                           |
| ----------------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OTEL_ENABLED`                | `false`                 | Must be exactly `"true"` to start                                                                                                                                                 |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://localhost:4318` | Collector, usually a sidecar                                                                                                                                                      |
| `OTEL_SERVICE_NAME`           | `defaultServiceName`    | Overridable per env var name                                                                                                                                                      |
| `OTEL_SERVICE_NAMESPACE`      | `qnsc`                  | Groups products for cross-product queries                                                                                                                                         |
| `SERVICE_VERSION`             | `dev`                   | Set from the release tag in CI, or telemetry is unattributable                                                                                                                    |
| `OTEL_SAMPLING_PROBABILITY`   | `1.0` dev / `0.1` prod  | Head sampling (`parentbased_traceidratio`) — see the caveat below. A value that is not a number falls back to the default with a process warning, instead of dropping every trace |
| `DEPLOYMENT_ENV`              | `NODE_ENV`              | Deployment identity and the sampling default (`production` ⇒ `0.1`)                                                                                                               |
| `NODE_ENV`                    | `development`           | Batching/export tuning                                                                                                                                                            |
| `K8S_POD_NAME`                | —                       | `k8s.pod.name` resource attribute (downward API)                                                                                                                                  |
| `K8S_NAMESPACE`               | —                       | `k8s.namespace.name` resource attribute (downward API)                                                                                                                            |
| `K8S_NODE_NAME`               | —                       | `k8s.node.name` resource attribute (downward API)                                                                                                                                 |

The `K8S_*` variables are added to the resource only when set and non-blank, so a local
or CI run carries no empty `k8s.*` attributes. If the collector's Kubernetes attributes
processor adds the same attributes, the values are identical.

**Standard sampler variables are ignored.** `OTEL_TRACES_SAMPLER` and
`OTEL_TRACES_SAMPLER_ARG` have no effect: `startOtel` passes its own sampler to the SDK,
which takes precedence over them. `OTEL_SAMPLING_PROBABILITY` is the only override.

**Sampling caveat.** Head sampling is all the SDK can do alone, and a prod ratio
below `1.0` drops most **error** traces, which are the ones you need. Prefer
collector-side _tail_ sampling (100% of errors and slow traces, a fraction of the
rest) and leave this at `1.0`.

Health, readiness and favicon requests are skipped outright — no span is created, so
they consume no sampling budget and no quota.

### Probe paths

`PROBE_PATHS` (`/livez`, `/readyz`, `/v1/readyz`, `/healthz`, `/v1/healthz`) is the one
list. The tracing ignore hook and the request-log skip list in
`@quynhonsemiconductor/platform-http` are both derived from it, so a path added here is
dropped from spans **and** access logs at once. `isIgnoredRequestPath(url)` is the shared
matcher: whole-path match, query string ignored, never a prefix.

```ts
import { PROBE_PATHS, isIgnoredRequestPath } from '@quynhonsemiconductor/observability';
```

### Instrumentations

Auto-instrumentation is on for HTTP, `pg` and `ioredis`, and off for `fs`, `dns`, `net`
and the **AWS SDK**. The products' object-storage client talks to R2 over HTTP, which the
HTTP instrumentation already traces; the AWS SDK instrumentation only added a second
span per call.

### Latency histogram buckets (`httpDurationBoundaries`)

```ts
startOtel({
  defaultServiceName: 'rova-api',
  // Milliseconds. Strictly ascending, finite, non-negative.
  httpDurationBoundaries: [0, 100, 500, 1_000, 5_000, 10_000, 30_000, 60_000, 120_000, 300_000],
});
```

|            |                                                    |
| ---------- | -------------------------------------------------- |
| Option     | `httpDurationBoundaries?: number[]` on `startOtel` |
| Unit       | **milliseconds**                                   |
| Applies to | the `http.server.duration` instrument only         |
| Omitted    | the OpenTelemetry defaults are kept                |

**Why you might want it.** The OTel JS default explicit-histogram boundaries end at
`10000`:

```
[0, 5, 10, 25, 50, 75, 100, 250, 500, 750, 1000, 2500, 5000, 7500, 10000]
```

Everything slower than 10s falls into one overflow bucket, and `histogram_quantile()`
clamps to the largest finite boundary — so a p99 alert on a service with genuinely slow
requests fires with the value `10000`, which is not a latency, and a 12s request is
arithmetically indistinguishable from a 180s one. If your request path wraps calls in
resilience presets whose timeout budgets run to 60s × 3 attempts, and those requests
return `200`, then neither the latency alert nor the 5xx alert can see them. Widen the
buckets past your own worst-case timeout budget and they become visible.

> **⚠️ Rolling this out invalidates existing latency series.** Bucket boundaries are part
> of the exported time series' identity: each one is a separate `..._bucket{le="…"}`
> series. Changing them does not re-label the old data — it stops writing those series
> and starts writing different ones. Everything downstream that was built on the old
> boundaries goes stale at the moment of deploy:
>
> - `histogram_quantile()` over a window straddling the change mixes two bucket layouts
>   and returns a meaningless number until the window clears
> - recording rules, dashboard panels and alert thresholds pinned to a specific `le`
>   value (`le="1000"`, `le="10000"`) will silently return no data if that boundary is
>   not in the new set
> - historical comparisons ("p99 vs. last week") break across the boundary change
>
> Keep the old boundaries as a subset of the new ones wherever you can — appending
> `30000, 60000, 120000, 300000` to the defaults preserves every existing `le` — and
> schedule it like a metric migration, not a config tweak.

**Validation is fatal at startup.** An empty array, a non-finite value (`NaN`,
`Infinity`), a negative value, or anything not strictly ascending throws from
`startOtel`, with the offending index and value in the message. This is deliberate: the
SDK's aggregator silently sorts and de-duplicates whatever it is handed, so a typo'd
array is accepted upstream and quietly becomes a _different_ bucket set than you wrote —
producing a histogram that looks healthy and lies, which is the exact failure this
option exists to fix. The check runs **before** the `OTEL_ENABLED` gate, so a bad array
fails in local dev and CI rather than waiting for the one environment that has
telemetry switched on.

Only `HttpMetrics`' `http.server.duration` is affected (the view is scoped to its meter, `qnsc`).
`job.duration` and every other instrument keep their defaults.

### One source of truth for the request duration (`httpInstrumentationDuration`)

`HttpMetrics` records the inbound request duration the dashboards and alerts are written against:
**`http.server.duration`, in milliseconds, labelled by the route _template_, the method and the status class.**
`@opentelemetry/instrumentation-http` records a duration histogram of its own, from another meter, with raw URL attributes.
`startOtel` therefore has a policy for it:

```ts
startOtel({
  defaultServiceName: 'rova-api',
  httpInstrumentationDuration: 'drop', // the default
  // 'keep': export instrumentation-http's duration histogram too
});
```

**What `'drop'` really changes depends on the instrumentation version.**

| `@opentelemetry/instrumentation-http` | records                                              | collides with `HttpMetrics`?                          | effect of `'drop'`                                        |
| ------------------------------------- | ---------------------------------------------------- | ----------------------------------------------------- | --------------------------------------------------------- |
| **0.221** (opshub's and rova's locks) | `http.server.request.duration`, **seconds**, only    | no: a different name                                  | **`http.server.request.duration` stops being exported**   |
| an older version                      | the legacy `http.server.duration`, **ms**, same name | yes: two series, every request counted twice in a sum | the duplicate goes; `HttpMetrics`' series is the only one |

Checked against the 0.221 package: it creates `http.server.request.duration` (unit `s`) and `http.client.request.duration` and
no `http.server.duration`; a test runs the real instrumentation and asserts exactly that, so a version that changes it fails
the build, not a dashboard. The legacy name is dropped as well as a **guard** for an older version (and the buckets view is
scoped to `HttpMetrics`' meter, `qnsc`, so that on such a version it cannot bring the legacy stream back). Spans are never
affected: only the metric.

> **Migration (this is a breaking change: a series is no longer exported by default).**
>
> - If a dashboard or alert reads **`http.server.request.duration`** (seconds, from instrumentation-http), it stops receiving data.
>   Move it to **`http.server.duration`** (milliseconds; labels `route`, `method`, `status_class`), or set
>   `httpInstrumentationDuration: 'keep'` while you migrate.
> - `http.server.duration` itself is unchanged on 0.221: same name, same labels, same unit, and its numbers do not change.
> - A service that does **not** call `HttpMetrics.record()` and relied on the instrumentation's own duration must set `'keep'`, or it
>   has no request duration at all.

## Logger

**Do not wire this by hand.** `createHttpApp` / `createWorkerApp` (`@quynhonsemiconductor/platform-runtime/bootstrap`) register
`LoggingModule.forRoot()` around your root module and install it with `app.useLogger(...)`. Service name, environment and
version come from the environment by convention:

| field     | from                                                    |
| --------- | ------------------------------------------------------- |
| `service` | `OTEL_SERVICE_NAME` (each task sets its own)            |
| `env`     | `DEPLOYMENT_ENV`, falling back to `NODE_ENV`            |
| `version` | `SERVICE_VERSION` (the deploy sets it to the image tag) |
| level     | `LOG_LEVEL` (default `info`)                            |
| pretty    | `LOG_PRETTY=true` (default: pretty outside production)  |

`createLoggerOptions(options)` is still exported for anything that needs the `nestjs-pino` options directly.

### Log field contract

Every runtime emits this, one JSON object per line. The Node implementation is `createPinoOptions`; KB (Python/structlog) is aligned to
the same contract separately.

| field                       | when                    | notes                                                                                                |
| --------------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------- |
| `level`                     | always                  | a **label**: `trace` `debug` `info` `warn` `error` `fatal`. Not pino's numeric 30/50.                |
| `time`                      | always                  | ISO-8601 UTC, e.g. `2026-10-15T07:00:00.000Z`. Not epoch milliseconds.                               |
| `msg`                       | always                  |                                                                                                      |
| `service`, `env`, `version` | always                  | root bindings: on **every** line, not only request-bound ones. `env` is the deployment environment.  |
| `context`                   | when known              | the Nest class / context name                                                                        |
| `trace.id`, `span.id`       | when a span is active   |                                                                                                      |
| `correlationId`             | inside a request        | plus `workspaceId` / `userId` where known                                                            |
| `err`                       | when an error is logged | `{ type, message, stack }`. Both `err` and the `error` key are serialised; an `Error` is never `{}`. |

**Errors** logged under `err`, `error` or `reason` (`reason` is what `unhandledRejection` hands over) go through one serializer: `type`, `message`, `stack`, scalar fields such as `code` and `status`, and the `cause` chain. The keys that hold the request or response an HTTP client attached (`config`, `request`, `response`, `headers`, `data`, ...) are **dropped**, so an `Authorization` header never reaches the log. A non-Error object logged under those keys is covered by the redact paths below.

**Redaction**, on every line: `req.headers.authorization`, `.cookie`, `x-api-key`, `x-csrf-token`, `res.headers["set-cookie"]`, and, under each of `err` / `error` / `reason`, the same credential headers in `config.headers`, `request.headers`, `response.headers` and `headers` are written as `[REDACTED]`.

**Breaking in 0.5.0:** `level` and `time` changed from pino's numeric level and epoch milliseconds. A query that parses either must change.

### Scripts: `createScriptLogger(name)`

For code that is not a Nest app (the migrator, seed and ops scripts): the same lines, to stdout, with no Nest dependency.
`console.*` wrote free text the log pipeline could not parse. A human-facing report (a table someone reads) is output, not a log: write
it with `process.stdout.write`.

```ts
import { createScriptLogger } from '@quynhonsemiconductor/observability/script-logger'; // Nest-free: not the root barrel

const log = createScriptLogger('rova-migrator'); // service = OTEL_SERVICE_NAME, else the name
log.info('Running migrations');
```

### Conformance: `@quynhonsemiconductor/observability/testing`

Run it in your CI. Boot your real API and worker through the shared bootstrap with the capture, and it asserts that **every** captured
line, boot and shutdown included, is a JSON object with every contract field, that `env` is the deployment environment, that no
line is Nest's `[Nest] ...` text, and that credentials are redacted:

```ts
const lines = await runLoggingConformance({
  expected: { service: 'rova-worker', env: 'develop' },
  boot: async (logStream) => ({
    app: await prepareWorkerApp({
      module: () => import('./worker.module').then((m) => m.WorkerModule),
      env,
      logStream,
    }),
  }),
});
```

A worker that built the pino logger but never installed it fails with the offending text lines. Also exported: `assertLogContract`,
`assertRedacted`, `createLogCapture`.

### Lint: `@quynhonsemiconductor/observability/eslint`

`loggingLintConfig()` returns flat-config entries: `no-console` (allow CI tooling with `consoleAllowedIn`) and a ban on
`NestFactory.create*` outside tests, which is how a hand-written bootstrap is kept out.

**Merging with your own rules.** ESLint flat config does not merge rule options: the last config that sets `no-restricted-syntax` replaces the earlier one wholesale, so a product rule set after this preset silently drops these checks. Spread the exported entries into yours:

```js
import {
  LOGGING_RESTRICTED_SYNTAX,
  LOGGING_RESTRICTED_IMPORT_PATHS,
  loggingLintConfig,
} from '@quynhonsemiconductor/observability/eslint';

export default [
  ...loggingLintConfig(),
  {
    rules: {
      'no-restricted-syntax': ['error', ...myEntries, ...LOGGING_RESTRICTED_SYNTAX],
      '@typescript-eslint/no-restricted-imports': [
        'error',
        { paths: [...myPaths, ...LOGGING_RESTRICTED_IMPORT_PATHS] },
      ],
    },
  },
];
```

The imports rule is `@typescript-eslint/no-restricted-imports` (the `typescript-eslint` plugin every Nest product already registers), so `import type { Logger } from 'pino'` stays allowed. It catches `NestFactory` however it is bound (alias, namespace, destructure, `{ NestFactory: F } = await import(...)`) and `pino` / `pino-http` by `import`, `require` and `import()`.

Nest's `new Logger(context)` stays allowed: it
delegates to the installed pino logger.

## Request and job context

`RequestContextService` + `requestContextStorage` carry per-request context. HTTP
requests seed it in middleware; **background work must seed it explicitly**, or its
logs carry no correlation id:

```ts
// A cron job or relay pass
await withJobContext('daily-cleanup', () => this.runCleanup());

// Work that originated in a request — pass the ids through so the halves join up
await withJobContext('notification-relay', () => this.send(row), {
  correlationId: row.correlationId,
  workspaceId: row.workspaceId,
});
```

The generated id is prefixed with the job name (`daily-cleanup:8f3a…`), so a log
search can scope to one job without another field, and an id that escapes into a
payload is self-describing.

### The principal: `setRequestPrincipal`

Whatever authenticates a request records who the caller is in this context, once, and everything else reads it
from here:

```ts
import { setRequestPrincipal, getRequestPrincipal } from '@quynhonsemiconductor/observability';

setRequestPrincipal({
  userId: session.user.id,
  sessionId: session.session.id, // the id, never the session token
  workspaceId: 'ws-1', // optional
  fields: { role: 'admin', plan: 3 }, // optional: at most 8, on every log line of this request
});
getRequestPrincipal(); // -> { userId, sessionId } | undefined
```

`platform-http`'s rate limit, idempotency key, access log and exception filter read the user from this context and
from nowhere else (not `req.user`); identity's `SessionGuard` calls it for you. Returns `false`, and does nothing,
when no request context was seeded. Throws `TypeError` for an invalid value (ids: a non-empty string of at most 128
characters without control characters; field names `[a-z][A-Za-z0-9_.]{0,39}` that are not `userId`, `sessionId`,
`workspaceId`, `correlationId`, `trace.id`, `span.id`, `msg`, `level`, `time`, `err` ...; values a string of at most
128 characters, a finite number or a boolean). The `sessionId` is not put on log lines. Fields are for observability and
are never an authorization input.

## Metrics

```ts
// RED, from a global interceptor — every route, no per-controller wiring
httpMetrics.record({ route: '/v1/work-items/:id', method, statusCode, durationMs, errorCode });

// Jobs: records outcome AND re-throws, so instrumenting cannot swallow a failure
await jobMetrics.time('daily-cleanup', () => this.run());

// Queues: lag is what reveals a relay falling behind; throughput alone looks fine
queueMetrics.recordProcessed(name, n);
queueMetrics.recordFailure(name, n);
queueMetrics.recordLag(name, seconds);

// Pool: register ONCE with a closure over the driver's pool. OTel pulls it on
// collection, so there is no timer to own and no stale reading.
dbPoolMetrics.register(() => ({
  inUse: pool.totalCount - pool.idleCount,
  waiting: pool.waitingCount,
}));

// Security: pair with failOpenLog() — same FailOpenControl union, so the metric label
// and the log-based alarm pattern cannot drift apart
securityMetrics.recordFailOpen('denylist');

// Auth: "is login itself working", separate from the generic HTTP error rate — the
// BFF login callback deliberately collapses every failure into one 401 (never
// surfaces OIDC/internal detail to the browser), so the status code alone cannot
// tell a broken IdP integration from a user mistyping an email.
authMetrics.recordLogin('sso', 'success');
```

The `http.server.duration` histogram uses the OpenTelemetry default buckets, which stop
at 10s — see [`httpDurationBoundaries`](#latency-histogram-buckets-httpdurationboundaries)
if your p99 is being clamped to `10000`.

**Labels are bounded by construction.** Status codes collapse to `2xx/3xx/4xx/5xx`,
methods to a fixed set plus `OTHER`, error labels take a domain code. Passing an id is
a type error. IDs belong on spans and logs. `normalizeRoute()` is the safety net for
when a framework cannot supply a route template.

**…and by a runtime guard where the type cannot help.** `route`, `error_code`, `job_name` and
`queue` are plain strings — the vocabulary is the product's — so a per-id route or a job
named after a tenant type-checks and mints a series per value. `LabelCardinalityGuard`
remembers the distinct values each recorder has seen per label and, past a limit, records
new ones as `__other__` instead (values already admitted keep their own series). It logs
once per label, so the leak is visible without becoming a log flood.

| Label               | Limit (distinct values) |
| ------------------- | ----------------------- |
| `route`             | 500                     |
| `error_code`        | 200                     |
| `job_name`, `queue` | 100                     |

### Metric attribute names

Never name a metric attribute `job` or `instance` (nor `le`, `quantile`, or anything starting `__`). Through OTLP -> Prometheus the scrape labels are
**overwritten from the resource**: `job` becomes `service.namespace/service.name` and `instance` becomes `service.instance.id`. A metric attribute with
either name is silently replaced, which collapses every series that differed only by it into one (and several writers on one series at one
timestamp are discarded as duplicates). `JobMetrics` did exactly this with `job` until 0.6.0: every cron of a worker was ONE series
(`{job="rova/rova-worker"}`), so no alert could name the failing job. `metric-attributes.spec.ts` exports every instrument through the real SDK
and fails on a reserved name or on two attributes that sanitise to the same Prometheus label.

**Migrating to 0.6.0 (breaking).** On every `job.*` metric (`job_runs_total`, `job_failures_total`, the duration histogram, and platform-runtime's
`job.unlocked_runs`) the label `job` is now **`job_name`**. A query that did `by (job)` or filtered `{job="daily-cleanup"}` must use `job_name`. Queries that sum everything
(`sum(rate(job_runs_total[5m]))`) are unchanged. Dashboards keep working but now show one series per job instead of one per worker.

**Label unmatched requests with a constant.** A request that matches no route (every 404
from a scanner or a typo) has no template. If the product then labels it with the raw URL,
each probed path becomes a new `route` value and scanner traffic alone spends the whole
route budget, after which real routes added later would be recorded as `__other__`. Pass a
fixed value such as `route: 'unmatched'` (or `normalizeRoute()` at the very least) for
those requests.

**Recording never throws.** `LabelCardinalityGuard.bound` accepts any value (`undefined`
becomes `UNKNOWN`, other types are stringified) and returns the overflow label rather than
fail, and `HttpMetrics.record`, `JobMetrics.record` and the `QueueMetrics` recorders catch
anything thrown while recording and log it once; `SecurityMetrics` (`recordFailOpen`,
`recordStaleToken`) and `AuthMetrics.recordLogin` do the same. A metric can cost a data point, never a
response — the same fail-open contract as the rest of the package. (`JobMetrics.time` still
re-throws the _job's_ error.)

These are tripwires, not budgets: reaching one means an id or a raw path is being used as
a label, and the fix is at the call site. Values longer than 128 characters are cut. The
limits are fixed — there is deliberately no setting to raise them per product.

## `@Span` policy

Auto-instrumentation already spans every HTTP request (including outbound ones, such as
object-storage calls), database query and cache call. `@Span` is for **deliberate**
additions on top of that:

- a method with meaningful internal fan-out, where one flat span hides the shape
- a hot path whose duration you would want to see separately
- a long-running domain operation

It is **not** for CRUD passthroughs — a span that merely wraps one query duplicates the
pg span underneath it. Uneven `@Span` coverage across services is expected and fine;
the auto-instrumented baseline is what guarantees nothing is blind.

## What this package deliberately does not do

- **No log shipping.** Logs go to stdout; the platform decides where from there.
- **No sampling policy beyond head sampling.** Keeping 100% of errors requires a
  collector-side tail sampler, because the decision needs the finished trace.
- **No health controller.** Readiness checks are product-specific and would drag
  Terminus in as a peer dependency.

## Subpaths

| import                                              | what                                                                                         |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `@quynhonsemiconductor/observability`               | logger options, request and job context, metrics, `failOpenLog`, `PROBE_PATHS`, `@Span`      |
| `@quynhonsemiconductor/observability/otel`          | `startOtel`, `shutdownOtel` — import this **first** in `main`, never through the root barrel |
| `@quynhonsemiconductor/observability/script-logger` | `createScriptLogger` without the Nest-importing root barrel (migrators, ops scripts)         |
| `@quynhonsemiconductor/observability/testing`       | the log contract as an executable check (`runLoggingConformance`, `assertLogContract`)       |
| `@quynhonsemiconductor/observability/eslint`        | `loggingLintConfig()`: no `console`, no hand-written Nest bootstrap                          |

## Testing your code

Run the logging conformance check (see Logger above). The recorders (`HttpMetrics`, `JobMetrics`, `QueueMetrics`,
`SecurityMetrics`, `AuthMetrics`) are plain classes over the OpenTelemetry API, so a test asserts against
an in-memory metric reader; `withJobContext` and `requestContextStorage.run` seed the context a log line
reads. With `OTEL_ENABLED` unset, `startOtel` is a no-op and tests run without a collector.

## Known limits

- **Head sampling only.** `OTEL_SAMPLING_PROBABILITY` below `1.0` drops most error traces; use
  collector-side tail sampling for those and leave this at `1.0` where the collector does it.
- **`OTEL_TRACES_SAMPLER` and `OTEL_TRACES_SAMPLER_ARG` are ignored** (the SDK is given its own sampler).
- **Label caps are fixed** (`route` 500, `error_code` 200, `job_name`/`queue` 100) and there is deliberately
  no per-product setting. Reaching one means an id or raw path is a label; fix the call site.
- Changing `httpDurationBoundaries` invalidates existing latency series (see the warning above).
- Auto-instrumentation covers HTTP, `pg` and `ioredis`; the AWS SDK, filesystem, DNS and raw sockets are
  off.
- **Node and pino only** (`nestjs-pino`). No log shipping and no health controller.

## Unused series and the log `env` field

- **`unusedSeries`** (`startOtel`, default `'drop'`): drops, at the SDK with Views, `v8js.gc.duration` and `v8js.memory.heap.space.*`
  (`available_size`, `physical_size`, `size`). Kept: `v8js.memory.heap.used` and `.limit`. **`http.client.request.duration` is NOT dropped:** with
  `@opentelemetry/instrumentation-http` 0.221 it is the only outbound-HTTP series (the legacy `http.client.duration` is no longer created), so the
  products' "Outbound HTTP client calls" panels read `http_client_request_duration_seconds_count` by `server_address`. A test runs the real
  instrumentation and fails if it is dropped. Pass `'keep'` if a dashboard or alert reads a dropped `v8js` name.
- **Log `env`** is the deployment environment: `createLoggerOptions({ deploymentEnv })`, else `DEPLOYMENT_ENV`, else `nodeEnv`. It used to be `NODE_ENV`,
  which products pin to `production` in develop, so every develop line said `"env":"production"`.
