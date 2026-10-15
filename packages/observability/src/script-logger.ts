import pino from 'pino';
import { createPinoOptions } from './logger.factory';
import { loggerOptionsFromEnv } from './logger-env';

/**
 * The logger for code that is NOT a Nest app: the migrator, seed and ops scripts.
 *
 * It writes the SAME lines as the apps (`level` label, ISO `time`, `service`, `env`, `version`, `err`, the same redaction), to
 * stdout, with no Nest or pino-http dependency. `console.*` in those scripts wrote free text that the log pipeline could not
 * parse; this is the replacement.
 *
 * `name` is the `service` when `OTEL_SERVICE_NAME` is unset (a one-off task usually has none), e.g. `rova-migrator`.
 * A human-facing REPORT (a table someone reads in a terminal) is output, not a log: write it with `process.stdout.write`.
 */
export function createScriptLogger(
  name: string,
  options: { env?: NodeJS.ProcessEnv; destination?: pino.DestinationStream } = {},
): pino.Logger {
  const resolved = loggerOptionsFromEnv(options.env ?? process.env, { defaultServiceName: name });
  // Never a worker-thread transport here: a script may exit right after its last line, and a pretty transport would lose it.
  const pinoOptions = createPinoOptions(resolved);
  return options.destination ? pino(pinoOptions, options.destination) : pino(pinoOptions);
}
