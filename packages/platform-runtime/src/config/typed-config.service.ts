import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Typed wrapper over `ConfigService`, so callers get `Env[K]` rather than a raw string.
 *
 * GENERIC BASE, NOT A CONCRETE SERVICE — the products' copies differed only in which
 * `Env` type they imported, and that type is product vocabulary (each service's own
 * variable set), so it cannot come from here. A product subclasses with its own:
 *
 * ```ts
 * import { TypedConfigService } from '@quynhonsemiconductor/platform-runtime';
 * import type { Env } from './env.schema';
 *
 * @Injectable()
 * export class AppConfigService extends TypedConfigService<Env> {}
 * ```
 *
 * Nest resolves the inherited constructor, so the subclass needs no body — and
 * because it is a real named class, it works as a DI token exactly as before.
 * `@Injectable()` on the base is what makes its constructor metadata available to
 * that subclass; without it Nest cannot see the `ConfigService` dependency.
 */
@Injectable()
export class TypedConfigService<TEnv extends Record<string, unknown>> {
  constructor(private readonly config: ConfigService<TEnv, true>) {}

  /**
   * Read a validated variable.
   *
   * `infer: true` is what preserves the value's real type; without it `ConfigService`
   * widens everything to `string | undefined` and the wrapper buys nothing. The
   * schema has already run at boot, so a key present in `TEnv` is present here — an
   * absent one fails the deploy rather than returning `undefined` at the call site.
   */
  get<K extends keyof TEnv & string>(key: K): TEnv[K] {
    // `& string` on the key, because `ConfigService`'s own `KeyOf`/`Path` helpers are
    // string-keyed while a bare `keyof` also admits `number | symbol`. An environment
    // is string-keyed by construction, so this narrows rather than restricts.
    //
    // The cast is on the RECEIVER, not the result, and it is doing one specific job:
    // `ConfigService.get`'s overload takes `Path<TEnv>`, a recursive dotted-path type
    // that TypeScript can only evaluate against a CONCRETE object. `TEnv` here is an
    // unresolved type parameter, so `keyof TEnv & string` cannot be proven to satisfy
    // it even though every real instantiation does — the products' own non-generic
    // copies compile against the same overload without complaint.
    //
    // Narrowed to exactly the member used, so this cannot silently absorb a future
    // signature change to the rest of `ConfigService`. The public method above stays
    // exactly typed, which is the part callers depend on.
    const config = this.config as unknown as {
      get(propertyPath: K, options: { infer: true }): TEnv[K];
    };
    return config.get(key, { infer: true });
  }
}
