import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  Logger,
  Optional,
  SetMetadata,
  createParamDecorator,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { fromNodeHeaders } from 'better-auth/node';
import { setRequestPrincipal } from '@quynhonsemiconductor/observability';
import { UnauthorizedException } from '@quynhonsemiconductor/platform-http';
import type { FastifyRequest } from 'fastify';
import type { Identity } from '../create-identity';

export const AUTH = Symbol.for('@quynhonsemiconductor/identity:auth');
const PUBLIC = 'identity:public';

/** Set by platform-http's RateLimitGuard when it keyed a caller by address (`Symbol.for`, so no import). */
const KEYED_BY_ADDRESS = Symbol.for('@quynhonsemiconductor/platform-http:keyed-by-address');

/** Opt a route out of the global {@link SessionGuard}. */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(PUBLIC, true);

type SessionResult = NonNullable<Awaited<ReturnType<Identity['api']['getSession']>>>;
export type RequestWithSession = FastifyRequest & { session?: SessionResult };

/** DI token of the optional {@link PrincipalHook}; `IdentityModule.forRootAsync({ principal })` provides it. */
export const PRINCIPAL_HOOK = Symbol.for('@quynhonsemiconductor/identity:principal-hook');

/** What a product adds to the principal of a request (see {@link PrincipalHook}). */
export interface PrincipalExtras {
  /** The product's tenant/workspace; goes on every log line as `workspaceId`. */
  workspaceId?: string | undefined;
  /** Further log fields: at most 8, `[a-z][A-Za-z0-9_.]{0,39}`, string/number/boolean values. */
  fields?: Record<string, string | number | boolean> | undefined;
}

/**
 * Called by the {@link SessionGuard} once a session is resolved, to let the product add fields to the
 * principal that is written into the request context (observability only: nothing here authorizes
 * anything). It replaces the product's own session-principal bridge. It must be quick and must not
 * throw; if it does, or returns something invalid, the request goes on with the user and session ids
 * alone and one warning (the error class, never its message) is logged.
 */
export type PrincipalHook = (
  session: SessionResult,
) => PrincipalExtras | undefined | void | Promise<PrincipalExtras | undefined | void>;

/** The authenticated `{ session, user }`; only valid on a non-`@Public()` route. */
export const CurrentSession = createParamDecorator((_data: unknown, ctx: ExecutionContext) => {
  return ctx.switchToHttp().getRequest<RequestWithSession>().session;
});

/** The authenticated user. */
export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext) => {
  return ctx.switchToHttp().getRequest<RequestWithSession>().session?.user;
});

/**
 * Global guard: every route needs a session unless marked `@Public()`. Authentication only —
 * authorization stays in the product's own guard, which reads `@CurrentSession()`.
 */
@Injectable()
export class SessionGuard implements CanActivate {
  private readonly logger = new Logger('SessionGuard');

  constructor(
    @Inject(AUTH) private readonly auth: Identity,
    @Inject(Reflector) private readonly reflector: Reflector,
    @Optional() @Inject(PRINCIPAL_HOOK) private readonly principalHook?: PrincipalHook | null,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC, [ctx.getHandler(), ctx.getClass()])) {
      return true;
    }
    const req = ctx.switchToHttp().getRequest<RequestWithSession>();
    const session = await this.auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
    if (!session) throw new UnauthorizedException('AUTH_UNAUTHENTICATED', 'Sign in required');
    req.session = session;
    await this.writePrincipal(session, req);
    return true;
  }

  /**
   * The contract with `platform-http`: who the caller is lives in the request context (userId and
   * sessionId, never the session token), and the rate limit, the idempotency key, the access log and the
   * exception filter read it from there. A no-op when nothing seeded a context (`enableCorrelationId`).
   */
  private async writePrincipal(session: SessionResult, req: object): Promise<void> {
    const base = { userId: session.user.id, sessionId: session.session.id };
    let extras: PrincipalExtras | undefined | void;
    try {
      extras = await this.principalHook?.(session);
    } catch (error) {
      this.hookFailed(error);
    }
    // `base` LAST: a hook can add a workspace and fields, never overwrite the user or the session.
    let written: boolean;
    try {
      written = setRequestPrincipal({ ...extras, ...base });
    } catch (error) {
      this.hookFailed(error);
      written = setRequestPrincipal(base);
    }
    if (!written) this.warnOnce('no-context');
    else if ((req as unknown as Record<symbol, unknown>)[KEYED_BY_ADDRESS])
      this.warnOnce('too-late');
  }

  private hookFailed(error: unknown): void {
    this.logger.warn(
      `The principal hook failed or returned an invalid value (${error instanceof Error ? error.constructor.name : typeof error}); the request continues with the user and session ids only`,
    );
  }

  private readonly warned = new Set<string>();
  private warnOnce(kind: 'no-context' | 'too-late'): void {
    if (this.warned.has(kind)) return;
    this.warned.add(kind);
    this.logger.warn(
      kind === 'no-context'
        ? 'The session resolved but there is no request context to record the principal in, so platform-http cannot tell who is calling (rate limit by address, no userId in the access log). Call enableCorrelationId(app) before listen().'
        : 'RateLimitGuard ran BEFORE SessionGuard on an authenticated request, so it keyed the caller by address and a whole NAT shares one bucket. A guard in the root module runs before the ones in imported modules: register RateLimitGuard (APP_GUARD) in a module imported AFTER IdentityModule (see "The principal in the request context" in the identity README).',
    );
  }
}
