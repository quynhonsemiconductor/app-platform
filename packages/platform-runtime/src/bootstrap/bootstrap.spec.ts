import 'reflect-metadata';
import { Controller, Get, Logger, Module } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import {
  assertLogContract,
  createLogCapture,
  runLoggingConformance,
} from '@quynhonsemiconductor/observability/testing';
import { prepareHttpApp, prepareWorkerApp } from './index';

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
});
