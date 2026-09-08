/**
 * Request-arrival timing — splits "the request was slow" into the parts that have
 * different owners.
 *
 * The access log used to carry ONE number: the interceptor's own duration. That
 * timer starts after Fastify has already parsed the body, so it measures the handler
 * and nothing else. When production showed `TargetResponseTime` of 2-27s on the SCM
 * webhook route, the app logged `202 3ms` for the same requests — and both were
 * true, which made the log actively misleading: it looked like proof the app was
 * innocent when it simply had not been watching the interval in question.
 *
 * Three timestamps bound that interval, and the ALB hands us the first one for free.
 * `X-Amzn-Trace-Id` is `Root=1-<8 hex>-<24 hex>`, where the 8-hex segment is the UNIX
 * second at which the load balancer received the request. So each request can compute
 * its own ALB-to-app delay with no log correlation, no X-Ray, and no extra network
 * call:
 *
 *   albWaitMs   ALB received  -> headers reached this process   (proxy / network)
 *   bodyWaitMs  headers       -> Nest pipeline entry            (body receipt)
 *   duration    pipeline      -> response                       (this app)
 *
 * A large `albWaitMs` means the request was held before the app ever saw it, which is
 * not something application code can fix. A large `bodyWaitMs` means the body
 * trickled in. A large `duration` is ours.
 *
 * Resolution is deliberately uneven: the trace id carries only whole seconds, so
 * `albWaitMs` is +/-1s and useless for sub-second work. It exists to characterise
 * multi-second stalls, where a 1s error does not change the conclusion — which is why
 * it is not reported at all below `ALB_WAIT_REPORTING_FLOOR_MS`. See `albWaitMs()`.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';

/**
 * Stashed on the request object rather than in a WeakMap keyed by request: Fastify
 * reuses neither, and a property is visible in a debugger next to the rest of the
 * request state. Prefixed because it shares a namespace with Fastify's own fields.
 */
const ARRIVAL_KEY = 'qnscArrivalAtMs';

/**
 * Stamp each request as its headers arrive.
 *
 * `onRequest` is the EARLIEST hook in Fastify's lifecycle — before body parsing,
 * before validation, before routing runs its preHandler chain. That is the point of
 * it: anything later would fold body-receipt time into the arrival timestamp and
 * collapse the two intervals this module exists to separate.
 */
export function registerRequestTiming(app: FastifyInstance): void {
  app.addHook('onRequest', (req, _reply, done) => {
    (req as unknown as Record<string, number>)[ARRIVAL_KEY] = Date.now();
    done();
  });
}

/** Epoch ms at which this process first saw the request's headers, if stamped. */
export function arrivalAtMs(req: FastifyRequest): number | undefined {
  return (req as unknown as Record<string, number | undefined>)[ARRIVAL_KEY];
}

/**
 * Epoch ms at which the ALB received the request, decoded from `X-Amzn-Trace-Id`.
 *
 * Returns undefined rather than throwing or guessing for every shape that is not an
 * ALB-issued root id — absent header (local dev, direct calls), a client-supplied
 * trace id, or a `Self=`/`Root=` variant whose first segment is not 8 hex digits.
 * The caller then omits the field, which is honest; a fabricated 0 would read as
 * "no delay" and quietly poison exactly the number this is for.
 */
/**
 * Floor below which the ALB-to-app gap is not reported.
 *
 * The trace id carries whole seconds, so the decoded receive time is truncated by up
 * to 1000ms and the computed gap inherits all of it. Measured on real traffic the
 * field sat at a median of ~500ms — exactly the mean of a uniform truncation error,
 * and precisely what a request with NO delay looks like.
 *
 * That is worse than not reporting it. The module docstring explains the caveat, but a
 * log line does not carry its module's docstring, and `albWaitMs=636` reads as
 * two-thirds of a second of proxy delay to anyone scanning output during an incident.
 * The whole point of this instrumentation was to stop latency being misattributed, so
 * a field that invites misattribution is self-defeating.
 *
 * 1000ms because that is the quantisation width: above it, the value cannot be an
 * artefact of truncation alone and means something real happened.
 */
export const ALB_WAIT_REPORTING_FLOOR_MS = 1000;

/**
 * The ALB-to-app gap, reported only when it is large enough to be a signal rather
 * than the trace id's rounding error. Undefined means "nothing worth saying" — either
 * a timestamp was missing, or the gap is inside the noise floor.
 */
export function albWaitMs(
  arrivalAt: number | undefined,
  albReceivedAt: number | undefined,
): number | undefined {
  if (arrivalAt === undefined || albReceivedAt === undefined) return undefined;
  const gap = arrivalAt - albReceivedAt;
  return gap >= ALB_WAIT_REPORTING_FLOOR_MS ? gap : undefined;
}

export function albReceivedAtMs(traceId: string | undefined): number | undefined {
  if (!traceId) return undefined;
  const match = /Root=1-([0-9a-f]{8})-[0-9a-f]{24}/i.exec(traceId);
  if (!match) return undefined;
  const seconds = Number.parseInt(match[1], 16);
  return Number.isSafeInteger(seconds) && seconds > 0 ? seconds * 1000 : undefined;
}
