import type { LoggerFactoryOptions } from './logger.factory';

/**
 * The logger options a process gets BY CONVENTION, from its environment, so no app passes them:
 *
 *   service  <- OTEL_SERVICE_NAME   (each task / pod sets its own; `defaultServiceName` only for a run without it)
 *   env      <- DEPLOYMENT_ENV      (develop | production), falling back to NODE_ENV
 *   version  <- SERVICE_VERSION     (the deploy sets it to the image tag; `dev` locally)
 *   level    <- LOG_LEVEL           (default `info`)
 *   pretty   <- LOG_PRETTY          (`true`; default: pretty outside production, raw JSON in production)
 *
 * The same names the OTel bootstrap already reads, so a log line and a span of one process always agree.
 */
export function loggerOptionsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  defaults: { defaultServiceName?: string } = {},
): LoggerFactoryOptions {
  const nodeEnv = env['NODE_ENV'] || 'development';
  const pretty = env['LOG_PRETTY'];
  return {
    serviceName: env['OTEL_SERVICE_NAME'] || defaults.defaultServiceName || 'app',
    nodeEnv,
    deploymentEnv: env['DEPLOYMENT_ENV'] || undefined,
    serviceVersion: env['SERVICE_VERSION'] || 'dev',
    level: env['LOG_LEVEL'] || 'info',
    pretty: pretty === undefined || pretty === '' ? undefined : pretty === 'true',
  };
}
