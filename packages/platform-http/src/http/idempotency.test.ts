import 'reflect-metadata';
import { StreamableFile, type CallHandler, type ExecutionContext } from '@nestjs/common';
import { Readable } from 'node:stream';
import { CacheService } from '@quynhonsemiconductor/platform-cache';
import { setRequestPrincipal } from '@quynhonsemiconductor/observability';
import { dockerTestsEnabled, startValkey, type ValkeyHarness } from '@quynhonsemiconductor/testing';
import { Subject, firstValueFrom, lastValueFrom, of, throwError, type Observable } from 'rxjs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  IDEMPOTENCY_LEASE_DEFAULT_SECONDS,
  readIdempotencyLeaseSeconds,
} from './cache-requirement';
import { requestFingerprint, canonicalJson } from './idempotency.fingerprint';
import {
  IDEMPOTENCY_REPLAYED_HEADER,
  IdempotencyInterceptor,
  MAX_STORED_RESPONSE_BYTES,
} from './idempotency.interceptor';
import { requestContextStorage } from './request-context.service';

/**
 * The interceptor against a REAL Valkey: the claim is `SET NX EX` and the release is a Lua script, so what is
 * under test is the server's behaviour. Skipped without Docker locally; on CI a missing Docker fails the run.
 */
const dockerEnabled = await dockerTestsEnabled();

interface Call {
  method?: string;
  url?: string;
  body?: unknown;
  key?: string | undefined;
  user?: string | undefined;
  ip?: string;
  agent?: string;
  statusCode?: number;
  headers?: Record<string, string>;
  /** Response headers the handler has already set. */
  responseHeaders?: Record<string, string>;
}

function fakeReply(statusCode = 201, initial: Record<string, string> = {}) {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(initial)) headers[name.toLowerCase()] = value;
  const reply = {
    statusCode,
    header: (name: string, value: string) => {
      headers[name.toLowerCase()] = value;
      return reply;
    },
    getHeader: (name: string) => headers[name.toLowerCase()],
    status: (code: number) => {
      reply.statusCode = code;
      return reply;
    },
  };
  return { reply, headers };
}

function contextFor(call: Call, reply: ReturnType<typeof fakeReply>['reply']): ExecutionContext {
  const key = 'key' in call ? call.key : 'k-1';
  const req = {
    method: call.method ?? 'POST',
    url: call.url ?? '/v1/things',
    body: 'body' in call ? call.body : { name: 'a' },
    ip: call.ip ?? '203.0.113.7',
    headers: {
      ...(key === undefined ? {} : { 'idempotency-key': key }),
      'user-agent': call.agent ?? 'ua',
      ...call.headers,
    },
  };
  return {
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => reply }),
  } as unknown as ExecutionContext;
}

const handlerOf = (value: unknown = { id: 1 }, spy?: () => void): CallHandler => ({
  handle: () => {
    spy?.();
    return of(value);
  },
});

/** Run one request through the interceptor as `call.user` (or anonymous). */
function run(
  interceptor: IdempotencyInterceptor,
  call: Call,
  next: CallHandler,
): {
  result: Promise<unknown>;
  headers: Record<string, string>;
  reply: ReturnType<typeof fakeReply>['reply'];
} {
  const { reply, headers } = fakeReply(call.statusCode ?? 201, call.responseHeaders);
  const ctx = contextFor(call, reply);
  const result = requestContextStorage.run(
    {
      workspaceId: undefined,
      userId: undefined,
      sessionId: undefined,
      correlationId: 'c',
      traceparent: undefined,
    },
    () => {
      if (call.user) setRequestPrincipal({ userId: call.user, sessionId: `s-${call.user}` });
      return lastValueFrom(interceptor.intercept(ctx, next) as Observable<unknown>);
    },
  );
  return { result, headers, reply };
}

describe.skipIf(!dockerEnabled)('IdempotencyInterceptor (real Valkey)', () => {
  let valkey: ValkeyHarness;
  let cache: CacheService;
  let interceptor: IdempotencyInterceptor;

  const connect = async () => {
    const service = new CacheService({ url: valkey.url, keyPrefix: '', mode: 'required' });
    service.onModuleInit();
    for (let i = 0; i < 100 && !service.isAvailable; i += 1)
      await new Promise((r) => setTimeout(r, 25));
    return service;
  };

  beforeAll(async () => {
    valkey = await startValkey();
  }, 120_000);
  afterAll(async () => {
    await valkey?.stop();
  }, 60_000);

  beforeEach(async () => {
    await valkey.flush();
    cache = await connect();
    interceptor = new IdempotencyInterceptor(cache);
  });
  afterEach(async () => {
    await cache.onApplicationShutdown();
    vi.unstubAllEnvs();
  });

  const keys = () => cache.instance.keys('*');
  const claims = async () => (await keys()).filter((k) => k.endsWith(':claim'));
  const records = async () => (await keys()).filter((k) => !k.endsWith(':claim'));
  const warnOf = (i: IdempotencyInterceptor) =>
    vi.spyOn((i as unknown as { logger: { warn: () => void } }).logger, 'warn');

  describe('replay', () => {
    it('the first call runs and is stored; a retry returns the same body and status, flagged, without running the handler', async () => {
      const handler = vi.fn(() => of({ id: 42, name: 'a' }));
      const first = run(interceptor, { user: 'u1', statusCode: 201 }, { handle: handler });
      expect(await first.result).toEqual({ id: 42, name: 'a' });
      expect(first.headers[IDEMPOTENCY_REPLAYED_HEADER]).toBeUndefined();

      const retry = run(interceptor, { user: 'u1', statusCode: 200 }, { handle: handler });
      expect(await retry.result).toEqual({ id: 42, name: 'a' });
      expect(retry.headers[IDEMPOTENCY_REPLAYED_HEADER]).toBe('true');
      expect(retry.reply.statusCode).toBe(201); // the stored status, not the retry's default
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('stores and replays an empty response (a 204)', async () => {
      const empty = (spy?: () => void): CallHandler => ({
        handle: () => {
          spy?.();
          return of(undefined);
        },
      });
      const first = run(interceptor, { user: 'u1', statusCode: 204 }, empty());
      expect(await first.result).toBeUndefined();
      const spy = vi.fn();
      const retry = run(interceptor, { user: 'u1', statusCode: 200 }, empty(spy));
      expect(await retry.result).toBeUndefined();
      expect(retry.reply.statusCode).toBe(204);
      expect(spy).not.toHaveBeenCalled();
    });

    it('is scoped to the user: the same key from another user runs', async () => {
      await run(interceptor, { user: 'u1' }, handlerOf({ who: 'u1' })).result;
      const spy = vi.fn();
      const other = run(interceptor, { user: 'u2' }, handlerOf({ who: 'u2' }, spy));
      expect(await other.result).toEqual({ who: 'u2' });
      expect(spy).toHaveBeenCalled();
    });

    it('is scoped to method and URL: the same key on another route runs', async () => {
      await run(interceptor, { user: 'u1', url: '/v1/a' }, handlerOf({ r: 'a' })).result;
      const spy = vi.fn();
      expect(
        await run(interceptor, { user: 'u1', url: '/v1/b' }, handlerOf({ r: 'b' }, spy)).result,
      ).toEqual({ r: 'b' });
      expect(spy).toHaveBeenCalled();
      const put = vi.fn();
      await run(
        interceptor,
        { user: 'u1', url: '/v1/a', method: 'PUT' },
        handlerOf({ r: 'put' }, put),
      ).result;
      expect(put).toHaveBeenCalled();
    });

    it('an anonymous caller is told apart by address and agent', async () => {
      await run(interceptor, { ip: '198.51.100.1', agent: 'x' }, handlerOf({ n: 1 })).result;
      const same = vi.fn();
      expect(
        await run(interceptor, { ip: '198.51.100.1', agent: 'x' }, handlerOf({ n: 2 }, same))
          .result,
      ).toEqual({ n: 1 });
      expect(same).not.toHaveBeenCalled();
      const other = vi.fn();
      await run(interceptor, { ip: '198.51.100.2', agent: 'x' }, handlerOf({ n: 3 }, other)).result;
      expect(other).toHaveBeenCalled();
    });

    it('no header value reaches a Redis key', async () => {
      const key = 'my secret key with : colons';
      await run(interceptor, { user: 'u1', key }, handlerOf()).result;
      const stored = await keys();
      expect(stored.length).toBeGreaterThan(0);
      for (const k of stored) {
        expect(k).not.toContain('secret');
        expect(k).not.toContain('colons');
      }
    });

    it('does nothing for GET, without a key, or for a request that is not HTTP', async () => {
      for (const call of [{ method: 'GET' }, { key: undefined }] as Call[]) {
        const spy = vi.fn();
        await run(interceptor, { user: 'u1', ...call }, handlerOf({}, spy)).result;
        await run(interceptor, { user: 'u1', ...call }, handlerOf({}, spy)).result;
        expect(spy).toHaveBeenCalledTimes(2);
      }
      expect(await keys()).toEqual([]);
      const rpc = { getType: () => 'rpc' } as unknown as ExecutionContext;
      expect(await firstValueFrom(interceptor.intercept(rpc, handlerOf('x')))).toBe('x');
    });
  });

  describe('the body is fingerprinted', () => {
    it('the same key with a different body is refused (422 IDEMPOTENCY_KEY_REUSED), never answered with the first response', async () => {
      await run(interceptor, { user: 'u1', body: { amount: 10 } }, handlerOf({ charged: 10 }))
        .result;
      const spy = vi.fn();
      await expect(
        run(interceptor, { user: 'u1', body: { amount: 99 } }, handlerOf({ charged: 99 }, spy))
          .result,
      ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED', httpStatus: 422 });
      expect(spy).not.toHaveBeenCalled();
    });

    it('object key order does not matter; array order does', async () => {
      await run(
        interceptor,
        { user: 'u1', body: { a: 1, b: { c: 2, d: [1, 2] } } },
        handlerOf({ ok: 1 }),
      ).result;
      const spy = vi.fn();
      expect(
        await run(
          interceptor,
          { user: 'u1', body: { b: { d: [1, 2], c: 2 }, a: 1 } },
          handlerOf({ ok: 2 }, spy),
        ).result,
      ).toEqual({ ok: 1 });
      expect(spy).not.toHaveBeenCalled();
      await expect(
        run(interceptor, { user: 'u1', body: { a: 1, b: { c: 2, d: [2, 1] } } }, handlerOf())
          .result,
      ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    });

    it('an unparsed body (an upload) is told apart by content type and length', async () => {
      const upload = (length: string): Call => ({
        user: 'u1',
        body: undefined,
        headers: { 'content-type': 'multipart/form-data', 'content-length': length },
      });
      await run(interceptor, upload('100'), handlerOf({ up: 1 })).result;
      await expect(run(interceptor, upload('200'), handlerOf()).result).rejects.toMatchObject({
        code: 'IDEMPOTENCY_KEY_REUSED',
      });
      expect(await run(interceptor, upload('100'), handlerOf({ up: 2 })).result).toEqual({ up: 1 });
    });
  });

  describe('a concurrent copy is not run', () => {
    it('while the first is running a second gets 409 IDEMPOTENCY_IN_FLIGHT with Retry-After; the handler runs once; then a retry is a replay', async () => {
      const gate = new Subject<{ id: number }>();
      const handler = vi.fn(() => gate.asObservable());
      const first = run(interceptor, { user: 'u1' }, { handle: handler });
      await vi.waitFor(async () => expect(await claims()).toHaveLength(1));

      const second = run(interceptor, { user: 'u1' }, { handle: handler });
      await expect(second.result).rejects.toMatchObject({
        code: 'IDEMPOTENCY_IN_FLIGHT',
        httpStatus: 409,
      });
      expect(Number(second.headers['retry-after'])).toBeGreaterThan(0);
      expect(handler).toHaveBeenCalledTimes(1);

      gate.next({ id: 7 });
      gate.complete();
      expect(await first.result).toEqual({ id: 7 });
      expect(await claims()).toEqual([]);

      const retry = run(interceptor, { user: 'u1' }, { handle: handler });
      expect(await retry.result).toEqual({ id: 7 });
      expect(retry.headers[IDEMPOTENCY_REPLAYED_HEADER]).toBe('true');
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('holds across processes: two interceptors on one Valkey (two pods) run it once', async () => {
      const otherCache = await connect();
      try {
        const podB = new IdempotencyInterceptor(otherCache);
        const gate = new Subject<string>();
        const runs = vi.fn(() => gate.asObservable());
        const a = run(interceptor, { user: 'u1' }, { handle: runs });
        await vi.waitFor(async () => expect(await claims()).toHaveLength(1));
        await expect(run(podB, { user: 'u1' }, { handle: runs }).result).rejects.toMatchObject({
          code: 'IDEMPOTENCY_IN_FLIGHT',
        });
        gate.next('done');
        gate.complete();
        await a.result;
        expect(runs).toHaveBeenCalledTimes(1);
      } finally {
        await otherCache.onApplicationShutdown();
      }
    });

    it('the claim carries a lease (IDEMPOTENCY_LEASE_SECONDS), so a pod killed mid-request frees the key', async () => {
      vi.stubEnv('IDEMPOTENCY_LEASE_SECONDS', '7');
      const leased = new IdempotencyInterceptor(cache);
      const gate = new Subject<string>();
      const running = run(leased, { user: 'u1' }, { handle: () => gate.asObservable() });
      await vi.waitFor(async () => expect(await claims()).toHaveLength(1));
      const ttl = await cache.instance.ttl((await claims())[0]!);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(7);
      gate.complete();
      await running.result.catch(() => undefined);
    });

    it('releases by compare-and-delete: a request that outlived its lease does not free the claim of the one that took over', async () => {
      const gate = new Subject<string>();
      const slow = run(interceptor, { user: 'u1' }, { handle: () => gate.asObservable() });
      await vi.waitFor(async () => expect(await claims()).toHaveLength(1));
      const claimKey = (await claims())[0]!;
      // The lease runs out and another request takes the key over.
      await cache.instance.set(claimKey, 'someone-elses-token', 'EX', 30);

      gate.next('late');
      gate.complete();
      await slow.result;
      expect(await cache.instance.get(claimKey)).toBe('someone-elses-token');
    });
  });

  describe('only successes are stored', () => {
    it('a handler that throws leaves nothing, frees the claim, and the retry runs', async () => {
      await expect(
        run(interceptor, { user: 'u1' }, { handle: () => throwError(() => new Error('boom')) })
          .result,
      ).rejects.toThrow('boom');
      expect(await keys()).toEqual([]);
      const spy = vi.fn();
      expect(await run(interceptor, { user: 'u1' }, handlerOf({ ok: true }, spy)).result).toEqual({
        ok: true,
      });
      expect(spy).toHaveBeenCalled();
    });

    it.each([400, 404, 500, 302])(
      'a response sent with status %i is not stored',
      async (statusCode) => {
        await run(interceptor, { user: 'u1', statusCode }, handlerOf({ no: true })).result;
        expect(await records()).toEqual([]);
      },
    );

    it('a response too large to store (measured in BYTES, not characters) is returned, recorded as done, and never re-run', async () => {
      const warn = warnOf(interceptor);
      // 90_000 characters but 270_000 bytes: under the cap by length, over it by bytes.
      const wide = { text: '€'.repeat(90_000) };
      expect(JSON.stringify(wide).length).toBeLessThan(MAX_STORED_RESPONSE_BYTES);
      expect(await run(interceptor, { user: 'u1' }, handlerOf(wide)).result).toEqual(wide);
      expect(warn).toHaveBeenCalledTimes(1);
      const record = JSON.parse((await cache.instance.get((await records())[0]!)) as string);
      expect(record).toMatchObject({ s: 201, m: 'not-replayable' });
      expect(record.b).toBeUndefined(); // nothing of the response is kept

      const spy = vi.fn();
      await expect(
        run(interceptor, { user: 'u1' }, handlerOf({ again: 1 }, spy)).result,
      ).rejects.toMatchObject({
        code: 'IDEMPOTENCY_NOT_REPLAYABLE',
        httpStatus: 409,
        details: [{ originalStatus: 201 }],
      });
      expect(spy).not.toHaveBeenCalled(); // never a second execution
    });

    it('a response under the cap is stored whole', async () => {
      const ok = { text: 'x'.repeat(200_000) };
      await run(interceptor, { user: 'u1' }, handlerOf(ok)).result;
      const spy = vi.fn();
      expect(await run(interceptor, { user: 'u1' }, handlerOf({}, spy)).result).toEqual(ok);
      expect(spy).not.toHaveBeenCalled();
    });

    it('stores for 24 hours', async () => {
      await run(interceptor, { user: 'u1' }, handlerOf()).result;
      const ttl = await cache.instance.ttl((await records())[0]!);
      expect(ttl).toBeGreaterThan(23 * 3600);
      expect(ttl).toBeLessThanOrEqual(24 * 3600);
    });
  });

  describe('it fails OPEN: the request runs when the cache cannot be used', () => {
    const failing = async (): Promise<never> => {
      throw new Error('valkey down');
    };
    /** A cache whose `eval` answers "claimed" for the read-or-claim script and `1` for the others. */
    const withFake = (instance: {
      claim?: () => Promise<unknown>;
      release?: () => Promise<unknown>;
      set?: (...args: unknown[]) => Promise<unknown>;
    }) =>
      new IdempotencyInterceptor({
        get instance() {
          return {
            set: instance.set ?? (async () => 'OK'),
            eval: async (script: string) =>
              script.includes("'claimed'")
                ? await (instance.claim ?? (async () => ['claimed']))()
                : await (instance.release ?? (async () => 1))(),
          };
        },
        isAvailable: true,
      } as unknown as CacheService);

    it('reading or claiming fails: logged, and the handler runs once', async () => {
      const flaky = withFake({ claim: failing });
      const warn = warnOf(flaky);
      const spy = vi.fn();
      expect(await run(flaky, { user: 'u1' }, handlerOf({ ran: 1 }, spy)).result).toEqual({
        ran: 1,
      });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalled();
    });

    it('an answer from the cache that is not one of ours is treated the same way', async () => {
      const odd = withFake({ claim: async () => 'what' });
      const spy = vi.fn();
      await run(odd, { user: 'u1' }, handlerOf({ ran: 1 }, spy)).result;
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('a cache that is not there at all (disabled)', async () => {
      const disabled = new IdempotencyInterceptor(new CacheService({ mode: 'optional' }));
      const spy = vi.fn();
      expect(await run(disabled, { user: 'u1' }, handlerOf({ ran: 2 }, spy)).result).toEqual({
        ran: 2,
      });
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('an error STORING the response does not fail a request that succeeded', async () => {
      const flaky = withFake({ set: failing });
      expect(await run(flaky, { user: 'u1' }, handlerOf({ fine: true })).result).toEqual({
        fine: true,
      });
    });

    it('an error RELEASING the claim does not fail the request either (the lease frees it)', async () => {
      const flaky = withFake({ release: failing });
      expect(await run(flaky, { user: 'u1' }, handlerOf({ fine: true })).result).toEqual({
        fine: true,
      });
    });

    it('a corrupt stored entry is a miss, not a crash', async () => {
      await run(interceptor, { user: 'u1' }, handlerOf()).result;
      await cache.instance.set((await records())[0]!, '{not json');
      const spy = vi.fn();
      await run(interceptor, { user: 'u1' }, handlerOf({ again: 1 }, spy)).result;
      expect(spy).toHaveBeenCalled();
    });
  });

  describe('no second execution: the read and the claim are one atomic step', () => {
    it('a record that already exists is replayed WITHOUT taking a claim', async () => {
      await run(interceptor, { user: 'u1' }, handlerOf({ id: 1 })).result;
      expect(await claims()).toEqual([]);
      const spy = vi.fn();
      expect(await run(interceptor, { user: 'u1' }, handlerOf({ id: 2 }, spy)).result).toEqual({
        id: 1,
      });
      expect(spy).not.toHaveBeenCalled();
      expect(await claims()).toEqual([]); // nothing was claimed to be released
    });

    it('STRESS: 8 concurrent copies, 25 rounds ⇒ the handler runs exactly once per round, every other copy replays or is told "in flight"', async () => {
      for (let round = 0; round < 25; round += 1) {
        const handler = vi.fn(() => of({ round }));
        const results = await Promise.allSettled(
          Array.from(
            { length: 8 },
            () => run(interceptor, { user: 'u1', key: `k-${round}` }, { handle: handler }).result,
          ),
        );
        expect(handler, `round ${round}`).toHaveBeenCalledTimes(1);
        for (const r of results) {
          if (r.status === 'rejected') {
            expect((r.reason as { code?: string }).code).toBe('IDEMPOTENCY_IN_FLIGHT');
          } else {
            expect(r.value).toEqual({ round });
          }
        }
        // and once it is done, every later copy replays
        const spy = vi.fn();
        expect(
          await run(interceptor, { user: 'u1', key: `k-${round}` }, handlerOf({}, spy)).result,
        ).toEqual({ round });
        expect(spy).not.toHaveBeenCalled();
      }
    }, 60_000);
  });

  describe('a response that cannot be replayed is recorded as done, and never re-run', () => {
    const notReplayable = async (body: unknown, status = 201) => {
      const handler = vi.fn(() => of(body));
      const first = await run(interceptor, { user: 'u1', statusCode: status }, { handle: handler })
        .result;
      expect(first).toBe(body); // the first response is untouched
      const retrySpy = vi.fn();
      const retry = run(interceptor, { user: 'u1', statusCode: 200 }, handlerOf({}, retrySpy));
      await expect(retry.result).rejects.toMatchObject({
        code: 'IDEMPOTENCY_NOT_REPLAYABLE',
        httpStatus: 409,
        details: [{ originalStatus: status }],
      });
      expect(retry.headers[IDEMPOTENCY_REPLAYED_HEADER]).toBe('true');
      expect(retrySpy).not.toHaveBeenCalled();
      expect(handler).toHaveBeenCalledTimes(1);
      return JSON.parse((await cache.instance.get((await records())[0]!)) as string);
    };

    it('a StreamableFile: the marker holds the status and NOTHING of the file, not its server path', async () => {
      const path = '/srv/app/secret-uploads/q3-board-pack.pdf';
      const stream = Object.assign(Readable.from(['pdf bytes']), { path });
      const file = new StreamableFile(stream);
      const record = await notReplayable(file);
      expect(record).toMatchObject({ v: 1, s: 201, m: 'not-replayable' });
      const raw = JSON.stringify(record);
      expect(raw).not.toContain('secret-uploads');
      expect(raw).not.toContain('pdf bytes');
      expect(record.b).toBeUndefined();
    });

    it('a Readable stream', async () => {
      const record = await notReplayable(Readable.from(['a', 'b']));
      expect(record.m).toBe('not-replayable');
    });

    it('a Buffer and a typed array (never a byte array in the cache)', async () => {
      const buffer = await notReplayable(Buffer.from('binary payload'));
      expect(JSON.stringify(buffer)).not.toContain('binary');
      expect(JSON.stringify(buffer)).not.toContain('"data"');
      await valkey.flush();
      const typed = await notReplayable(new Uint8Array([1, 2, 3]));
      expect(typed.m).toBe('not-replayable');
    });

    it('a body that does not serialize (circular, BigInt)', async () => {
      const circular: Record<string, unknown> = { name: 'loop' };
      circular['self'] = circular;
      expect((await notReplayable(circular)).m).toBe('not-replayable');
      await valkey.flush();
      expect((await notReplayable({ big: 10n }, 200)).s).toBe(200);
    });

    it('a retry with a DIFFERENT request is still 422, not 409: the fingerprint is checked first', async () => {
      await run(interceptor, { user: 'u1', body: { a: 1 } }, handlerOf(Buffer.from('x'))).result;
      await expect(
        run(interceptor, { user: 'u1', body: { a: 2 } }, handlerOf()).result,
      ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    });
  });

  describe('replayed headers', () => {
    it('Location, ETag and Content-Type that the handler set come back on a replay; Set-Cookie never does', async () => {
      const created = {
        user: 'u1',
        responseHeaders: {
          Location: '/v1/things/42',
          ETag: '"v1"',
          'Content-Type': 'application/vnd.api+json',
          'Set-Cookie': 'session=abc123; HttpOnly',
          'X-Internal': 'nope',
        },
      };
      await run(interceptor, created, handlerOf({ id: 42 })).result;
      const raw = (await cache.instance.get((await records())[0]!)) as string;
      expect(raw).not.toMatch(/abc123|session=|X-Internal|nope/i);

      const retry = run(interceptor, { user: 'u1' }, handlerOf({}));
      expect(await retry.result).toEqual({ id: 42 });
      expect(retry.headers['location']).toBe('/v1/things/42');
      expect(retry.headers['etag']).toBe('"v1"');
      expect(retry.headers['content-type']).toBe('application/vnd.api+json');
      expect(retry.headers['set-cookie']).toBeUndefined();
      expect(retry.headers['x-internal']).toBeUndefined();
      expect(retry.headers[IDEMPOTENCY_REPLAYED_HEADER]).toBe('true');
    });

    it('a header value with CR/LF or a control character, or an absurd length, is dropped, never stored', async () => {
      await run(
        interceptor,
        {
          user: 'u1',
          responseHeaders: { Location: '/ok\r\nSet-Cookie: x=1', ETag: 'e'.repeat(3000) },
        },
        handlerOf({ id: 1 }),
      ).result;
      const record = JSON.parse((await cache.instance.get((await records())[0]!)) as string);
      expect(record.h).toBeUndefined();
    });

    it('a replay with no headers stored sets none', async () => {
      await run(interceptor, { user: 'u1' }, handlerOf({ id: 1 })).result;
      const retry = run(interceptor, { user: 'u1' }, handlerOf({}));
      await retry.result;
      expect(Object.keys(retry.headers)).toEqual([IDEMPOTENCY_REPLAYED_HEADER]);
    });
  });

  describe('the lease is renewed while the handler runs', () => {
    it('a request longer than the lease keeps its claim: the TTL is topped up, and a copy is still told "in flight"', async () => {
      vi.stubEnv('IDEMPOTENCY_LEASE_SECONDS', '6');
      const slow = new IdempotencyInterceptor(cache);
      const gate = new Subject<string>();
      const handler = vi.fn(() => gate.asObservable());
      const running = run(slow, { user: 'u1' }, { handle: handler });
      await vi.waitFor(async () => expect(await claims()).toHaveLength(1));

      await new Promise((r) => setTimeout(r, 4_300)); // past two renewals (every 2 s); without them: ~1.7 s left
      const ttl = await cache.instance.ttl((await claims())[0]!);
      expect(ttl).toBeGreaterThan(3);
      await expect(run(slow, { user: 'u1' }, { handle: handler }).result).rejects.toMatchObject({
        code: 'IDEMPOTENCY_IN_FLIGHT',
      });
      expect(handler).toHaveBeenCalledTimes(1);

      gate.next('done');
      gate.complete();
      expect(await running.result).toBe('done');
    }, 20_000);

    it('renewal is compare-and-expire: it does not extend a claim that is no longer ours', async () => {
      vi.stubEnv('IDEMPOTENCY_LEASE_SECONDS', '6');
      const slow = new IdempotencyInterceptor(cache);
      const warn = warnOf(slow);
      const gate = new Subject<string>();
      const running = run(slow, { user: 'u1' }, { handle: () => gate.asObservable() });
      await vi.waitFor(async () => expect(await claims()).toHaveLength(1));
      const claimKey = (await claims())[0]!;
      await cache.instance.set(claimKey, 'successor', 'EX', 4); // taken over, short lease

      await new Promise((r) => setTimeout(r, 2_500)); // one renewal tick (at 2 s) has passed
      expect(await cache.instance.get(claimKey)).toBe('successor');
      expect(await cache.instance.ttl(claimKey)).toBeLessThanOrEqual(2); // not extended
      expect(warn.mock.calls.some((c) => /claim was lost/.test(JSON.stringify(c[0])))).toBe(true);
      gate.complete();
      await running.result.catch(() => undefined);
    }, 20_000);

    it('the timer stops when the request ends: nothing is left ticking', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      try {
        const before = vi.getTimerCount();
        await run(interceptor, { user: 'u1' }, handlerOf({ ok: 1 })).result;
        expect(vi.getTimerCount()).toBe(before);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});

describe('without a cache', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('IDEMPOTENCY_MODE=disabled passes everything through', async () => {
    vi.stubEnv('IDEMPOTENCY_MODE', 'disabled');
    const unused = {
      get instance(): never {
        throw new Error('unused');
      },
    } as unknown as CacheService;
    const spy = vi.fn();
    await run(new IdempotencyInterceptor(unused), { user: 'u1' }, handlerOf({}, spy)).result;
    expect(spy).toHaveBeenCalled();
  });

  describe('IDEMPOTENCY_LEASE_SECONDS', () => {
    it('defaults to 60 and accepts 5 to 600', () => {
      expect(readIdempotencyLeaseSeconds({})).toBe(IDEMPOTENCY_LEASE_DEFAULT_SECONDS);
      expect(IDEMPOTENCY_LEASE_DEFAULT_SECONDS).toBe(60);
      expect(readIdempotencyLeaseSeconds({ IDEMPOTENCY_LEASE_SECONDS: '5' })).toBe(5);
      expect(readIdempotencyLeaseSeconds({ IDEMPOTENCY_LEASE_SECONDS: ' 600 ' })).toBe(600);
      expect(readIdempotencyLeaseSeconds({ IDEMPOTENCY_LEASE_SECONDS: '' })).toBe(60);
    });

    it.each(['4', '601', '0', '-1', '1.5', 'abc', '60s', '1e2', '0x10', '99999'])(
      'refuses %o at startup, naming the variable',
      (value) => {
        expect(() => readIdempotencyLeaseSeconds({ IDEMPOTENCY_LEASE_SECONDS: value })).toThrow(
          /IDEMPOTENCY_LEASE_SECONDS/,
        );
      },
    );

    it('the interceptor refuses a bad value at construction', () => {
      vi.stubEnv('IDEMPOTENCY_LEASE_SECONDS', 'soon');
      expect(() => new IdempotencyInterceptor({} as CacheService)).toThrow(
        /IDEMPOTENCY_LEASE_SECONDS/,
      );
    });
  });
});

describe('requestFingerprint', () => {
  const base = { method: 'POST', url: '/v1/x', body: { a: 1 }, headers: {} };

  it('is stable, and changes with method, URL and body', () => {
    expect(requestFingerprint(base)).toBe(requestFingerprint({ ...base }));
    expect(requestFingerprint({ ...base, method: 'post' })).toBe(requestFingerprint(base));
    for (const change of [
      { method: 'PUT' },
      { url: '/v1/y' },
      { url: '/v1/x?a=1' },
      { body: { a: 2 } },
      { body: null },
    ]) {
      expect(requestFingerprint({ ...base, ...change })).not.toBe(requestFingerprint(base));
    }
  });

  it('an empty POST to two routes is not the same request', () => {
    expect(requestFingerprint({ ...base, url: '/x/activate', body: undefined })).not.toBe(
      requestFingerprint({ ...base, url: '/y/activate', body: undefined }),
    );
  });

  it('canonicalJson sorts keys at every depth, keeps array order, drops undefined, hashes buffers', () => {
    expect(canonicalJson({ b: 1, a: { d: 1, c: [3, 1] }, u: undefined })).toBe(
      '{"a":{"c":[3,1],"d":1},"b":1}',
    );
    expect(canonicalJson(undefined)).toBe('null');
    expect(canonicalJson(Buffer.from('hello'))).not.toContain('hello');
    expect(canonicalJson(Buffer.from('a'))).not.toBe(canonicalJson(Buffer.from('b')));
  });
});
