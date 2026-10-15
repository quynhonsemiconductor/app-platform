import { Writable } from 'node:stream';
import pino from 'pino';
import { beforeEach, describe, expect, it } from 'vitest';
import { requestContextStorage } from './request-context';
import { __redactedPaths, createLoggerOptions } from './logger.factory';

const base = {
  serviceName: 'rova-api',
  nodeEnv: 'test',
  serviceVersion: '1.2.3',
  level: 'info',
};

/**
 * `pinoHttp` is typed as a union that includes a DestinationStream, so reading the
 * option fields needs one narrowing here rather than a cast at every assertion.
 */
interface PinoHttpShape {
  level?: string;
  transport?: unknown;
  redact?: { paths: string[]; censor: string };
  autoLogging?: boolean;
  base?: Record<string, unknown>;
  customProps?: unknown;
  mixin?: () => Record<string, unknown>;
}

function optionsOf(params: ReturnType<typeof createLoggerOptions>): PinoHttpShape {
  return params.pinoHttp as PinoHttpShape;
}

/** The mixin is the only part with logic; reach it the way pino would. */
function mixinOf(params: ReturnType<typeof createLoggerOptions>) {
  const mixin = optionsOf(params).mixin;
  if (typeof mixin !== 'function') throw new Error('mixin is not configured');
  return mixin;
}

describe('createLoggerOptions', () => {
  it('redacts every credential-bearing path', () => {
    // The worker's hand-rolled copy of this config had NO redact list at all, which
    // is the defect this factory exists to make impossible. Pin the list.
    expect(optionsOf(createLoggerOptions(base)).redact).toMatchObject({ censor: '[REDACTED]' });
    for (const path of [
      'req.headers.authorization',
      'req.headers.cookie',
      'res.headers["set-cookie"]',
      'req.headers["x-api-key"]',
      'req.headers["x-csrf-token"]',
    ]) {
      expect(__redactedPaths).toContain(path);
    }
  });

  it('also redacts credentials nested in SDK error objects', () => {
    // The worker's realistic leak path: an AWS/GitHub SDK error carrying the
    // original request headers.
    expect(__redactedPaths).toContain('err.config.headers.authorization');
    expect(__redactedPaths).toContain('err.request.headers.authorization');
  });

  it('stamps service, env and version on every line', () => {
    const fields = optionsOf(createLoggerOptions(base)).base;
    expect(fields).toMatchObject({ service: 'rova-api', env: 'test', version: '1.2.3' });
    expect(fields).toHaveProperty('pid'); // pino's own defaults are kept
    expect(fields).toHaveProperty('hostname');
    // NOT customProps: that reaches only request-bound loggers, so a worker (no HTTP at all) logged without these fields.
    expect(optionsOf(createLoggerOptions(base)).customProps).toBeUndefined();
  });

  it('logs the DEPLOYMENT environment in `env`, not NODE_ENV (which products pin to production in develop)', () => {
    const prev = process.env['DEPLOYMENT_ENV'];
    try {
      delete process.env['DEPLOYMENT_ENV'];
      const base = {
        serviceName: 'rova-api',
        nodeEnv: 'production',
        serviceVersion: 'v1',
        level: 'info',
      };
      const envOf = (o: object) =>
        (createLoggerOptions({ ...base, ...o }).pinoHttp as { base: { env: string } }).base.env;
      expect(envOf({})).toBe('production'); // nothing else known: the old behaviour
      expect(envOf({ deploymentEnv: 'develop' })).toBe('develop'); // explicit
      process.env['DEPLOYMENT_ENV'] = 'develop';
      expect(envOf({})).toBe('develop'); // from the environment, like the OTel resource
      expect(envOf({ deploymentEnv: 'production' })).toBe('production'); // explicit wins
      process.env['DEPLOYMENT_ENV'] = '';
      expect(envOf({})).toBe('production'); // blank falls back to nodeEnv
      expect(envOf({ deploymentEnv: '' })).toBe('production');
    } finally {
      if (prev === undefined) delete process.env['DEPLOYMENT_ENV'];
      else process.env['DEPLOYMENT_ENV'] = prev;
    }
  });

  it('takes the service name from the caller, so api and worker differ', () => {
    const worker = optionsOf(createLoggerOptions({ ...base, serviceName: 'rova-worker' })).base;
    expect(worker?.['service']).toBe('rova-worker');
  });

  describe('through a REAL pino logger (what a worker, or a bootstrap line, actually writes)', () => {
    const capture = () => {
      const lines: string[] = [];
      const stream = new Writable({
        write(chunk, _enc, cb) {
          lines.push(String(chunk));
          cb();
        },
      });
      const opts = optionsOf(
        createLoggerOptions({
          ...base,
          serviceName: 'rova-worker',
          deploymentEnv: 'develop',
          serviceVersion: 'sha-abc123',
          pretty: false,
        }),
      );
      // pino-http hands exactly these to pino(); the nestjs-pino-only keys are ignored by pino itself
      const logger = pino(opts as pino.LoggerOptions, stream);
      return { logger, lines };
    };

    it('stamps service, env and version on a line written OUTSIDE any request', () => {
      const { logger, lines } = capture();
      logger.info({ context: 'Bootstrap' }, 'Worker process started');
      const line = JSON.parse(lines[0]!) as Record<string, unknown>;
      expect(line).toMatchObject({ service: 'rova-worker', env: 'develop', version: 'sha-abc123' });
    });

    it('stamps a child (request-bound) logger once, with no duplicate keys', () => {
      const { logger, lines } = capture();
      logger.child({ req: { id: 1 } }).info('inside a request');
      for (const key of ['service', 'env', 'version']) {
        expect(lines[0]!.match(new RegExp(`"${key}":`, 'g'))).toHaveLength(1);
      }
    });

    it('redacts credentials on a worker-style line (the SDK-error leak path)', () => {
      const { logger, lines } = capture();
      logger.error({
        err: { config: { headers: { authorization: 'Bearer SECRET' } } },
        req: { headers: { cookie: 'sid=SECRET' } },
      });
      expect(lines[0]).not.toContain('SECRET');
      expect(lines[0]).toContain('[REDACTED]');
    });
  });

  it('disables autoLogging so the interceptor owns the request line', () => {
    expect(optionsOf(createLoggerOptions(base)).autoLogging).toBe(false);
  });

  describe('pretty printing', () => {
    it('is on outside production', () => {
      expect(
        optionsOf(createLoggerOptions({ ...base, nodeEnv: 'development' })).transport,
      ).toBeDefined();
    });

    it('is off in production, so aggregators get raw JSON', () => {
      expect(
        optionsOf(createLoggerOptions({ ...base, nodeEnv: 'production' })).transport,
      ).toBeUndefined();
    });

    it('honours an explicit override', () => {
      expect(
        optionsOf(createLoggerOptions({ ...base, nodeEnv: 'production', pretty: true })).transport,
      ).toBeDefined();
    });
  });

  describe('mixin', () => {
    let mixin: () => Record<string, unknown>;

    beforeEach(() => {
      mixin = mixinOf(createLoggerOptions(base));
    });

    it('adds nothing when there is no context', () => {
      expect(mixin()).toEqual({});
    });

    it('lifts the business context out of AsyncLocalStorage', () => {
      // This is what lets a log line be attributed without any call site passing it.
      requestContextStorage.run(
        {
          workspaceId: 'ws-1',
          userId: 'user-1',
          sessionId: 'sess-1',
          correlationId: 'corr-1',
          traceparent: undefined,
        },
        () => {
          expect(mixin()).toEqual({
            workspaceId: 'ws-1',
            userId: 'user-1',
            correlationId: 'corr-1',
          });
        },
      );
    });

    it('omits absent context fields rather than logging undefined', () => {
      requestContextStorage.run(
        {
          workspaceId: undefined,
          userId: undefined,
          sessionId: undefined,
          correlationId: 'corr-2',
          traceparent: undefined,
        },
        () => {
          expect(mixin()).toEqual({ correlationId: 'corr-2' });
        },
      );
    });
  });
});
