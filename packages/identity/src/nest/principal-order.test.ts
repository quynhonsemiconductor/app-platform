import 'reflect-metadata';
import { Controller, Get, Global, Logger, Module } from '@nestjs/common';
import { APP_GUARD, NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { getRequestPrincipal } from '@quynhonsemiconductor/observability';
import { CacheService } from '@quynhonsemiconductor/platform-cache';
import {
  RateLimitGuard,
  currentUserId,
  enableCorrelationId,
} from '@quynhonsemiconductor/platform-http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Identity } from '../create-identity';
import { IdentityModule } from './identity.module';
import { PRINCIPAL_HOOK } from './session.guard';

/**
 * Where the platform-http RateLimitGuard is registered decides whether it can see the user.
 *
 * Nest runs global guards in the order of the MODULES that declare them: the root module's own `APP_GUARD`
 * runs BEFORE the ones of the modules it imports. So `RateLimitGuard` as an `APP_GUARD` in AppModule runs
 * before identity's `SessionGuard`, the principal is empty, and a whole NAT shares one bucket. Registered
 * in a module imported AFTER `IdentityModule` it runs after, and keys by user.
 *
 * Real Nest, real Fastify, real `SessionGuard` and `RateLimitGuard`; only Better Auth (a stub that knows one
 * session) and the cache (a stub that records the rate-limit key) are faked, so this needs no Docker.
 */
const SESSION = {
  user: { id: 'user-42' },
  session: { id: 'session-42', token: 'never-in-the-context' },
};

@Controller('v1')
class ProbeController {
  @Get('who')
  who() {
    return { principal: getRequestPrincipal(), platformHttpSees: currentUserId() };
  }
}

function stubIdentity(): Identity {
  return {
    api: {
      getSession: async ({ headers }: { headers: Headers }) =>
        headers.get('x-test-session') === 'yes' ? SESSION : null,
    },
    handler: async () => new Response(null, { status: 404 }),
  } as unknown as Identity;
}

function stubCache() {
  const keys: string[] = [];
  const cache = {
    isAvailable: true,
    consumeRateLimit: async (key: string) => {
      keys.push(key);
      return { allowed: true, remaining: 99, resetAt: Math.floor(Date.now() / 1000) + 60 };
    },
  } as unknown as CacheService;
  return { cache, keys };
}

const apps: NestFastifyApplication[] = [];

async function start(AppModule: new () => object, seedContext = true) {
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), {
    logger: false,
    abortOnError: false,
  });
  if (seedContext) enableCorrelationId(app);
  apps.push(app);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}

async function boot(order: 'wrong' | 'right') {
  const { cache, keys } = stubCache();

  // `CacheModule.forRoot` is global in a product; this stands in for it.
  @Global()
  @Module({ providers: [{ provide: CacheService, useValue: cache }], exports: [CacheService] })
  class GlobalCacheModule {}

  // The pattern that WORKS: a module of its own, imported after IdentityModule.
  @Module({ providers: [{ provide: APP_GUARD, useClass: RateLimitGuard }] })
  class RateLimitModule {}

  const identity = IdentityModule.forRootAsync({ useFactory: () => stubIdentity() });
  @Module({
    imports:
      order === 'right'
        ? [GlobalCacheModule, identity, RateLimitModule]
        : [GlobalCacheModule, identity],
    controllers: [ProbeController],
    providers: [
      // The pattern that FAILS: the root module's own APP_GUARD runs before every imported module's.
      ...(order === 'wrong' ? [{ provide: APP_GUARD, useClass: RateLimitGuard }] : []),
    ],
  })
  class AppModule {}

  const app = await start(AppModule);
  const call = (headers: Record<string, string>) =>
    app.inject({ method: 'GET', url: '/v1/who', headers });
  return { keys, call };
}

afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
  vi.restoreAllMocks();
});

describe('RateLimitGuard and SessionGuard: the order that works', () => {
  it('RIGHT: a module imported after IdentityModule registers RateLimitGuard ⇒ it keys by the user', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { keys, call } = await boot('right');

    const res = await call({ 'x-test-session': 'yes', 'cf-connecting-ip': '203.0.113.9' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      principal: { userId: 'user-42', sessionId: 'session-42' },
      platformHttpSees: 'user-42',
    });
    expect(keys).toEqual(['DEFAULT:uid:user-42']);
    expect(JSON.stringify(res.json())).not.toContain('never-in-the-context');
    expect(warn).not.toHaveBeenCalledWith(expect.stringMatching(/RateLimitGuard ran BEFORE/));
  });

  it('WRONG: RateLimitGuard as an APP_GUARD in the root module runs first ⇒ keyed by address, and SessionGuard says so, once', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { keys, call } = await boot('wrong');

    for (let i = 0; i < 3; i += 1) {
      const res = await call({ 'x-test-session': 'yes', 'cf-connecting-ip': '203.0.113.9' });
      expect(res.statusCode).toBe(200);
      expect(res.json().principal).toEqual({ userId: 'user-42', sessionId: 'session-42' }); // later: too late
    }
    // the symptom: authenticated callers share the address bucket
    expect(keys).toEqual([
      'DEFAULT:ip:203.0.113.9',
      'DEFAULT:ip:203.0.113.9',
      'DEFAULT:ip:203.0.113.9',
    ]);
    const messages = warn.mock.calls
      .map((c) => String(c[0]))
      .filter((m) => /RateLimitGuard ran BEFORE/.test(m));
    expect(messages).toHaveLength(1); // once, not per request
    expect(messages[0]).toMatch(/imported AFTER IdentityModule/);
  });

  it('an unauthenticated caller is keyed by address, with no warning, in either order', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const wrong = await boot('wrong');
    await wrong.call({ 'cf-connecting-ip': '198.51.100.4' }); // 401 from SessionGuard, after the limiter
    expect(wrong.keys).toEqual(['DEFAULT:ip:198.51.100.4']);
    expect(warn).not.toHaveBeenCalledWith(expect.stringMatching(/ran BEFORE/));
  });
});

describe('SessionGuard says so when it cannot record the principal', () => {
  it('no request context (enableCorrelationId was not called) ⇒ it still authenticates, and warns once', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { cache } = stubCache();
    @Module({
      imports: [IdentityModule.forRootAsync({ useFactory: () => stubIdentity() })],
      controllers: [ProbeController],
      providers: [{ provide: CacheService, useValue: cache }],
    })
    class AppModule {}
    const app = await start(AppModule, false);

    for (let i = 0; i < 3; i += 1) {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/who',
        headers: { 'x-test-session': 'yes' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().principal).toBeUndefined();
    }
    const messages = warn.mock.calls
      .map((c) => String(c[0]))
      .filter((m) => /no request context/.test(m));
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(/enableCorrelationId/);
  });
});

describe('the principal hook', () => {
  const bootWithHook = async (principal: unknown) => {
    const { cache } = stubCache();
    @Module({
      imports: [
        IdentityModule.forRootAsync({
          useFactory: () => stubIdentity(),
          principal: principal as never,
        }),
      ],
      controllers: [ProbeController],
      providers: [{ provide: CacheService, useValue: cache }],
    })
    class AppModule {}
    return start(AppModule);
  };

  it('cannot overwrite the user or the session: the base is spread last', async () => {
    const app = await bootWithHook(() => ({
      userId: 'attacker',
      sessionId: 'forged',
      workspaceId: 'ws-1',
    }));
    const res = await app.inject({
      method: 'GET',
      url: '/v1/who',
      headers: { 'x-test-session': 'yes' },
    });
    expect(res.json().principal).toEqual({ userId: 'user-42', sessionId: 'session-42' });
  });

  it('accepts { inject, useFactory }: a hook built from the application’s own providers, and PRINCIPAL_HOOK is exported', async () => {
    class Workspaces {
      of = (userId: string) => `ws-of-${userId}`;
    }
    @Module({ providers: [Workspaces], exports: [Workspaces] })
    class WorkspaceModule {}
    const { cache } = stubCache();
    @Module({
      imports: [
        IdentityModule.forRootAsync({
          imports: [WorkspaceModule],
          useFactory: () => stubIdentity(),
          principal: {
            inject: [Workspaces],
            useFactory: ((workspaces: Workspaces) => (session: typeof SESSION) => ({
              workspaceId: workspaces.of(session.user.id),
            })) as never,
          },
        }),
      ],
      controllers: [ProbeController],
      providers: [{ provide: CacheService, useValue: cache }],
    })
    class AppModule {}
    const app = await start(AppModule);

    const hook = app.get(PRINCIPAL_HOOK, { strict: false }) as (s: typeof SESSION) => {
      workspaceId: string;
    };
    expect(hook(SESSION).workspaceId).toBe('ws-of-user-42');
    const res = await app.inject({
      method: 'GET',
      url: '/v1/who',
      headers: { 'x-test-session': 'yes' },
    });
    expect(res.json().principal).toEqual({ userId: 'user-42', sessionId: 'session-42' });
  });
});
