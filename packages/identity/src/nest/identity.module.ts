import {
  type DynamicModule,
  Inject,
  Module,
  type OnModuleInit,
  type Provider,
} from '@nestjs/common';
import { APP_GUARD, HttpAdapterHost } from '@nestjs/core';
import type { FastifyInstance } from 'fastify';
import type { Identity } from '../create-identity';
import { registerAuthHandler } from './fastify-mount';
import { AUTH, PRINCIPAL_HOOK, SessionGuard, type PrincipalHook } from './session.guard';

export interface IdentityModuleAsyncOptions {
  imports?: DynamicModule['imports'];
  inject?: Array<string | symbol | (new (...args: never[]) => unknown)>;
  useFactory: (...args: never[]) => Identity | Promise<Identity>;
  /**
   * Adds the product's fields (a workspace, a role ...) to the principal that `SessionGuard` writes into
   * the request context. See {@link PrincipalHook}. Optional; without it the context holds the user and
   * session ids.
   */
  principal?: PrincipalHook | PrincipalHookFactory;
}

/** A hook built with the rest of the application's providers: `{ inject: [WorkspaceService], useFactory }`. */
export interface PrincipalHookFactory {
  inject?: Array<string | symbol | (new (...args: never[]) => unknown)>;
  useFactory: (...args: never[]) => PrincipalHook | Promise<PrincipalHook>;
}

/** Mounts the handler once Nest has its Fastify instance; provides `AUTH` and the global guard. */
@Module({})
export class IdentityModule implements OnModuleInit {
  constructor(
    @Inject(AUTH) private readonly auth: Identity,
    @Inject(HttpAdapterHost) private readonly host: HttpAdapterHost,
  ) {}

  async onModuleInit(): Promise<void> {
    await registerAuthHandler(this.host.httpAdapter.getInstance() as FastifyInstance, this.auth);
  }

  static forRootAsync(options: IdentityModuleAsyncOptions): DynamicModule {
    const authProvider: Provider = {
      provide: AUTH,
      useFactory: options.useFactory,
      inject: options.inject ?? [],
    };
    return {
      module: IdentityModule,
      global: true,
      imports: options.imports ?? [],
      providers: [
        authProvider,
        principalProvider(options.principal),
        { provide: APP_GUARD, useClass: SessionGuard },
      ],
      exports: [AUTH],
    };
  }
}

function principalProvider(principal: IdentityModuleAsyncOptions['principal']): Provider {
  if (principal === undefined) return { provide: PRINCIPAL_HOOK, useValue: null };
  if (typeof principal === 'function') return { provide: PRINCIPAL_HOOK, useValue: principal };
  return {
    provide: PRINCIPAL_HOOK,
    useFactory: principal.useFactory,
    inject: principal.inject ?? [],
  };
}
