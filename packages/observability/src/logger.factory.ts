import { hostname } from 'node:os';
import { trace, isSpanContextValid } from '@opentelemetry/api';
import type { Params as PinoParams } from 'nestjs-pino';
import { requestContextStorage } from './request-context';

/**
 * The one pino configuration, shared by every app.
 *
 * Each process used to carry its own copy of this block, and the copies drifted:
 * in one product the worker's copy was missing the `redact` list entirely, so any
 * logged object carrying an `authorization` or `cookie` header — an AWS or GitHub
 * SDK error, for instance — would have written credentials to the log sink. A
 * shared factory makes that impossible to forget, which is the whole point of
 * putting it here rather than documenting it.
 */

/** The keys under which an error travels in a log call: `{ err }`, `{ error }` (what the products pass), `{ reason }` (unhandledRejection). */
const ERROR_KEYS = ['err', 'error', 'reason'] as const;

/** Headers that carry a credential, in a request or response, wherever they are nested. */
const SECRET_HEADERS = ['authorization', 'cookie', 'set-cookie', 'x-api-key', 'x-csrf-token'];

/** Credential-bearing paths. Never log these, in any environment. */
const REDACTED_PATHS: readonly string[] = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  'req.headers["x-api-key"]',
  'req.headers["x-csrf-token"]',
  // Belt and braces behind `serializeError`, which already drops these keys: SDK and HTTP-client errors nest the original request, which is
  // the realistic leak path in background workers that never see an inbound HTTP header. Covers every key an error is logged under.
  ...ERROR_KEYS.flatMap((key) =>
    ['config', 'request', 'response'].flatMap((holder) =>
      SECRET_HEADERS.map((h) => `${key}.${holder}.headers["${h}"]`),
    ),
  ),
  ...ERROR_KEYS.flatMap((key) => SECRET_HEADERS.map((h) => `${key}.headers["${h}"]`)),
];

/** Keys an HTTP-client error carries that hold the whole request or response, headers and bodies included. Never logged. */
const DROPPED_ERROR_KEYS = new Set([
  'config',
  'request',
  'response',
  'headers',
  'req',
  'res',
  'options',
  'body',
  'data',
]);

/**
 * The ONE serializer for an error logged under `err`, `error` or `reason`.
 *
 * pino's standard error serializer copies every enumerable property, and an axios-style error has `config` and `request` with the request's
 * `Authorization` header: logging `{ error: sdkErr }` wrote `"authorization":"Bearer ..."` in clear. This keeps `type`, `message`, `stack`,
 * `code`, `status` and the `cause` chain, and drops the keys that hold a request or response. Anything that is not an Error is passed through
 * for the redact paths above to cover.
 */
export function serializeError(value: unknown, depth = 0): unknown {
  if (!(value instanceof Error)) return value;
  const out: Record<string, unknown> = {
    type: value.constructor?.name ?? value.name,
    message: value.message,
    stack: value.stack,
  };
  const extra = value as unknown as Record<string, unknown>;
  for (const key of Object.keys(extra)) {
    if (key in out || DROPPED_ERROR_KEYS.has(key)) continue;
    const v = extra[key];
    // Scalars only (`code`, `status`, `errno`, `syscall`): an object property is where a request would be hiding.
    if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) out[key] = v;
  }
  if (value.cause !== undefined && depth < 5) out['cause'] = serializeError(value.cause, depth + 1);
  return out;
}

export interface LoggerFactoryOptions {
  /** Value of the `service` field on every line — `rova-api`, `rova-worker`. */
  serviceName: string;
  /** `NODE_ENV`: the runtime mode. Drives the pretty-print default, and is the `env` field only when no deployment environment is known. */
  nodeEnv: string;
  /**
   * The DEPLOYMENT environment (`develop` / `production`), for the `env` field. Defaults to `DEPLOYMENT_ENV`, then to `nodeEnv`.
   *
   * Not `NODE_ENV`: products pin `NODE_ENV=production` in develop on purpose (it selects the security posture), so logging it as `env`
   * labelled every develop line `"env":"production"`, indistinguishable from real production in Loki. The OTel resource already uses
   * `DEPLOYMENT_ENV` for `deployment.environment.name`; the log field now agrees with it.
   */
  deploymentEnv?: string;
  /** `SERVICE_VERSION`, so a log line can be traced to a release. */
  serviceVersion: string;
  /** Pino level from config. */
  level: string;
  /** Explicit override for human-readable output; defaults to "not production". */
  pretty?: boolean;
}

/**
 * Build the `nestjs-pino` options.
 *
 * Two things make these logs queryable rather than merely present, and both are
 * why this must stay shared:
 *
 *  - **trace correlation** — `trace.id` / `span.id` from the active span, so a log
 *    line links to its trace in the backend;
 *  - **business context** — `workspaceId` / `userId` / `correlationId` pulled from
 *    AsyncLocalStorage on every write, so no call site has to remember to pass them.
 */
export function createLoggerOptions(options: LoggerFactoryOptions): PinoParams {
  const pretty = options.pretty ?? options.nodeEnv !== 'production';

  return {
    pinoHttp: {
      level: options.level,
      // pino-pretty for humans in dev; raw JSON in deployed environments, where a
      // log aggregator parses it.
      transport: pretty
        ? { target: 'pino-pretty', options: { colorize: true, singleLine: false } }
        : undefined,
      // Every key an error is logged under goes through ONE serializer that drops the request/response it carries (see `serializeError`).
      serializers: Object.fromEntries(ERROR_KEYS.map((key) => [key, serializeError])),
      redact: { paths: [...REDACTED_PATHS], censor: '[REDACTED]' },
      // HttpLoggingInterceptor emits the per-request summary line instead, so the
      // default req/res pair would duplicate it.
      autoLogging: false,
      // ROOT BINDINGS (`base`), not pino-http's `customProps`. customProps is applied only to lines written through a REQUEST-bound logger
      // (`req.log`); anything logged outside a request (the bootstrap and shutdown lines, every worker relay and cron, a process with no HTTP
      // server at all) went out WITHOUT service, env and version, which is why a worker's logs carried none of them. `base` is on every line of
      // every logger, request-bound children included, and replaces pino's default {pid, hostname}, which are kept below.
      base: {
        pid: process.pid,
        hostname: hostname(),
        service: options.serviceName,
        // `||`, not `??`: an EMPTY DEPLOYMENT_ENV (a blank variable) must fall back, not be logged as "".
        env: options.deploymentEnv || process.env['DEPLOYMENT_ENV'] || options.nodeEnv,
        version: options.serviceVersion,
      },
      mixin: () => {
        const fields: Record<string, unknown> = {};

        const span = trace.getActiveSpan();
        if (span) {
          const spanContext = span.spanContext();
          if (isSpanContextValid(spanContext)) {
            fields['trace.id'] = spanContext.traceId;
            fields['span.id'] = spanContext.spanId;
          }
        }

        const requestContext = requestContextStorage.getStore();
        if (requestContext) {
          if (requestContext.workspaceId) fields['workspaceId'] = requestContext.workspaceId;
          if (requestContext.userId) fields['userId'] = requestContext.userId;
          if (requestContext.correlationId) fields['correlationId'] = requestContext.correlationId;
          if (requestContext.principalFields) Object.assign(fields, requestContext.principalFields);
        }

        return fields;
      },
    },
  };
}

/** Exported for the spec that pins the redaction list. */
export const __redactedPaths = REDACTED_PATHS;
