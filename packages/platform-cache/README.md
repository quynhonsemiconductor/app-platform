# @quynhonsemiconductor/platform-cache

The one Valkey/Redis client for QNSC product backends: an `ioredis` wrapper with a key prefix, an
atomic sliding-window rate limiter and `SET NX PX` locks.

| in this package                                                         | in your product                                               |
| ----------------------------------------------------------------------- | ------------------------------------------------------------- |
| connection lifecycle (eager connect, auto-pipelining, quit on shutdown) | the connection URL and key prefix (passed to `CacheModule`)   |
| `get` / `set` / `getJson` / `setJson` / `del`, key-prefixed             | what is cached, and its TTLs                                  |
| `consumeRateLimit(key, limit, windowSeconds)` — atomic sliding window   | the limits, tiers and which routes use them (`platform-http`) |
| `tryLock(key, ttlMs)` → `CacheLock` (`release()`, `extend(ms)`)         | which work needs a lock                                       |

It carries **no domain policy**. Token denylists and session semantics live in
[`identity`](../identity); rate-limit tiers live in [`platform-http`](../platform-http). It is a
**peer** of both because two copies of this package mean two Valkey clients: a BFF session written by
one holder is invisible to the other.

Runtime state is per product. Each backend wires its own connection, so importing this package never
implies a shared Valkey instance.

## Install

```ini
# .npmrc
@quynhonsemiconductor:registry=https://npm.pkg.github.com
```

The token (`read:packages`) goes in your **user-level** `~/.npmrc`, **not** in this file: pnpm 11 ignores a token
in a project `.npmrc`. See [Authenticating to GitHub Packages](../../README.md#authenticating-to-github-packages).

```bash
pnpm add @quynhonsemiconductor/platform-cache ioredis
```

Peer dependencies: `@nestjs/common` (`>=11`), `ioredis` (`>=5`).

## Usage

```ts
import { CacheModule, CacheService } from '@quynhonsemiconductor/platform-cache';

@Module({
  imports: [
    CacheModule.forRootAsync({
      inject: [AppConfigService],
      useFactory: (config: AppConfigService) => ({
        url: config.get('REDIS_URL'), // the product reads its own variable — see Environment
        keyPrefix: 'rova:',
        mode: 'required',
      }),
    }),
  ],
})
export class AppModule {}
```

`CacheModule` is `@Global()`; inject `CacheService` anywhere.

```ts
await cache.set('session:42', 'v', 60); // TTL in seconds
await cache.getJson<User>('user:42'); // null if missing, disabled, or corrupt
const { allowed, remaining, resetAt } = await cache.consumeRateLimit('login:1.2.3.4', 5, 900);
const lock = await cache.tryLock('nightly-sweep', 60_000); // null if someone else holds it
if (lock) {
  try {
    /* … */
  } finally {
    await lock.release(); // compare-and-delete on this lock's own token
  }
}
```

## Locks

```ts
const lock = await cache.tryLock('nightly-report', 60_000); // CacheLock | null
if (!lock) return; // held elsewhere (or the cache is disabled: check `cache.isAvailable`)
try {
  await work();
  if (!(await lock.extend(60_000))) throw new Error('lost the lock'); // optional: renew mid-run
} finally {
  await lock.release(); // true if it was still ours; false if the lease had expired
}
```

- The stored value is a **random 32-hex token**; `release()` and `extend()` are Lua scripts that act only while the value is still
  that token. Before, the value was the constant `1` and `releaseLock(key)` deleted whatever was there: a holder that overran
  its lease freed the lock of the pod that had taken over, and two pods ran at once.
- `ttlMs` must be a positive integer (`RangeError` otherwise).
- **`acquireLock(key, ttlMs)` / `releaseLock(key)` are deprecated and compatible.** `acquireLock` takes the same token lock and
  remembers it in the process; `releaseLock(key)` releases only a lock THIS process took with `acquireLock`, if it is still
  ours. Behaviour change: `releaseLock` for a key this process never took, or took by another process, now does nothing
  (it used to delete it). Move to `tryLock`.
  **`releaseLock(key)` carries no handle, so it cannot tell two holders of one key in one process apart** (the first overran its
  lease, the second took over). It releases the _oldest_ remembered lock first: the first holder's late call hits its own expired
  token and cannot free the second's live lock. The cost is liveness: if the second finishes first, its lock stays held until the
  first's call or the lease. Only `tryLock` tells holders apart.

## Modes

| `mode`               | no URL                                             | use when                                                   |
| -------------------- | -------------------------------------------------- | ---------------------------------------------------------- |
| `required` (default) | **startup error**                                  | the cache is on a critical path (auth denylist, sessions)  |
| `optional`           | cache disabled; every call no-ops or returns empty | the product treats the cache as best-effort and fails open |

In `optional` mode with no URL `consumeRateLimit` returns `allowed: true` and `tryLock` returns
`null` (`acquireLock`, `false`). **That quiet state is a hazard in production**: rate limiting and idempotency would do nothing.
`platform-http` therefore refuses to start in production in that state unless the deployment says so
(`RATE_LIMIT_MODE`, `IDEMPOTENCY_MODE`).

## Environment

This package **reads no environment variable itself**: the product passes `url`, `keyPrefix` and `mode`.
The contract name for the URL is **`REDIS_URL`** (what rova and opshub already read and the chart
injects; [PLATFORM-CONTRACT.md](../../docs/PLATFORM-CONTRACT.md) §6). The product reads it and passes it to
`CacheModule`.

## Shutdown order

The client quits in **`onApplicationShutdown`**, not `onModuleDestroy`. Nest runs `onModuleDestroy` →
`beforeApplicationShutdown` → (HTTP server drains) → `onApplicationShutdown`; anything that stops work
using the cache (a job runner) or serves requests that use it must finish first. `onModuleDestroy()` is
kept as a **deprecated no-op** so a caller that invoked it keeps compiling; it will be removed in the
next major. This is why `platform-runtime`'s graceful shutdown needs `platform-cache` **>=3.1.1**.

## Subpaths

None: a single entry point (`.`).

## Testing your code

`CacheService` takes a real URL. Test against a real Valkey: the rate limiter is a server-side Lua
script and the lock is `SET NX PX`, so an in-memory double does not exercise what matters. This
repository's own tests use `@quynhonsemiconductor/testing` (`startValkey()`; a private workspace
package, never published). A product can use any Valkey container, or its CI service container.

## Known limits

- One Valkey node; no cluster or sentinel awareness beyond what `ioredis` does from a URL.
- The rate limiter's window and member scheme are fixed. Tiers and thresholds are the product's.
- Locks are single-key `SET NX PX` with a random owner token ("Redlock-lite"): safe against a crashed holder
  (the lease expires) and **a holder that overruns its lease cannot free or extend the lock of whoever took it
  over** (`release()` / `extend()` are compare-and-delete / compare-and-expire on the token). They do not stop an
  overrunning job from still running: a paused or slow holder whose lease expired is working alongside the new
  one. Set the lease above the work, or `extend` it, and keep the work idempotent.
- With a per-instance cache (not shared across replicas) sessions and revocations are visible to only
  some replicas.
