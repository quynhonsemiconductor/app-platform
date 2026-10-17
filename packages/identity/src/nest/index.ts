export {
  IdentityModule,
  type IdentityModuleAsyncOptions,
  type PrincipalHookFactory,
} from './identity.module';
export {
  AUTH,
  CurrentSession,
  CurrentUser,
  markPreAuthenticated,
  Public,
  PRINCIPAL_HOOK,
  SessionGuard,
  type PrincipalExtras,
  type PrincipalHook,
  type RequestWithSession,
} from './session.guard';
export { AuthApiErrorFilter, toDomainException } from './errors';
export { registerAuthHandler } from './fastify-mount';
export { checkIdentityReady } from './readiness';
export { identityLoggerFrom, observabilitySecurityEvents } from './observability';
