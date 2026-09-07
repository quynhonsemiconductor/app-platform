import { Global, Module, type DynamicModule, type Type } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { createEnvValidator, type EnvSchemaLike } from './env-validator';

export interface AppConfigModuleOptions<TEnv> {
  /** The product's environment schema. Anything with a conforming `safeParse`. */
  readonly schema: EnvSchemaLike<TEnv>;
  /**
   * The product's `TypedConfigService` subclass.
   *
   * Passed in rather than provided from here because it carries the product's own
   * `Env` type, and because it is the DI token the product's own code injects — a
   * token minted inside this package would not be the class a consumer imports.
   */
  readonly service: Type<unknown>;
}

/**
 * `ConfigModule.forRoot` plus schema validation, as one call.
 *
 * `@Global()` matches both products' existing modules: configuration is read
 * everywhere, and re-importing it into every feature module is noise that eventually
 * gets forgotten in exactly one place.
 *
 * A product that needs to add its own providers should skip this and compose
 * `createEnvValidator` directly — that is the piece worth sharing, and this module is
 * only the boilerplate around it.
 */
@Global()
@Module({})
export class AppConfigModule {
  static forRoot<TEnv>(options: AppConfigModuleOptions<TEnv>): DynamicModule {
    return {
      module: AppConfigModule,
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          validate: createEnvValidator(options.schema) as (
            env: Record<string, unknown>,
          ) => Record<string, unknown>,
        }),
      ],
      providers: [options.service],
      exports: [options.service],
    };
  }
}
