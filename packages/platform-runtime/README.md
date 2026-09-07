# @quynhonsemiconductor/platform-runtime

Runtime primitives every QNSC product backend needs, and none of them should own a
private copy of.

| in this package | in your product |
| --- | --- |
| `.env` loading, ordered before the OTel bootstrap | your `env.schema.ts` — the variable set is product vocabulary |
| environment validation with a multi-error message | your `AppConfigService` subclass (one line) |
| typed `ConfigService` access | your own module, if you need providers beyond config |
| leader-elected scheduled jobs (`ExclusiveJob`) | the jobs themselves, and their TTLs |
| request-arrival timing (ALB → app → handler) | your logging interceptor's field names |

Extracted from `rova` and `opshub`, which carried byte-identical copies of
`exclusive-job.service.ts` (104 lines), `request-timing.ts` (108), `load-env.ts` (35)
and `app-config.service.ts` (16). See [REUSE-ROADMAP.md](../../docs/REUSE-ROADMAP.md)
for the measurements.

## Install

```ini
# .npmrc
@quynhonsemiconductor:registry=https://npm.pkg.github.com
```

```bash
pnpm add @quynhonsemiconductor/platform-runtime
```

Peer dependencies: `@nestjs/common`, `@nestjs/config`,
`@quynhonsemiconductor/platform-cache`, `@quynhonsemiconductor/observability`, and
`fastify` (optional — only for `request-timing`).

## `load-env` — import it FIRST, from the subpath

```ts
// apps/api/src/main.ts — line 1, above the OTel bootstrap
import '@quynhonsemiconductor/platform-runtime/load-env';
import './otel';
```

**It is not exported from the package root, deliberately.** It must run before OTel's
auto-instrumentation patches `http`, `pg` and `ioredis`, and importing it through the
barrel would first load Nest — the very modules still waiting to be patched. The
subpath keeps it a leaf module whose only import is `node:process`. Its own header
records the failure that proved this: `OTEL_ENABLED=true` in `.env` read as unset,
zero exported series against a live collector, 219 with the same value exported in
the shell.

A real environment variable always wins over the file, so this is safe in every
environment rather than only locally.

## Config

The `Env` type is yours — it is your service's own variable set, so it cannot come
from here. Subclass the generic base:

```ts
// config/app-config.service.ts
import { Injectable } from '@nestjs/common';
import { TypedConfigService } from '@quynhonsemiconductor/platform-runtime';
import type { Env } from './env.schema';

@Injectable()
export class AppConfigService extends TypedConfigService<Env> {}
```

```ts
// app.module.ts
import { AppConfigModule } from '@quynhonsemiconductor/platform-runtime';
import { EnvSchema } from './config/env.schema';
import { AppConfigService } from './config/app-config.service';

@Module({
  imports: [AppConfigModule.forRoot({ schema: EnvSchema, service: AppConfigService })],
})
export class AppModule {}
```

The module is `@Global()`, matching both products' existing modules.

Need providers beyond config? Skip `AppConfigModule` and compose the validator into
your own — that function is the part worth sharing:

```ts
ConfigModule.forRoot({ isGlobal: true, validate: createEnvValidator(EnvSchema) })
```

`createEnvValidator` is typed structurally (`safeParse` + `error.issues`) rather than
against `ZodSchema`, so this package carries no zod peer dependency and pins no
consumer to a zod major. `zod@4` satisfies it as-is.

## `ExclusiveJob` — scheduled work on exactly one pod

```ts
constructor(private readonly exclusiveJob: ExclusiveJob) {}

@Cron('0 */15 * * * *')
async sweep() {
  await this.exclusiveJob.run('audit-cleanup', 14 * 60_000, () => this.doSweep());
}
```

`@Cron` and `@Interval` fire on **every replica**. With one worker task that is
invisible; the moment a rolling deploy overlaps two tasks, every job runs twice
concurrently — and these jobs delete rows and objects.

Set `lockTtlMs` just under the schedule interval: long enough that a slow run keeps
its lock, short enough that a pod killed mid-run does not block the next tick. The
lock auto-expires, so a crash cannot deadlock a job permanently.

**It fails OPEN when there is no cache**, and that is a deliberate inversion worth
knowing. `acquireLock` returns `false` both when another pod holds the lock and when
there is no client at all, so treating `false` as "someone else has it" would let a
Valkey outage silently stop every scheduled job in the system while logging that
another pod was doing the work. Every job behind this helper is idempotent, so
running a sweep twice costs less than losing SLA-breach detection for the length of a
cache incident. An in-process guard still prevents this pod overlapping itself.

## `request-timing` — which part of "slow" was slow

```ts
import { registerRequestTiming, arrivalAtMs, albReceivedAtMs, albWaitMs }
  from '@quynhonsemiconductor/platform-runtime';

registerRequestTiming(app.getHttpAdapter().getInstance());
```

Splits latency into three intervals with three different owners: `albWaitMs`
(proxy/network), `bodyWaitMs` (body receipt), and the handler's own duration. The ALB
receive time is decoded from `X-Amzn-Trace-Id` — no log correlation, no X-Ray, no
extra call.

`albWaitMs` is reported only above `ALB_WAIT_REPORTING_FLOOR_MS` (1000). The trace id
carries whole seconds, so the value inherits up to 1000ms of truncation error; on
real traffic it sat at a median of ~500ms, which is exactly what a request with *no*
delay looks like. A field that invites misattribution defeats instrumentation whose
whole purpose was to stop latency being misattributed.

Field naming stays in the product — these are inputs to your logging interceptor, not
a log format.

## What is deliberately NOT here

`errors/`, `http/pagination`, `http/*.interceptor`, `rate-limit/*` and
`request-context` all live in
[`@quynhonsemiconductor/platform-http`](../platform-http) already. Check there before
proposing anything HTTP-shaped.

Rate-limit thresholds, job schedules and TTLs are policy: mechanism here, values in
the product.
