import 'reflect-metadata';
import { Controller, Get, Logger, Module } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import {
  assertLogContract,
  createLogCapture,
  runLoggingConformance,
} from '@quynhonsemiconductor/observability/testing';
import {
  HTTP_HEADERS_TIMEOUT_MS,
  HTTP_KEEP_ALIVE_TIMEOUT_MS,
  boundPort,
  installProcessErrorHandlers,
  prepareHttpApp,
  prepareWorkerApp,
  type HttpAppOptions,
} from './index';

const ENV = {
  NODE_ENV: 'production', // pinned to production in deployed environments on purpose
  DEPLOYMENT_ENV: 'develop',
  OTEL_SERVICE_NAME: 'svc-under-test',
  SERVICE_VERSION: 'sha-abc123',
  LOG_LEVEL: 'info',
} as NodeJS.ProcessEnv;

@Controller()
class PingController {
  private readonly logger = new Logger('Ping');
  @Get('ping')
  ping() {
    this.logger.log('ping handled');
    return { ok: true };
  }
}

@Module({ controllers: [PingController] })
class HttpProductModule {}

@Module({})
class WorkerProductModule {}

const expected = { service: 'svc-under-test', env: 'develop', version: 'sha-abc123' };

describe('the shared bootstrap writes the log contract', () => {
  it('worker: every line from boot to shutdown is JSON with every contract field, env is the deployment env, and credentials are redacted', async () => {
    const lines = await runLoggingConformance({
      expected,
      boot: async (logStream) => ({
        app: await prepareWorkerApp({
          module: async () => WorkerProductModule,
          env: ENV,
          logStream,
        }),
      }),
    });
    expect(lines.some((l) => l.includes('conformance: a Nest Logger line'))).toBe(true);
    expect(lines.every((l) => !l.startsWith('[Nest]'))).toBe(true);
  });

  it('http: the same, including a request-bound line, with the Fastify logger off', async () => {
    const lines = await runLoggingConformance({
      expected,
      boot: async (logStream) => {
        const app = await prepareHttpApp({
          module: async () => HttpProductModule,
          env: ENV,
          logStream,
        });
        await app.init();
        await app.getHttpAdapter().getInstance().ready();
        return {
          app,
          request: async () => {
            const res = await app
              .getHttpAdapter()
              .getInstance()
              .inject({ method: 'GET', url: '/ping' });
            expect(res.statusCode).toBe(200);
          },
        };
      },
    });
    expect(lines.some((l) => l.includes('ping handled'))).toBe(true);
  });

  it('runs the product `before` hook after OTel and BEFORE the module factory', async () => {
    const order: string[] = [];
    const app = await prepareWorkerApp({
      env: ENV,
      logStream: createLogCapture().stream,
      before: () => void order.push('before'),
      module: async () => {
        order.push('module');
        return WorkerProductModule;
      },
    });
    await app.close();
    expect(order).toEqual(['before', 'module']);
  });

  // The regression the kit exists for: the pino logger built but never installed.
  it('serviceNameEnvVar: the logger names the process from that variable, not OTEL_SERVICE_NAME (api and worker share one .env)', async () => {
    const lines = await runLoggingConformance({
      expected: { service: 'svc-worker', env: 'develop', version: 'sha-abc123' },
      boot: async (logStream) => ({
        app: await prepareWorkerApp({
          module: async () => WorkerProductModule,
          env: { ...ENV, OTEL_SERVICE_NAME: 'svc-api', OTEL_WORKER_SERVICE_NAME: 'svc-worker' },
          otel: { defaultServiceName: 'svc-worker', serviceNameEnvVar: 'OTEL_WORKER_SERVICE_NAME' },
          logStream,
        }),
      }),
    });
    expect(
      lines.every((l) => (JSON.parse(l) as { service: string }).service === 'svc-worker'),
    ).toBe(true);
  });

  it.each(['createWorkerApp', 'createHttpApp'] as const)(
    '%s: a boot failure is ONE JSON fatal line and exit 1, not Nest text and SIGABRT',
    async (factory) => {
      // A provider that throws while Nest builds the instances: the path where Nest's default is to log TEXT and process.abort().
      @Module({
        providers: [
          {
            provide: 'EXPLODING',
            useFactory: () => {
              throw new Error('DATABASE_URL is required');
            },
          },
        ],
      })
      class ExplodingModule {}
      const bootstrap = await import('./index');
      const { createLogCapture } = await import('@quynhonsemiconductor/observability/testing');
      const capture = createLogCapture();
      const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
      capture.install();
      try {
        await bootstrap[factory]({
          module: async () => ExplodingModule,
          env: ENV,
          logStream: capture.stream,
        });
      } finally {
        capture.restore();
      }
      const exitCalls = exit.mock.calls.map((c) => c[0]);
      exit.mockRestore();
      expect(exitCalls).toEqual([1]);
      // EVERY captured line, not only the fatal one: what Nest wrote while creating the app (the buffered "Starting Nest application" lines and
      // the ExceptionHandler stack) must be JSON in the contract shape too, never coloured ConsoleLogger text.
      const all = capture.lines();
      expect(all.length).toBeGreaterThan(1);
      assertLogContract(all, expected);
      expect(all.some((l) => l.includes('ExceptionHandler'))).toBe(true);
      const fatal = capture.lines().filter((l) => l.includes('Fatal bootstrap error'));
      expect(fatal).toHaveLength(1);
      expect(JSON.parse(fatal[0] as string)).toMatchObject({
        level: 'fatal',
        service: 'svc-under-test',
        env: 'develop',
        err: { message: 'DATABASE_URL is required' },
      });
    },
  );

  it('boundPort returns the port the OS gave for PORT=0, not the requested 0', async () => {
    const app = await prepareHttpApp({
      module: async () => HttpProductModule,
      env: ENV,
      logStream: createLogCapture().stream,
    });
    await app.listen(0, '127.0.0.1');
    try {
      const port = boundPort(app, 0);
      expect(port).toBeGreaterThan(0);
      expect(boundPort(app, 0)).toBe((app.getHttpServer().address() as { port: number }).port);
    } finally {
      await app.close();
    }
  });

  describe('HTTP server keep-alive alignment', () => {
    const timeouts = async (
      http?: HttpAppOptions['http'],
    ): Promise<{ keepAlive: number; headers: number; requestTimeout: number }> => {
      const app = await prepareHttpApp({
        module: async () => HttpProductModule,
        env: ENV,
        logStream: createLogCapture().stream,
        ...(http ? { http } : {}),
      });
      await app.listen(0, '127.0.0.1');
      try {
        const server = app.getHttpServer();
        expect(server.keepAliveTimeout).toBeDefined();
        expect(server.headersTimeout).toBeDefined();
        // Fastify's own setup ran: its requestTimeout default (0, unlike Node's 300 s) is intact.
        expect(server.requestTimeout).toBe(0);
        return {
          keepAlive: server.keepAliveTimeout,
          headers: server.headersTimeout,
          requestTimeout: server.requestTimeout,
        };
      } finally {
        await app.close();
      }
    };

    it('defaults: keepAliveTimeout 65 s and headersTimeout 66 s, above a 60 s proxy idle so no request lands on a closing socket', async () => {
      expect(await timeouts()).toEqual({
        keepAlive: HTTP_KEEP_ALIVE_TIMEOUT_MS,
        headers: HTTP_HEADERS_TIMEOUT_MS,
        requestTimeout: 0,
      });
      expect(HTTP_KEEP_ALIVE_TIMEOUT_MS).toBe(65_000);
      expect(HTTP_HEADERS_TIMEOUT_MS).toBe(66_000);
    });

    it('the product can override both, and a real request still routes on the overridden server', async () => {
      const app = await prepareHttpApp({
        module: async () => HttpProductModule,
        env: ENV,
        logStream: createLogCapture().stream,
        http: { keepAliveTimeoutMs: 10_000, headersTimeoutMs: 11_000 },
      });
      await app.listen(0, '127.0.0.1');
      try {
        const server = app.getHttpServer();
        expect(server.keepAliveTimeout).toBe(10_000);
        expect(server.headersTimeout).toBe(11_000);
        const port = boundPort(app, 0);
        const res = await fetch(`http://127.0.0.1:${port}/ping`);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true });
      } finally {
        await app.close();
      }
    });

    it('refuses a boot whose headersTimeout does not sit above the keep-alive', async () => {
      await expect(
        prepareHttpApp({
          module: async () => HttpProductModule,
          env: ENV,
          logStream: createLogCapture().stream,
          http: { keepAliveTimeoutMs: 10_000, headersTimeoutMs: 10_000 },
        }),
      ).rejects.toThrow(
        /headersTimeoutMs \(10000\) must be greater than http.keepAliveTimeoutMs \(10000\)/,
      );
    });
  });

  it('with no OTEL_SERVICE_NAME, every line says the product\'s default service name (as OpenTelemetry does), never "app" or "bootstrap"', async () => {
    const withoutName = { ...ENV, OTEL_SERVICE_NAME: undefined } as NodeJS.ProcessEnv;
    const lines = await runLoggingConformance({
      expected: { service: 'svc-default', env: 'develop', version: 'sha-abc123' },
      boot: async (logStream) => ({
        app: await prepareWorkerApp({
          module: async () => WorkerProductModule,
          env: withoutName,
          otel: { defaultServiceName: 'svc-default' },
          logStream,
        }),
      }),
    });
    expect(
      lines.every((l) => (JSON.parse(l) as { service: string }).service === 'svc-default'),
    ).toBe(true);
  });

  it('the fatal line also carries the default service name when the environment names none', async () => {
    @Module({
      providers: [
        {
          provide: 'EXPLODING',
          useFactory: () => {
            throw new Error('DATABASE_URL is required');
          },
        },
      ],
    })
    class ExplodingModule {}
    const withoutName = { ...ENV, OTEL_SERVICE_NAME: undefined } as NodeJS.ProcessEnv;
    const { createWorkerApp } = await import('./index');
    const { createLogCapture } = await import('@quynhonsemiconductor/observability/testing');
    const capture = createLogCapture();
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    capture.install();
    try {
      await createWorkerApp({
        module: async () => ExplodingModule,
        env: withoutName,
        otel: { defaultServiceName: 'svc-default' },
        logStream: capture.stream,
      });
    } finally {
      capture.restore();
      exit.mockRestore();
    }
    const services = capture.lines().map((l) => (JSON.parse(l) as { service: string }).service);
    expect(services.length).toBeGreaterThan(0);
    expect(new Set(services)).toEqual(new Set(['svc-default']));
  });

  it('the fatal line is named by serviceNameEnvVar too (a local worker whose .env names the API)', async () => {
    @Module({
      providers: [
        {
          provide: 'EXPLODING',
          useFactory: () => {
            throw new Error('DATABASE_URL is required');
          },
        },
      ],
    })
    class ExplodingModule {}
    const { createWorkerApp } = await import('./index');
    const { createLogCapture } = await import('@quynhonsemiconductor/observability/testing');
    const capture = createLogCapture();
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    capture.install();
    try {
      await createWorkerApp({
        module: async () => ExplodingModule,
        env: { ...ENV, OTEL_SERVICE_NAME: 'svc-api', OTEL_WORKER_SERVICE_NAME: 'svc-worker' },
        otel: { defaultServiceName: 'svc-default', serviceNameEnvVar: 'OTEL_WORKER_SERVICE_NAME' },
        logStream: capture.stream,
      });
    } finally {
      capture.restore();
      exit.mockRestore();
    }
    const services = capture.lines().map((l) => (JSON.parse(l) as { service: string }).service);
    expect(services.length).toBeGreaterThan(0);
    // EVERY line, the Nest ones before the logger is installed and the fatal one included: none may say the API's name.
    expect(new Set(services)).toEqual(new Set(['svc-worker']));
  });

  it('two boots in ONE process each capture their own lines (nestjs-pino keeps a process-wide out-of-context logger)', async () => {
    for (const round of [1, 2]) {
      const lines = await runLoggingConformance({
        expected,
        boot: async (logStream) => ({
          app: await prepareWorkerApp({
            module: async () => WorkerProductModule,
            env: ENV,
            logStream,
          }),
        }),
      });
      expect(lines.length, `boot ${round} captured nothing`).toBeGreaterThan(0);
    }
  });

  it('a boot that throws before anything is logged surfaces the boot error, not "no log line was captured"', async () => {
    await expect(
      runLoggingConformance({
        expected,
        boot: async () => {
          throw new Error('DATABASE_URL is required');
        },
      }),
    ).rejects.toThrow('DATABASE_URL is required');
  });

  it('the conformance check FAILS for a worker that never installed the logger (Nest text lines)', async () => {
    const { NestFactory } = await import('@nestjs/core');
    await expect(
      runLoggingConformance({
        expected,
        boot: async () => ({
          app: await NestFactory.createApplicationContext(WorkerProductModule),
        }),
      }),
    ).rejects.toThrow(/NOT JSON/);
  });

  it('assertLogContract rejects the text line directly', () => {
    expect(() => assertLogContract(['[Nest] 7 - LOG [Shutdown] Received SIGTERM'])).toThrow(
      /NOT JSON/,
    );
  });

  it('refuses a second nestjs-pino LoggerModule, naming what to remove', async () => {
    const { LoggerModule } = await import('nestjs-pino');
    @Module({ imports: [LoggerModule.forRoot({ pinoHttp: { level: 'info' } })] })
    class ProductWithOwnLogger {}
    const capture = createLogCapture();
    capture.install();
    try {
      await expect(
        prepareWorkerApp({
          module: async () => ProductWithOwnLogger,
          env: ENV,
          logStream: capture.stream,
        }),
      ).rejects.toThrow(/2 nestjs-pino LoggerModules.*Remove LoggerModule\.forRoot/s);
    } finally {
      capture.restore();
    }
  });

  describe('installProcessErrorHandlers', () => {
    const fakeProcess = () => {
      const handlers = new Map<string, (arg: unknown) => void>();
      const exit = vi.fn();
      return {
        proc: {
          on: (event: string, fn: (arg: unknown) => void) => {
            handlers.set(event, fn);
            return undefined as never;
          },
          exit: exit as unknown as (code?: number) => never,
        },
        handlers,
        exit,
      };
    };

    it('logs the rejection under `err` and EXITS 1: a listener disables Node’s default crash, so logging alone leaves the process running', () => {
      const { proc, handlers, exit } = fakeProcess();
      const log = { error: vi.fn() };
      installProcessErrorHandlers(log, proc);
      const reason = new Error('socket hang up');
      handlers.get('unhandledRejection')?.(reason);
      expect(log.error).toHaveBeenCalledWith(
        { msg: 'Unhandled promise rejection', err: reason },
        'Bootstrap',
      );
      expect(exit).toHaveBeenCalledWith(1);
    });

    it('logs an uncaught exception under `err` and exits 1', () => {
      const { proc, handlers, exit } = fakeProcess();
      const log = { error: vi.fn() };
      installProcessErrorHandlers(log, proc);
      const error = new Error('boom');
      handlers.get('uncaughtException')?.(error);
      expect(log.error).toHaveBeenCalledWith(
        { msg: 'Uncaught exception', err: error },
        'Bootstrap',
      );
      expect(exit).toHaveBeenCalledWith(1);
    });
  });
});
