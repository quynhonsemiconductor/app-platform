import { AsyncLocalStorage } from 'async_hooks';

/**
 * The request context's storage, as a leaf with NO Nest import: the logger factory reads it for every line, and the script logger (and so
 * a migrator that has no Nest) must not pull `@nestjs/*` in through it. `request-context.ts` re-exports both.
 */
export interface RequestContext {
  workspaceId: string | undefined;
  userId: string | undefined;
  sessionId: string | undefined;
  correlationId: string;
  /** W3C traceparent from inbound request */
  traceparent: string | undefined;
  /**
   * Fields a product adds to the authenticated principal (see {@link setRequestPrincipal}): they are put on
   * every log line of the request. Bounded and validated when set; read-only afterwards.
   */
  principalFields?: Readonly<Record<string, string | number | boolean>> | undefined;
}

/**
 * The AsyncLocalStorage holding per-request (or per-job) context.
 *
 * Exported so the pino mixin can read it without going through DI — a logger has
 * no injection point. Do NOT write to it directly: use {@link RequestContextService}
 * for requests and `withJobContext` for background work.
 */
export const requestContextStorage = new AsyncLocalStorage<RequestContext>();
