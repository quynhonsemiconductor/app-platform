/**
 * `@quynhonsemiconductor/platform-runtime/bootstrap`: the whole process bootstrap, so no product wires it by hand.
 *
 *   createHttpApp({ module: () => import('./app.module').then((m) => m.AppModule), configure: bootstrapApp })
 *   createWorkerApp({ module: () => import('./worker.module').then((m) => m.WorkerModule) })
 *
 * In order: `.env`, OpenTelemetry, the product's `before` hook, THEN the product module is imported (lazily: this is the only way to
 * guarantee OTel patches pg/http/ioredis before they load), Nest is created with `bufferLogs`, the shared pino logger is installed with
 * `useLogger` and the buffered lines flushed, the product's `configure`, graceful shutdown, listen, and the unhandled-error handlers (log, then exit 1). A
 * failure anywhere is logged as one JSON line to stderr and exits 1.
 *
 * `service`, `env` and `version` come by convention from OTEL_SERVICE_NAME, DEPLOYMENT_ENV and SERVICE_VERSION.
 *
 * IMPORT DISCIPLINE: this file's own top level imports ONLY `load-env` and the OTel bootstrap, neither of which loads Nest. Everything
 * else is imported dynamically after `startOtel`.
 */
import '../config/load-env';
import { startOtel } from '@quynhonsemiconductor/observability/otel';
import type {
  INestApplication,
  INestApplicationContext,
  LoggerService,
  Type,
} from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { DestinationStream } from 'pino';

export interface BootstrapOptions {
  /** The product's root module, imported LAZILY so OpenTelemetry is installed before pg/http/ioredis load. */
  module: () => Promise<Type<unknown>>;
  /** OpenTelemetry extras. Service name, environment and version come from the environment. */
  otel?: {
    defaultServiceName?: string;
    httpDurationBoundaries?: number[];
    /**
     * Read the service name from THIS variable instead of `OTEL_SERVICE_NAME`, for a repo whose api and worker share one `.env` and name
     * themselves independently (opshub: `OTEL_WORKER_SERVICE_NAME`). The logger's `service` follows the same rule as OpenTelemetry's.
     */
    serviceNameEnvVar?: string;
  };
  /** Runs after OTel and before the module is imported (e.g. set the process role that `@platform` reads on import). */
  before?: () => void | Promise<void>;
  /** Test seam: where the shared logger writes (and the fatal line). Default: stdout (the fatal line: stderr). */
  logStream?: DestinationStream;
  /** Test seam: the environment. Default: process.env. */
  env?: NodeJS.ProcessEnv;
}

export interface HttpAppOptions extends BootstrapOptions {
  /** Product-specific setup of the Fastify app (helmet, CSP, swagger, prefix, correlation id): everything that is not logging or shutdown. */
  configure?: (app: NestFastifyApplication) => void | Promise<void>;
  http?: {
    trustProxy?: boolean;
    bodyLimit?: number;
    rawBody?: boolean;
    /**
     * Keep-alive alignment: every hop's idle timeout must be SHORTER than the next hop's, so no request lands on a socket the origin is already
     * closing (ALB 60 s today, cloudflared `originRequest.keepAliveTimeout = 60 s` later). Defaults: `keepAliveTimeout` 65 000 ms,
     * `headersTimeout` 66 000 ms — the keep-alive above the proxy's 60 s idle, and the header deadline above the keep-alive (a product may
     * override both together; `headersTimeoutMs` at or below `keepAliveTimeoutMs` fails the boot).
     */
    keepAliveTimeoutMs?: number;
    headersTimeoutMs?: number;
  };
}

/** The origin's keep-alive defaults, one place so the test and the bootstrap agree. */
export const HTTP_KEEP_ALIVE_TIMEOUT_MS = 65_000;
export const HTTP_HEADERS_TIMEOUT_MS = 66_000;

export type WorkerAppOptions = BootstrapOptions;

/**
 * The service name a process reports when its environment names none: the product's `otel.defaultServiceName`. OpenTelemetry already falls back
 * to it; the logger must too, or a process with no OTEL_SERVICE_NAME logs `service:"app"` (or "bootstrap") while its spans say `rova-worker`.
 */
function defaultServiceName(options: BootstrapOptions): string {
  return options.otel?.defaultServiceName ?? 'app';
}

/**
 * A second `nestjs-pino` LoggerModule (a product that still registers its own `LoggerModule.forRootAsync`) gives two global Logger providers
 * and two pino-http middlewares: every request is logged twice, by two configurations, one of them without the shared redaction. Refuse to
 * start rather than guess which one wins.
 */
async function assertSingleLoggerModule(app: INestApplicationContext): Promise<void> {
  const { ModulesContainer } = await import('@nestjs/core');
  const modules = app.get(ModulesContainer, { strict: false });
  const loggerModules = [...modules.values()].filter((m) => m.metatype?.name === 'LoggerModule');
  if (loggerModules.length > 1) {
    throw new Error(
      `${loggerModules.length} nestjs-pino LoggerModules are registered, but createHttpApp / createWorkerApp already register the one shared ` +
        'logger. Remove LoggerModule.forRoot / forRootAsync (and createLoggerOptions) from your app and worker modules; ' +
        'service, env and version come from OTEL_SERVICE_NAME, DEPLOYMENT_ENV and SERVICE_VERSION.',
    );
  }
}

async function installLogging(app: INestApplicationContext): Promise<{
  log: (message: string, context: string) => void;
  error: (o: object, context: string) => void;
}> {
  await assertSingleLoggerModule(app);
  const { Logger } = await import('nestjs-pino');
  const logger = app.get(Logger);
  app.useLogger(logger);
  // Hand the lines buffered during creation to the pino logger, so the bootstrap lines are JSON too.
  app.flushLogs();
  return {
    log: (message, context) => logger.log(message, context),
    error: (o, context) => logger.error(o, context),
  };
}

/**
 * The environment the logger reads, ONE answer for every logger of the process (the pre-logger bootstrap lines, the shared pino logger and the
 * fatal line). OpenTelemetry takes the service name from `serviceNameEnvVar` when the product names one (opshub, rova: the worker shares a `.env`
 * that names the API), else from the default; the logger must report the same name, so `OTEL_SERVICE_NAME` is set from that variable here.
 */
function loggerEnvFor(options: BootstrapOptions): NodeJS.ProcessEnv {
  const baseEnv = options.env ?? process.env;
  const envVar = options.otel?.serviceNameEnvVar;
  return envVar
    ? { ...baseEnv, OTEL_SERVICE_NAME: baseEnv[envVar] ?? defaultServiceName(options) }
    : baseEnv;
}

/**
 * Nest's logger BEFORE `useLogger` runs: a `LoggerService` over the same pino configuration (a script logger: JSON, the field contract,
 * synchronous). Passed to `NestFactory` so what Nest writes while creating the app (the buffered "Starting Nest application" lines, and the
 * `ExceptionHandler` error when a provider throws) is JSON, not coloured `ConsoleLogger` text.
 */
async function createBootstrapLogger(
  options: BootstrapOptions,
  loggerEnv: NodeJS.ProcessEnv,
): Promise<LoggerService> {
  const { createScriptLogger } = await import('@quynhonsemiconductor/observability/script-logger');
  const pino = createScriptLogger(defaultServiceName(options), {
    env: loggerEnv,
    ...(options.logStream ? { destination: options.logStream } : {}),
  });
  type Level = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  const write =
    (level: Level) =>
    (message: unknown, ...params: unknown[]): void => {
      // Nest calls (message, context) and, for errors, (message, stack, context): the last string is the context.
      const strings = params.filter((p): p is string => typeof p === 'string');
      const context = strings.length > 0 ? strings[strings.length - 1] : undefined;
      const stack = level === 'error' && strings.length > 1 ? strings[0] : undefined;
      const fields: Record<string, unknown> = {};
      if (context) fields['context'] = context;
      if (stack) fields['stack'] = stack;
      if (message instanceof Error) pino[level]({ ...fields, err: message }, message.message);
      else if (message !== null && typeof message === 'object')
        pino[level]({ ...fields, ...(message as object) });
      else pino[level](fields, String(message));
    };
  return {
    log: write('info'),
    error: write('error'),
    warn: write('warn'),
    debug: write('debug'),
    verbose: write('trace'),
    fatal: write('fatal'),
  };
}

async function composeRoot(
  options: BootstrapOptions,
): Promise<{ Root: Type<unknown>; bootstrapLogger: LoggerService }> {
  const envVar = options.otel?.serviceNameEnvVar;
  const loggerEnv = loggerEnvFor(options);
  startOtel({
    defaultServiceName: defaultServiceName(options),
    ...(envVar ? { serviceNameEnvVar: envVar } : {}),
    ...(options.otel?.httpDurationBoundaries
      ? { httpDurationBoundaries: options.otel.httpDurationBoundaries }
      : {}),
  });
  await options.before?.();
  const bootstrapLogger = await createBootstrapLogger(options, loggerEnv);

  const [{ Module }, { LoggingModule }, productModule] = await Promise.all([
    import('@nestjs/common'),
    import('@quynhonsemiconductor/observability'),
    options.module(),
  ]);
  class RootModule {}
  Module({
    imports: [
      LoggingModule.forRoot(
        loggerEnv,
        { defaultServiceName: defaultServiceName(options) },
        options.logStream,
      ),
      productModule,
    ],
  })(RootModule);
  return { Root: RootModule, bootstrapLogger };
}

/**
 * Build the HTTP app: everything except listening, signal handlers and the exit-on-failure wrapper. Exported so a CONFORMANCE TEST boots
 * the real bootstrap path (logger install order included) without a port or a process exit.
 */
export async function prepareHttpApp(options: HttpAppOptions): Promise<NestFastifyApplication> {
  const { Root, bootstrapLogger } = await composeRoot(options);
  const [{ NestFactory }, { FastifyAdapter }] = await Promise.all([
    import('@nestjs/core'),
    import('@nestjs/platform-fastify'),
  ]);
  const keepAliveTimeout = options.http?.keepAliveTimeoutMs ?? HTTP_KEEP_ALIVE_TIMEOUT_MS;
  const headersTimeout = options.http?.headersTimeoutMs ?? HTTP_HEADERS_TIMEOUT_MS;
  if (headersTimeout <= keepAliveTimeout) {
    throw new Error(
      `http.headersTimeoutMs (${headersTimeout}) must be greater than http.keepAliveTimeoutMs (${keepAliveTimeout}).`,
    );
  }
  const app = await NestFactory.create<NestFastifyApplication>(
    Root,
    new FastifyAdapter({
      // pino handles all logging; Fastify's own logger would be a second, unstructured one.
      logger: false,
      trustProxy: options.http?.trustProxy ?? true,
      ...(options.http?.bodyLimit ? { bodyLimit: options.http.bodyLimit } : {}),
      // Keep-alive alignment. Passed as a Fastify option, NOT via `serverFactory`: Fastify 5 already
      // defaults keepAliveTimeout to 72 s, and building the server by hand would skip Fastify's own
      // server setup — requestTimeout silently becomes Node's 300 s and a slow upload past 5 minutes
      // gets a 408. 65 s sits above the 60 s proxy idle while staying a Fastify-driven server.
      keepAliveTimeout,
    }),
    // `abortOnError: false`: Nest's default is to log the error as TEXT and `process.abort()` (SIGABRT, exit 134). Let it reject instead, so
    // `createHttpApp` reports it as the one JSON line and exits 1.
    {
      bufferLogs: true,
      logger: bootstrapLogger,
      abortOnError: false,
      ...(options.http?.rawBody ? { rawBody: true } : {}),
    },
  );
  await installLogging(app);
  // `headersTimeout` is not a Fastify option: Fastify leaves Node's 60 s in place, which sits BELOW
  // both its own and our keep-alive. Fastify never touches the field afterwards, so setting it on the
  // server here is the whole story.
  app.getHttpServer().headersTimeout = headersTimeout;
  await options.configure?.(app);
  return app;
}

/** Build the worker context: everything except shutdown wiring, signal handlers and the exit-on-failure wrapper. */
export async function prepareWorkerApp(
  options: WorkerAppOptions,
): Promise<INestApplicationContext> {
  const { Root, bootstrapLogger } = await composeRoot(options);
  const { NestFactory } = await import('@nestjs/core');
  // createApplicationContext: no HTTP driver; a worker is queue/cron only.
  const app = await NestFactory.createApplicationContext(Root, {
    bufferLogs: true,
    logger: bootstrapLogger, // see prepareHttpApp
    abortOnError: false,
  });
  await installLogging(app);
  return app;
}

async function failFatal(error: unknown, options: BootstrapOptions): Promise<never> {
  // Lines buffered before the logger was installed would otherwise be lost: hand them to whatever logger is current.
  try {
    const { Logger } = await import('@nestjs/common');
    Logger.flush();
  } catch {
    /* nothing to flush */
  }
  // One JSON line to stderr, in the same contract shape, from the script logger (no Nest, no transport, synchronous).
  const pino = (await import('pino')).default;
  const { createScriptLogger } = await import('@quynhonsemiconductor/observability/script-logger');
  createScriptLogger(defaultServiceName(options), {
    env: loggerEnvFor(options),
    destination: options.logStream ?? pino.destination({ fd: 2, sync: true }),
  }).fatal({ err: error }, 'Fatal bootstrap error');
  process.exit(1);
}

/**
 * Last-resort handlers. Registering an `unhandledRejection` listener DISABLES Node's default (crash with exit code 1), so a handler that only
 * logs leaves a process in an unknown state running: it must log AND exit. Both log the error under `err`, so it is serialised (and its
 * request/headers dropped) like every other error.
 */
export function installProcessErrorHandlers(
  log: { error: (o: object, context: string) => void },
  proc: Pick<NodeJS.Process, 'on' | 'exit'> = process,
): void {
  proc.on('unhandledRejection', (reason: unknown) => {
    log.error({ msg: 'Unhandled promise rejection', err: reason }, 'Bootstrap');
    proc.exit(1);
  });
  proc.on('uncaughtException', (error: Error) => {
    log.error({ msg: 'Uncaught exception', err: error }, 'Bootstrap');
    proc.exit(1);
  });
}

/** The port the server is actually bound to: with `PORT=0` the OS picks one, and the requested `0` is useless in a log line. */
export function boundPort(app: INestApplication, requested: number): number {
  const address = app.getHttpServer().address() as { port?: number } | string | null;
  return typeof address === 'object' && address?.port ? address.port : requested;
}

/** Start an HTTP service. Never rejects: a failure is one JSON line on stderr and exit code 1. */
export async function createHttpApp(options: HttpAppOptions): Promise<void> {
  try {
    const app = await prepareHttpApp(options);
    const { enableGracefulShutdown } = await import('../shutdown');
    const { Logger } = await import('nestjs-pino');
    const env = options.env ?? process.env;
    const port = parseInt(env['PORT'] ?? '3000', 10);
    const host = env['HOST'] ?? '0.0.0.0';
    enableGracefulShutdown(app as INestApplication);
    await app.listen(port, host);
    const logger = app.get(Logger);
    logger.log(`Listening on ${host}:${boundPort(app, port)}`, 'Bootstrap');
    installProcessErrorHandlers({ error: (o, c) => logger.error(o, c) });
  } catch (error) {
    await failFatal(error, options);
  }
}

/** Start a worker (queue / cron, no HTTP). Never rejects: a failure is one JSON line on stderr and exit code 1. */
export async function createWorkerApp(options: WorkerAppOptions): Promise<void> {
  try {
    const app = await prepareWorkerApp(options);
    const { enableGracefulShutdown } = await import('../shutdown');
    const { Logger } = await import('nestjs-pino');
    // SIGTERM / SIGINT in Nest's close order, then OpenTelemetry is flushed. There is no HTTP server, so no readiness flip or drain.
    enableGracefulShutdown(app);
    const logger = app.get(Logger);
    logger.log('Worker process started', 'Bootstrap');
    installProcessErrorHandlers({ error: (o, c) => logger.error(o, c) });
  } catch (error) {
    await failFatal(error, options);
  }
}
