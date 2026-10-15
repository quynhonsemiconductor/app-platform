import { Module, type DynamicModule } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import { createLoggerOptions } from './logger.factory';
import { loggerOptionsFromEnv } from './logger-env';

/**
 * The whole logging setup of a Nest process, with no parameters: `service`, `env`, `version`, level and pretty-printing come from
 * the environment by convention (see {@link loggerOptionsFromEnv}). `createHttpApp` / `createWorkerApp` (platform-runtime) register
 * it around the product's root module and install it with `app.useLogger(...)`, so a product does not import it at all.
 *
 * `LoggerModule` is global, so `Logger` / `PinoLogger` are injectable everywhere once this is registered.
 */
@Module({})
export class LoggingModule {
  static forRoot(
    env: NodeJS.ProcessEnv = process.env,
    defaults: { defaultServiceName?: string } = {},
  ): DynamicModule {
    return {
      module: LoggingModule,
      imports: [LoggerModule.forRoot(createLoggerOptions(loggerOptionsFromEnv(env, defaults)))],
    };
  }
}
