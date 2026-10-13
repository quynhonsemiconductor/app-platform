import 'reflect-metadata';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { CacheModule } from '@quynhonsemiconductor/platform-cache';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { enableHealth } from './enable-health';

/**
 * `NestFactory.create` with its DEFAULT `abortOnError`.
 *
 * Every other test here builds the application with `abortOnError: false`, and that is exactly what hid the
 * bug: `app.get(token, { strict: false })` on the application object runs inside Nest's ExceptionsZone, and
 * when the provider is missing the zone's teardown ends the process (`process.abort()` / `process.exit(1)`)
 * before the `try/catch` around it can see anything. A missing platform-db pool or CacheService is the NORMAL
 * case (both are optional peers), so a service without one died at boot.
 *
 * `process.exit` and `process.abort` are replaced here so that a regression is a failed assertion instead of a
 * dead test worker.
 */
const apps: NestFastifyApplication[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
  vi.restoreAllMocks();
});

function guardProcess() {
  const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  const abort = vi.spyOn(process, 'abort').mockImplementation((() => undefined) as never);
  return { exit, abort };
}

async function boot(module: new () => object) {
  const app = await NestFactory.create<NestFastifyApplication>(module, new FastifyAdapter(), {
    logger: false,
    // NO `abortOnError: false`: the default is what production runs.
  });
  apps.push(app);
  return app;
}

describe('enableHealth on an application created with the default abortOnError', () => {
  it('a module with NEITHER a database pool NOR a CacheService boots, and /readyz is ready with no built-in checks', async () => {
    const { exit, abort } = guardProcess();
    @Module({})
    class Bare {}
    const app = await boot(Bare);

    const registry = enableHealth(app);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    expect(exit).not.toHaveBeenCalled();
    expect(abort).not.toHaveBeenCalled();
    const ready = await app.inject({ method: 'GET', url: '/readyz' });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toMatchObject({ status: 'ok' });
    expect((await registry.report()).checks).toEqual({});
    expect((await app.inject({ method: 'GET', url: '/livez' })).statusCode).toBe(200);
  });

  it('a CacheService without a pool: the cache check is registered, the missing pool is simply absent', async () => {
    const { exit, abort } = guardProcess();
    @Module({ imports: [CacheModule.forRoot({ mode: 'optional', url: 'redis://127.0.0.1:1' })] })
    class OnlyCache {}
    const app = await boot(OnlyCache);

    const registry = enableHealth(app);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    expect(exit).not.toHaveBeenCalled();
    expect(abort).not.toHaveBeenCalled();
    const checks = (await registry.report()).checks;
    expect(Object.keys(checks)).toEqual(['cache']);
    // a configured cache that is not connected IS down: the check ran, so it was registered
    expect(checks['cache']).toBe('down');
    expect((await app.inject({ method: 'GET', url: '/readyz' })).statusCode).toBe(503);
  });

  it('a database pool without a CacheService: the pool is found by its token, the missing cache is simply absent', async () => {
    const { exit, abort } = guardProcess();
    const POOL = Symbol.for('@quynhonsemiconductor/platform-db:pool');
    const pool = { fake: true };
    @Module({ providers: [{ provide: POOL, useValue: pool }] })
    class OnlyPool {}
    const app = await boot(OnlyPool);

    const registry = enableHealth(app);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    expect(exit).not.toHaveBeenCalled();
    expect(abort).not.toHaveBeenCalled();
    expect(Object.keys((await registry.report()).checks)).toEqual(['database']);
  });

  it('a provider that lives in a NON-global feature module is still found (strict: false searches every module)', async () => {
    const { exit } = guardProcess();
    @Module({ imports: [CacheModule.forRoot({ mode: 'optional', url: 'redis://127.0.0.1:1' })] })
    class Feature {}
    @Module({ imports: [Feature] })
    class Root {}
    const app = await boot(Root);
    const registry = enableHealth(app);
    await app.init();
    expect(exit).not.toHaveBeenCalled();
    expect(Object.keys((await registry.report()).checks)).toEqual(['cache']);
  });
});
