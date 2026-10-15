import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { loggerOptionsFromEnv } from './logger-env';
import { createScriptLogger } from './script-logger';

function sink() {
  const lines: string[] = [];
  const destination = new Writable({
    write(chunk, _enc, cb) {
      lines.push(String(chunk));
      cb();
    },
  });
  return { lines, destination };
}

describe('loggerOptionsFromEnv', () => {
  it('reads service, env, version, level and pretty from the environment by convention', () => {
    expect(
      loggerOptionsFromEnv({
        OTEL_SERVICE_NAME: 'rova-worker',
        DEPLOYMENT_ENV: 'develop',
        NODE_ENV: 'production',
        SERVICE_VERSION: 'sha-abc',
        LOG_LEVEL: 'debug',
        LOG_PRETTY: 'false',
      }),
    ).toEqual({
      serviceName: 'rova-worker',
      nodeEnv: 'production',
      deploymentEnv: 'develop',
      serviceVersion: 'sha-abc',
      level: 'debug',
      pretty: false,
    });
  });

  it('has safe defaults, and treats blank variables as unset', () => {
    expect(
      loggerOptionsFromEnv({ OTEL_SERVICE_NAME: '', DEPLOYMENT_ENV: '', LOG_PRETTY: '' }),
    ).toEqual({
      serviceName: 'app',
      nodeEnv: 'development',
      deploymentEnv: undefined,
      serviceVersion: 'dev',
      level: 'info',
      pretty: undefined,
    });
    expect(loggerOptionsFromEnv({}, { defaultServiceName: 'rova-migrator' }).serviceName).toBe(
      'rova-migrator',
    );
  });
});

describe('createScriptLogger', () => {
  it('writes the contract line a Nest app writes: JSON, label level, ISO time, service/env/version', () => {
    const { lines, destination } = sink();
    const log = createScriptLogger('rova-migrator', {
      env: { DEPLOYMENT_ENV: 'develop', SERVICE_VERSION: 'sha-abc', NODE_ENV: 'production' },
      destination,
    });
    log.info('Running migrations');
    const line = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(line).toMatchObject({
      level: 'info',
      msg: 'Running migrations',
      service: 'rova-migrator',
      env: 'develop',
      version: 'sha-abc',
    });
    expect(line['time']).toMatch(/^\d{4}-\d\d-\d\dT.*Z$/);
  });

  it('redacts credentials and serialises errors, like the apps', () => {
    const { lines, destination } = sink();
    const log = createScriptLogger('s', { env: {}, destination });
    log.error(
      { err: new Error('boom'), req: { headers: { authorization: 'Bearer SECRET' } } },
      'failed',
    );
    expect(lines[0]).not.toContain('SECRET');
    expect((JSON.parse(lines[0]!) as { err: { message: string } }).err.message).toBe('boom');
  });

  it('OTEL_SERVICE_NAME wins over the script name', () => {
    const { lines, destination } = sink();
    createScriptLogger('rova-migrator', { env: { OTEL_SERVICE_NAME: 'custom' }, destination }).info(
      'x',
    );
    expect((JSON.parse(lines[0]!) as { service: string }).service).toBe('custom');
  });
});

describe('the script logger stays Nest-free (the ./script-logger subpath)', () => {
  // A migrator has no Nest. Importing the logger must not drag `@nestjs/*` or `nestjs-pino` in through any file it reaches
  // (the root barrel pulled in 166 modules). A TYPE-only import is erased and does not count.
  const root = join(__dirname, 'script-logger.ts');
  const reached = new Set<string>();
  const offenders: string[] = [];
  const walk = (file: string): void => {
    if (reached.has(file)) return;
    reached.add(file);
    const source = readFileSync(file, 'utf8');
    for (const m of source.matchAll(/^import\s+(?!type\b)[^;]*?from\s+'([^']+)';/gms)) {
      const spec = m[1] as string;
      if (spec.startsWith('.')) walk(join(dirname(file), `${spec}.ts`));
      else if (spec.startsWith('@nestjs/') || spec === 'nestjs-pino')
        offenders.push(`${file} -> ${spec}`);
    }
  };

  it('reaches no @nestjs/* or nestjs-pino import', () => {
    walk(root);
    expect(reached.size).toBeGreaterThan(2); // it did walk logger.factory and the request-context leaf
    expect(offenders).toEqual([]);
  });

  it('is exported as a subpath, with the legacy-resolution shim', () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as {
      exports: Record<string, unknown>;
      files: string[];
    };
    expect(pkg.exports['./script-logger']).toBeDefined();
    expect(pkg.files).toEqual(expect.arrayContaining(['script-logger.js', 'script-logger.d.ts']));
  });
});
