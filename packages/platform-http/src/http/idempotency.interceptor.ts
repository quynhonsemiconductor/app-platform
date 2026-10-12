import {
  type CallHandler,
  type ExecutionContext,
  Inject,
  Injectable,
  Logger,
  type NestInterceptor,
  type OnApplicationBootstrap,
  StreamableFile,
  UseInterceptors,
} from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { type Observable, defer, from } from 'rxjs';
import { concatMap, finalize, mergeMap } from 'rxjs/operators';
import { CacheService } from '@quynhonsemiconductor/platform-cache';
import { HttpErrorCodes } from '../errors/error-codes';
import { ConflictException, DomainException } from '../errors/exceptions';
import {
  IDEMPOTENCY_MODE_ENV,
  assertCacheInProduction,
  readIdempotencyLeaseSeconds,
  readIdempotencyMode,
  type IdempotencyMode,
} from './cache-requirement';
import { clientIp } from './client-ip';
import { currentUserId } from './principal';
import { assertEdgeClientIpEnv } from './edge-client-ip';
import { requestFingerprint } from './idempotency.fingerprint';

/** How long a completed response stays replayable (24 hours): a retry window, not a cache. */
const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;

/** Only mutating methods carry idempotency semantics. */
const IDEMPOTENCY_METHODS = new Set(['POST', 'PUT']);

/** The header a client reads to learn the response is a replay. Expose it in the product's CORS config. */
export const IDEMPOTENCY_REPLAYED_HEADER = 'x-idempotent-replayed';

/** A response larger than this many BYTES (serialized) is not stored: the request is then not replayable. */
export const MAX_STORED_RESPONSE_BYTES = 256 * 1024;

/**
 * The response headers that are replayed with a stored response: what tells the client where the created thing
 * is, which version it is, and how to read the body. NEVER `Set-Cookie` (a replay must not mint or rotate a
 * session) or hop-by-hop headers: an allow-list, not a deny-list.
 */
export const REPLAYED_RESPONSE_HEADERS = ['location', 'etag', 'content-type'] as const;

/**
 * One round trip, atomic: the stored record if there is one, else claim the key, else say it is held. Reading and
 * claiming apart left a window in which a request that completed between the two was run AGAIN.
 * KEYS: record, claim. ARGV: token, lease seconds. Returns {'record', json} | {'claimed'} | {'held'}.
 */
const READ_OR_CLAIM = `
local record = redis.call('get', KEYS[1])
if record then return {'record', record} end
if redis.call('set', KEYS[2], ARGV[1], 'EX', ARGV[2], 'NX') then return {'claimed'} end
return {'held'}`;

/** Delete the claim only if it is still ours: a late finisher must not free someone else's claim. */
const RELEASE_IF_OURS =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

/** Push the lease out only if the claim is still ours. */
const RENEW_IF_OURS =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('expire', KEYS[1], ARGV[2]) else return 0 end";

/** What is stored per key: the question it answered, and the answer, or the fact that there is none to give. */
interface StoredResponse {
  v: 1;
  /** {@link requestFingerprint} of the request that produced it. */
  f: string;
  /** The status the response was sent with. */
  s: number;
  /** The body (absent for an empty response, and for a marker). */
  b?: unknown;
  /** The replayable headers (see {@link REPLAYED_RESPONSE_HEADERS}). */
  h?: Record<string, string>;
  /**
   * Present on a MARKER: the request completed, with status `s`, but its response cannot be replayed (a stream or a
   * file, a body too large to keep, or one that does not serialize). A retry gets 409, never a second execution.
   */
  m?: 'not-replayable';
}

type Decision =
  | { kind: 'pass' }
  | { kind: 'replay'; stored: StoredResponse }
  | { kind: 'not-replayable'; stored: StoredResponse }
  | { kind: 'run'; recordKey: string; claimKey: string; claim: string; fingerprint: string };

/**
 * IdempotencyInterceptor
 *
 * Reads the `Idempotency-Key` header on POST/PUT. The first request with a key runs and its response (status,
 * body and a few headers) is stored for 24 hours; a repeat returns that stored response with
 * `X-Idempotent-Replayed: true` instead of running the handler again.
 *
 * What makes it a guarantee and not a response cache:
 *
 * 1. **The request is fingerprinted** (method, URL, body, with object keys sorted). The same key with a
 *    different request is refused with `422 IDEMPOTENCY_KEY_REUSED`; the first response is never served for it.
 * 2. **A concurrent copy is not run, and neither is a completed one.** One atomic script reads the record or
 *    claims the key (`SET NX EX`, a lease of `IDEMPOTENCY_LEASE_SECONDS`, default 60). A second request while the
 *    first is still running gets `409 IDEMPOTENCY_IN_FLIGHT` with `Retry-After`. The lease is RENEWED (compare
 *    and expire on a random token) while the handler runs, so a request may take longer than the lease; the claim
 *    is released by compare-and-delete on the same token, so a request that lost its claim cannot free the
 *    successor's. A pod killed mid-request frees the key when the lease runs out.
 * 3. **Only successes are stored** (a 2xx that was sent). A failed request leaves nothing behind, so the retry
 *    it is entitled to executes.
 * 4. **A response that cannot be replayed is still recorded as done.** A stream, a file (`StreamableFile`), a
 *    `Buffer`, a body over {@link MAX_STORED_RESPONSE_BYTES} bytes or one that does not serialize is stored as a
 *    MARKER with its status and no body: a retry gets `409 IDEMPOTENCY_NOT_REPLAYABLE` (with the original
 *    status in `details`), never a second execution, and nothing about the response (a server path inside a
 *    stream's JSON, say) is written to the cache.
 *
 * It fails OPEN, never closed: an unreachable cache, or any error reading the key or taking the claim, is
 * logged and the request runs as if there were no key, because refusing every mutation while Valkey is down
 * is worse than losing the guarantee for that window. An error STORING the response is logged too; the
 * request already succeeded and its retry will run again.
 *
 * **Replay and the other interceptors.** On a replay the handler and everything inside this interceptor
 * (interceptors registered AFTER it, pipes, the handler) do NOT run; the stored value is emitted through the
 * interceptors registered BEFORE it (outer), exactly as a fresh response would be. The stored value is what THIS
 * interceptor saw, so a response transformer registered after it has already been applied to it and is not
 * applied twice; one registered before it is applied on every replay. An audit or metrics interceptor placed
 * inside this one does not see replays; one outside does (the access log logs a replay with the stored status).
 * Guards run on a replay as on any request: a replay is never served to someone the guards refuse.
 *
 * Replayed headers: `Location`, `ETag` and `Content-Type` if the handler set them, never `Set-Cookie`.
 *
 * Cache key: `idem:{userId}:{sha256(method, url, key)}`, so no header value reaches a Redis key. The user is
 * the principal (`setRequestPrincipal`); an anonymous caller is told apart by a hash of address and agent.
 *
 * Usage (opt-in per route): `@UseIdempotency()`. Usage (global): register as `APP_INTERCEPTOR`.
 *
 * Cache requirement: with `NODE_ENV=production` the application FAILS AT STARTUP if `CacheModule` has no
 * connection, because a retry-safe endpoint that is not retry-safe is worse than one that never claimed to
 * be. `IDEMPOTENCY_MODE=disabled` declares that on purpose; the interceptor then passes everything through.
 *
 * A browser client needs `Idempotency-Key` in the CORS `allowedHeaders` and `X-Idempotent-Replayed` in
 * `exposedHeaders`; without them the preflight fails or the answer cannot be read.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor, OnApplicationBootstrap {
  private readonly logger = new Logger(IdempotencyInterceptor.name);
  /** Read once, at construction, so a typo in the setting fails at startup too. */
  private readonly mode: IdempotencyMode = readIdempotencyMode();
  private readonly leaseSeconds: number = readIdempotencyLeaseSeconds();

  constructor(@Inject(CacheService) private readonly cache: CacheService) {}

  onApplicationBootstrap(): void {
    assertEdgeClientIpEnv(); // a bad EDGE_CLIENT_IP_SECRET stops the application, wherever clientIp() is used
    if (this.mode === 'disabled') {
      this.logger.warn(`${IDEMPOTENCY_MODE_ENV}=disabled: Idempotency-Key is not honoured`);
      return;
    }
    assertCacheInProduction(
      this.cache,
      'IdempotencyInterceptor',
      `${IDEMPOTENCY_MODE_ENV}=disabled`,
    );
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (this.mode === 'disabled') return next.handle();
    if (context.getType() !== 'http') return next.handle();

    const http = context.switchToHttp();
    const req = http.getRequest<FastifyRequest>();
    if (!IDEMPOTENCY_METHODS.has(req.method)) return next.handle();

    const headerVal = req.headers['idempotency-key'];
    const idempotencyKey = Array.isArray(headerVal) ? headerVal[0] : headerVal;
    if (!idempotencyKey) return next.handle();

    const reply = http.getResponse<FastifyReply>();
    return defer(() => from(this.begin(req, idempotencyKey, reply))).pipe(
      mergeMap((decision) => {
        if (decision.kind === 'pass') return next.handle();
        if (decision.kind === 'replay') {
          void reply.header(IDEMPOTENCY_REPLAYED_HEADER, 'true');
          for (const [name, value] of Object.entries(decision.stored.h ?? {})) {
            if ((REPLAYED_RESPONSE_HEADERS as readonly string[]).includes(name)) {
              void reply.header(name, value);
            }
          }
          void reply.status(decision.stored.s);
          this.logger.debug({ msg: 'idempotency: replay', status: decision.stored.s });
          return from([decision.stored.b]);
        }
        if (decision.kind === 'not-replayable') {
          void reply.header(IDEMPOTENCY_REPLAYED_HEADER, 'true');
          throw new DomainException(
            HttpErrorCodes.IDEMPOTENCY_NOT_REPLAYABLE,
            'This request already completed, but its response cannot be replayed. Do not send it again; read the result instead.',
            'CONFLICT',
            [{ originalStatus: decision.stored.s }],
          );
        }
        return this.run(decision, next, reply);
      }),
    );
  }

  /** Run the handler under the claim: renew the lease, store the outcome, release. */
  private run(
    decision: Extract<Decision, { kind: 'run' }>,
    next: CallHandler,
    reply: FastifyReply,
  ): Observable<unknown> {
    return defer(() => {
      const renewing = setInterval(
        () => void this.renew(decision),
        Math.max(1, Math.floor(this.leaseSeconds / 3)) * 1000,
      );
      renewing.unref();
      return next.handle().pipe(
        // `concatMap`: the outcome is stored BEFORE the claim is released, or a retry could slip in between the
        // two and run again.
        concatMap(async (body) => {
          await this.store(decision, reply, body);
          return body;
        }),
        finalize(() => {
          clearInterval(renewing);
          void this.release(decision);
        }),
      );
    });
  }

  /** Decide: run, replay, pass through (cache trouble), or refuse. Throws only the refusals. */
  private async begin(
    req: FastifyRequest,
    idempotencyKey: string,
    reply: FastifyReply,
  ): Promise<Decision> {
    const who =
      currentUserId() ??
      createHash('sha256')
        .update(`${clientIp(req)}:${req.headers['user-agent'] ?? ''}`)
        .digest('hex')
        .slice(0, 16);
    const digest = createHash('sha256')
      .update(`${req.method}\n${req.url}\n${idempotencyKey}`)
      .digest('hex')
      .slice(0, 32);
    const recordKey = `idem:${who}:${digest}`;
    const claimKey = `${recordKey}:claim`;
    const fingerprint = requestFingerprint({
      method: req.method,
      url: req.url,
      body: req.body,
      headers: req.headers,
    });

    const claim = randomBytes(16).toString('hex');
    let outcome: unknown;
    try {
      outcome = await this.cache.instance.eval(
        READ_OR_CLAIM,
        2,
        recordKey,
        claimKey,
        claim,
        this.leaseSeconds,
      );
    } catch (err) {
      // Fail open: a cache that cannot answer must not stop the mutation.
      this.logger.warn({ msg: 'idempotency: cache unavailable; running without protection', err });
      return { kind: 'pass' };
    }

    const [kind, raw] = Array.isArray(outcome) ? (outcome as [unknown, unknown]) : [];
    if (kind === 'record') {
      const stored = typeof raw === 'string' ? parseStored(raw) : null;
      if (stored) {
        if (stored.f !== fingerprint) throw keyReused();
        return stored.m ? { kind: 'not-replayable', stored } : { kind: 'replay', stored };
      }
      // A corrupt entry is a miss: run, unprotected for this key (the claim was not taken).
      this.logger.warn({ msg: 'idempotency: unreadable stored entry; running without protection' });
      return { kind: 'pass' };
    }
    if (kind === 'held') {
      void reply.header('Retry-After', String(Math.min(this.leaseSeconds, 5)));
      throw new ConflictException(
        HttpErrorCodes.IDEMPOTENCY_IN_FLIGHT,
        'A request with this Idempotency-Key is still in progress. Retry shortly.',
      );
    }
    if (kind !== 'claimed') {
      this.logger.warn({
        msg: 'idempotency: unexpected answer from the cache; running unprotected',
      });
      return { kind: 'pass' };
    }
    return { kind: 'run', recordKey, claimKey, claim, fingerprint };
  }

  /**
   * Keep the outcome for a retry: the response, or a marker when there is none to give. Never throws: the request
   * has already succeeded.
   */
  private async store(
    decision: Extract<Decision, { kind: 'run' }>,
    reply: FastifyReply,
    body: unknown,
  ): Promise<void> {
    const status = reply.statusCode;
    if (status < 200 || status > 299) return;
    try {
      const record = this.recordFor(decision.fingerprint, status, body, reply);
      await this.cache.instance.set(
        decision.recordKey,
        JSON.stringify(record),
        'EX',
        IDEMPOTENCY_TTL_SECONDS,
      );
    } catch (err) {
      this.logger.warn({ msg: 'idempotency: failed to store the response', err });
    }
  }

  private recordFor(
    fingerprint: string,
    status: number,
    body: unknown,
    reply: FastifyReply,
  ): StoredResponse {
    const marker: StoredResponse = { v: 1, f: fingerprint, s: status, m: 'not-replayable' };
    if (!isSerializableBody(body)) {
      this.logger.warn({
        msg: 'idempotency: a stream or binary response cannot be replayed; recording it as done',
      });
      return marker;
    }
    let json: string | undefined;
    try {
      json = JSON.stringify({
        v: 1,
        f: fingerprint,
        s: status,
        b: body,
        h: replayableHeaders(reply),
      });
    } catch {
      json = undefined; // circular, BigInt ...
    }
    if (json === undefined) {
      this.logger.warn({
        msg: 'idempotency: the response does not serialize; recording it as done',
      });
      return marker;
    }
    const bytes = Buffer.byteLength(json, 'utf8');
    if (bytes > MAX_STORED_RESPONSE_BYTES) {
      this.logger.warn({
        msg: 'idempotency: response too large to store; recording it as done',
        bytes,
      });
      return marker;
    }
    return JSON.parse(json) as StoredResponse;
  }

  /** Extend the lease while the handler runs, if the claim is still ours. Never throws. */
  private async renew(decision: Extract<Decision, { kind: 'run' }>): Promise<void> {
    try {
      const renewed = Number(
        await this.cache.instance.eval(
          RENEW_IF_OURS,
          1,
          decision.claimKey,
          decision.claim,
          this.leaseSeconds,
        ),
      );
      if (renewed !== 1) {
        this.logger.warn({ msg: 'idempotency: the claim was lost while the request was running' });
      }
    } catch (err) {
      this.logger.warn({ msg: 'idempotency: failed to renew the claim', err });
    }
  }

  /** Free the claim if it is still ours. Never throws. */
  private async release(decision: Extract<Decision, { kind: 'run' }>): Promise<void> {
    try {
      await this.cache.instance.eval(RELEASE_IF_OURS, 1, decision.claimKey, decision.claim);
    } catch (err) {
      // The lease frees it anyway.
      this.logger.warn({ msg: 'idempotency: failed to release the claim; the lease will', err });
    }
  }
}

/**
 * Can this value be stored as JSON and replayed? Not a stream, a file or binary data: `JSON.stringify` of those
 * is a dump of their internals (a `StreamableFile` carries the stream and with it the file's server path; a
 * `Buffer` becomes a byte array), which must never reach the cache.
 */
function isSerializableBody(body: unknown): boolean {
  if (body === undefined || body === null) return true;
  if (typeof body !== 'object') return typeof body !== 'function' && typeof body !== 'symbol';
  if (body instanceof StreamableFile) return false;
  if (Buffer.isBuffer(body) || ArrayBuffer.isView(body) || body instanceof ArrayBuffer)
    return false;
  const candidate = body as { pipe?: unknown; getReader?: unknown };
  if (typeof candidate.pipe === 'function' || typeof candidate.getReader === 'function')
    return false;
  if (typeof (body as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === 'function')
    return false;
  return true;
}

/** The headers of {@link REPLAYED_RESPONSE_HEADERS} the handler set, as plain safe strings. */
function replayableHeaders(reply: FastifyReply): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const name of REPLAYED_RESPONSE_HEADERS) {
    const value = reply.getHeader?.(name);
    // A string with no CR/LF or control characters, of reasonable length; anything else is dropped.
    if (
      typeof value === 'string' &&
      value.length > 0 &&
      value.length <= 2048 &&
      // eslint-disable-next-line no-control-regex
      !/[\u0000-\u001f\u007f]/.test(value)
    ) {
      out[name] = value;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function parseStored(raw: string): StoredResponse | null {
  try {
    const value = JSON.parse(raw) as Partial<StoredResponse> | null;
    if (value && value.v === 1 && typeof value.f === 'string' && typeof value.s === 'number') {
      return value as StoredResponse;
    }
  } catch {
    /* a corrupt entry is a miss */
  }
  return null;
}

function keyReused(): DomainException {
  return new DomainException(
    HttpErrorCodes.IDEMPOTENCY_KEY_REUSED,
    'This Idempotency-Key was already used for a different request.',
    'VALIDATION_FAILED',
  );
}

/** Convenience decorator — apply {@link IdempotencyInterceptor} to a single route. */
export const UseIdempotency = () => UseInterceptors(IdempotencyInterceptor);
