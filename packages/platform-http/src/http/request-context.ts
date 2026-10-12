/**
 * Per-request context the {@link GlobalExceptionFilter} needs to enrich the error envelope.
 *
 * **Binding it is optional.** Unbound, the filter reads the request context store that
 * `enableCorrelationId` seeds and the authentication layer fills with `setRequestPrincipal`, which is what
 * every other part of this package reads too. Bind `REQUEST_CONTEXT` only to read from somewhere else.
 */
export interface RequestContextAccessor {
  getCorrelationId(): string | undefined;
  getUserId(): string | undefined;
}

/** DI token for the {@link RequestContextAccessor}. */
export const REQUEST_CONTEXT = Symbol('REQUEST_CONTEXT');
