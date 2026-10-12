import 'reflect-metadata';
import { createHmac } from 'node:crypto';
import http from 'node:http';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Observability from '@quynhonsemiconductor/observability';
import { applyEdgeClientIp, signEdgeClientIp } from './edge';
import {
  EDGE_REJECTED_METRIC,
  EDGE_SECRET_ENV,
  EDGE_SECRET_PREVIOUS_ENV,
  assertEdgeClientIpEnv,
  readEdgeConfig,
  resetEdgeConfigForTesting,
  resetEdgeReportingForTesting,
  verifyEdgeClientIp,
  type EdgeRejection,
} from './edge-client-ip';
import { EDGE_IP_HEADER, EDGE_SIG_HEADER, EDGE_TS_HEADER } from './edge-protocol';
import { clientIp } from './client-ip';
import { edgeSigningString } from './edge-protocol';

const SECRET = 'current-secret-0123456789abcdef0123456789';
const PREVIOUS = 'previous-secret-0123456789abcdef012345678';
const NOW_MS = 1_760_000_000_000;
const NOW_S = NOW_MS / 1000;
const VISITOR = '203.0.113.7';
const CLOUDFLARE_INTERNAL = '2a06:98c0:3600::103';

type Req = { method: string; url: string; headers: Record<string, string | string[] | undefined> };

/** A request as the API receives it from a Worker that signed it. */
async function signed(
  overrides: Partial<{
    secret: string;
    ip: string;
    method: string;
    path: string;
    now: number;
  }> = {},
): Promise<Req> {
  const method = overrides.method ?? 'POST';
  const path = overrides.path ?? '/api/auth/sign-in/social';
  const headers = await signEdgeClientIp({
    secret: overrides.secret ?? SECRET,
    ip: overrides.ip ?? VISITOR,
    method,
    path,
    now: overrides.now ?? NOW_MS,
  });
  return {
    method,
    url: `${path}?from=worker`,
    headers: { 'cf-connecting-ip': CLOUDFLARE_INTERNAL, ...headers },
  };
}

const config = { secrets: [SECRET] };

describe('verifyEdgeClientIp', () => {
  const verify = (req: Req, secrets = [SECRET], nowSeconds = NOW_S) => {
    const reasons: EdgeRejection[] = [];
    const ip = verifyEdgeClientIp(req, { secrets }, nowSeconds, (r) => reasons.push(r));
    return { ip, reasons };
  };

  it('accepts a signature for THIS request, and returns the visitor’s address', async () => {
    expect(verify(await signed())).toEqual({ ip: VISITOR, reasons: [] });
  });

  it('accepts IPv6, and a request whose query differs from the signed one’s', async () => {
    expect(verify(await signed({ ip: '2001:db8::7' })).ip).toBe('2001:db8::7');
    const req = await signed();
    expect(verify({ ...req, url: '/api/auth/sign-in/social?a=1&b=2' }).ip).toBe(VISITOR);
  });

  it('treats no edge headers at all as "no edge", silently — it is not a rejection', () => {
    expect(verify({ method: 'GET', url: '/', headers: {} })).toEqual({
      ip: undefined,
      reasons: [],
    });
    expect(
      verify({ method: 'GET', url: '/', headers: { 'cf-connecting-ip': VISITOR } }).reasons,
    ).toEqual([]);
  });

  describe('replay is refused', () => {
    it('another IP: a signature moved onto a different address', async () => {
      const req = await signed();
      req.headers[EDGE_IP_HEADER] = '198.51.100.9';
      expect(verify(req)).toEqual({ ip: undefined, reasons: ['bad_signature'] });
    });

    it('another path: a signature lifted from one endpoint onto another', async () => {
      const req = await signed({ path: '/api/auth/sign-in/social' });
      expect(verify({ ...req, url: '/api/auth/sign-in/email' })).toEqual({
        ip: undefined,
        reasons: ['bad_signature'],
      });
    });

    it('another method', async () => {
      const req = await signed({ method: 'GET', path: '/v1/things' });
      expect(verify({ ...req, method: 'DELETE' }).reasons).toEqual(['bad_signature']);
    });

    it('another timestamp: the time can not be moved forward to outlive the window', async () => {
      const req = await signed({ now: NOW_MS - 50_000 });
      req.headers[EDGE_TS_HEADER] = String(NOW_S); // fresh-looking, signed for 50 s ago
      expect(verify(req).reasons).toEqual(['bad_signature']);
    });

    it('the same request after a minute', async () => {
      const req = await signed({ now: NOW_MS - 61_000 });
      expect(verify(req)).toEqual({ ip: undefined, reasons: ['stale'] });
    });
  });

  describe('the time window is ±60 s', () => {
    it.each([
      [-60, true],
      [-61, false],
      [60, true],
      [61, false],
      [0, true],
    ])('signed %i s from now ⇒ accepted: %s', async (offset, accepted) => {
      const req = await signed({ now: NOW_MS + offset * 1000 });
      const { ip, reasons } = verify(req);
      expect(ip !== undefined).toBe(accepted);
      expect(reasons).toEqual(accepted ? [] : ['stale']);
    });
  });

  describe('a wrong secret, or no relation to ours', () => {
    it('signed with another secret ⇒ refused', async () => {
      expect(verify(await signed({ secret: 'x'.repeat(40) }))).toEqual({
        ip: undefined,
        reasons: ['bad_signature'],
      });
    });

    it('a visitor who forges all three headers, in the right shape, is refused', () => {
      const forged: Req = {
        method: 'POST',
        url: '/api/auth/sign-in/social',
        headers: {
          [EDGE_IP_HEADER]: '6.6.6.6',
          [EDGE_TS_HEADER]: String(NOW_S),
          [EDGE_SIG_HEADER]: createHmac('sha256', 'guess').update('x').digest('base64url'),
        },
      };
      expect(verify(forged).reasons).toEqual(['bad_signature']);
    });
  });

  describe('rotation: two secrets', () => {
    it('a signature under the PREVIOUS secret is accepted while it is configured', async () => {
      expect(verify(await signed({ secret: PREVIOUS }), [SECRET, PREVIOUS]).ip).toBe(VISITOR);
      expect(verify(await signed({ secret: SECRET }), [SECRET, PREVIOUS]).ip).toBe(VISITOR);
    });

    it('and refused once it is removed', async () => {
      expect(verify(await signed({ secret: PREVIOUS }), [SECRET]).reasons).toEqual([
        'bad_signature',
      ]);
    });

    it('a third, unrelated secret is refused', async () => {
      expect(
        verify(await signed({ secret: 'z'.repeat(40) }), [SECRET, PREVIOUS]).ip,
      ).toBeUndefined();
    });
  });

  describe('malformed input never throws and is never trusted', () => {
    it.each([
      ['no signature', (r: Req) => void delete r.headers[EDGE_SIG_HEADER]],
      ['no address', (r: Req) => void delete r.headers[EDGE_IP_HEADER]],
      ['no timestamp', (r: Req) => void delete r.headers[EDGE_TS_HEADER]],
    ])('%s, the other two present ⇒ incomplete', async (_label, mutate) => {
      const req = await signed();
      mutate(req);
      expect(verify(req)).toEqual({ ip: undefined, reasons: ['incomplete'] });
    });

    it.each([EDGE_IP_HEADER, EDGE_TS_HEADER, EDGE_SIG_HEADER])(
      'a header that is not a string (%s) is absent, never read as the first value',
      async (name) => {
        const req = await signed();
        req.headers[name] = [req.headers[name] as string, 'second'];
        expect(verify(req)).toEqual({ ip: undefined, reasons: ['incomplete'] });
      },
    );

    it.each([
      ['a non-numeric timestamp', EDGE_TS_HEADER, 'yesterday'],
      ['a negative timestamp', EDGE_TS_HEADER, '-5'],
      ['a 13-digit timestamp', EDGE_TS_HEADER, '1760000000000'],
      ['a timestamp with a leading zero', EDGE_TS_HEADER, `0${NOW_S}`],
      ['an address with a separator in it', EDGE_IP_HEADER, '203.0.113.7|POST'],
      [
        'an address with a space (what a repeated header becomes)',
        EDGE_IP_HEADER,
        `${VISITOR}, ${VISITOR}`,
      ],
      ['a short signature', EDGE_SIG_HEADER, 'abc'],
      ['a signature with the wrong alphabet', EDGE_SIG_HEADER, '!'.repeat(43)],
      ['an over-long signature', EDGE_SIG_HEADER, 'a'.repeat(86)],
    ])('%s ⇒ malformed', async (_label, header, value) => {
      const req = await signed();
      req.headers[header] = value;
      expect(verify(req)).toEqual({ ip: undefined, reasons: ['malformed'] });
    });

    it('a request with no method or path to check against ⇒ unverifiable', async () => {
      const req = await signed();
      expect(verify({ headers: req.headers } as never).reasons).toEqual(['unverifiable']);
    });

    it('a method that is not letters only ⇒ unverifiable, never a signature over an ambiguous string', async () => {
      const req = await signed();
      for (const method of ['GET|x', 'M-SEARCH', 'GET ', '']) {
        expect(verify({ ...req, method })).toEqual({ ip: undefined, reasons: ['unverifiable'] });
      }
    });

    it('validly signed, shaped like an address, but not an IP ⇒ not_ip, and the value is not returned', () => {
      // A buggy or compromised edge that signs 999.999.999.999: the signature verifies, the value is not an IP.
      const odd = '999.999.999.999';
      const sig = createHmac('sha256', SECRET)
        .update(`${NOW_S}|${odd}|POST|/api/auth/sign-in/social`)
        .digest('base64url');
      const req: Req = {
        method: 'POST',
        url: '/api/auth/sign-in/social',
        headers: {
          [EDGE_IP_HEADER]: odd,
          [EDGE_TS_HEADER]: String(NOW_S),
          [EDGE_SIG_HEADER]: sig,
        },
      };
      expect(verify(req)).toEqual({ ip: undefined, reasons: ['not_ip'] });
    });

    it('an address that is not even shaped like one is malformed, before any HMAC is computed', async () => {
      const req = await signed();
      req.headers[EDGE_IP_HEADER] = 'definitely not an ip';
      expect(verify(req).reasons).toEqual(['malformed']);
      req.headers[EDGE_IP_HEADER] = '203.0.113.7\r\nx-evil: 1';
      expect(verify(req).reasons).toEqual(['malformed']);
    });
  });
});

describe('the signing string is injective', () => {
  it('refuses, on the signing side too, anything that could carry the separator', () => {
    expect(() => edgeSigningString(1, '1.2.3.4', 'GE|T', '/')).toThrow(RangeError);
    expect(() => edgeSigningString(1, '1.2.3.4', '', '/')).toThrow(RangeError);
    expect(() => edgeSigningString(1, '1.2.3.4|POST', 'GET', '/')).toThrow(RangeError);
    expect(() => edgeSigningString(1, '1.2.3.4', 'GET', '/')).not.toThrow();
    expect(() => edgeSigningString(-1, '1.2.3.4', 'GET', '/')).toThrow(RangeError);
    expect(() => edgeSigningString(1.5, '1.2.3.4', 'GET', '/')).toThrow(RangeError);
  });

  it('no two different (ts, ip, method, path) give the same string, even with | in the path', () => {
    const tss = [1, 12, 123];
    const ips = ['1.2.3.4', '1.2.3.45', '::1', '2001:db8::1'];
    const methods = ['GET', 'POST', 'PUT'];
    const paths = ['/', '/a', '/a|POST|/b', '|', '/1|1.2.3.4|GET|/', '/a|', '/%7C'];
    const seen = new Map<string, string>();
    for (const ts of tss)
      for (const ip of ips)
        for (const m of methods)
          for (const path of paths) {
            const text = edgeSigningString(ts, ip, m, path);
            const tuple = JSON.stringify([ts, ip, m, path]);
            expect(seen.get(text) ?? tuple, text).toBe(tuple);
            seen.set(text, tuple);
          }
    expect(seen.size).toBe(tss.length * ips.length * methods.length * paths.length);
  });

  it('a path holding what looks like the rest of a signed string cannot stand for another request', async () => {
    const real = await signed({ path: '/x|POST|/api/auth/sign-in/social' });
    // The same signature presented for a request whose path is the "tail": a different string, refused.
    const reasons: EdgeRejection[] = [];
    const ip = verifyEdgeClientIp(
      { ...real, url: '/api/auth/sign-in/social' },
      config,
      NOW_S,
      (r) => reasons.push(r),
    );
    expect(ip).toBeUndefined();
    expect(reasons).toEqual(['bad_signature']);
  });
});

describe('clientIp with the signed edge IP', () => {
  beforeEach(() => resetEdgeReportingForTesting());

  const withEdge = { edge: config, now: NOW_MS };

  it('prefers the verified edge address over cf-connecting-ip — the Cloudflare-internal one every user shared', async () => {
    const req = await signed();
    expect(req.headers['cf-connecting-ip']).toBe(CLOUDFLARE_INTERNAL);
    expect(clientIp(req, withEdge)).toBe(VISITOR);
  });

  it('a forged header falls back to today’s order, unchanged', () => {
    const forged: Req = {
      method: 'POST',
      url: '/x',
      headers: {
        'cf-connecting-ip': '203.0.113.50',
        'x-forwarded-for': '1.1.1.1',
        [EDGE_IP_HEADER]: '6.6.6.6',
        [EDGE_TS_HEADER]: String(NOW_S),
        [EDGE_SIG_HEADER]: 'a'.repeat(43),
      },
    };
    expect(clientIp(forged, withEdge)).toBe('203.0.113.50');
    const noCf = { ...forged, headers: { ...forged.headers, 'cf-connecting-ip': undefined } };
    expect(clientIp(noCf, withEdge)).toBe('1.1.1.1');
    const noHeaders = {
      ...noCf,
      headers: { ...noCf.headers, 'x-forwarded-for': undefined },
      socket: { remoteAddress: '10.0.0.5' },
    };
    expect(clientIp(noHeaders, withEdge)).toBe('10.0.0.5');
  });

  it('a signature replayed onto another IP or another path never yields the attacker’s choice', async () => {
    const real = await signed();
    const otherIp = { ...real, headers: { ...real.headers, [EDGE_IP_HEADER]: '9.9.9.9' } };
    const otherPath = { ...real, url: '/api/auth/get-session' };
    expect(clientIp(otherIp, withEdge)).toBe(CLOUDFLARE_INTERNAL); // fell back; 9.9.9.9 was not believed
    expect(clientIp(otherPath, withEdge)).toBe(CLOUDFLARE_INTERNAL);
  });

  it('is OFF when no secret is configured: valid signatures are ignored and nothing changes', async () => {
    const req = await signed();
    expect(clientIp(req, { edge: false, now: NOW_MS })).toBe(CLOUDFLARE_INTERNAL);
  });

  describe('from the environment', () => {
    afterEach(() => {
      vi.unstubAllEnvs();
      resetEdgeConfigForTesting();
    });

    it('turns on when EDGE_CLIENT_IP_SECRET is set, and off when it is not', async () => {
      const req = await signed();
      resetEdgeConfigForTesting();
      vi.stubEnv(EDGE_SECRET_ENV, '');
      expect(clientIp(req, { now: NOW_MS })).toBe(CLOUDFLARE_INTERNAL);

      vi.stubEnv(EDGE_SECRET_ENV, SECRET);
      expect(clientIp(req, { now: NOW_MS })).toBe(VISITOR);
    });

    it('accepts the previous secret during a rotation', async () => {
      vi.stubEnv(EDGE_SECRET_ENV, SECRET);
      vi.stubEnv(EDGE_SECRET_PREVIOUS_ENV, PREVIOUS);
      expect(clientIp(await signed({ secret: PREVIOUS }), { now: NOW_MS })).toBe(VISITOR);
      expect(clientIp(await signed({ secret: SECRET }), { now: NOW_MS })).toBe(VISITOR);
    });

    it('an unusable secret turns the feature off for the request (it never throws there) — the boot check is what fails', async () => {
      vi.stubEnv(EDGE_SECRET_ENV, 'too-short');
      const req = await signed();
      expect(() => clientIp(req, { now: NOW_MS })).not.toThrow();
      expect(clientIp(req, { now: NOW_MS })).toBe(CLOUDFLARE_INTERNAL);
    });
  });

  it('with the feature on and no edge headers the ordinary order applies and nothing is computed', () => {
    const req: Req = { method: 'GET', url: '/', headers: { 'cf-connecting-ip': VISITOR } };
    expect(clientIp(req, withEdge)).toBe(VISITOR);
  });
});

describe('readEdgeConfig / assertEdgeClientIpEnv (the boot check)', () => {
  it('is undefined when nothing is set, and holds the current secret first', () => {
    expect(readEdgeConfig({})).toBeUndefined();
    expect(readEdgeConfig({ [EDGE_SECRET_ENV]: SECRET })).toEqual({ secrets: [SECRET] });
    expect(
      readEdgeConfig({ [EDGE_SECRET_ENV]: SECRET, [EDGE_SECRET_PREVIOUS_ENV]: PREVIOUS }),
    ).toEqual({ secrets: [SECRET, PREVIOUS] });
  });

  it('refuses a short secret, and a previous one without a current one, naming the variable and never the value', () => {
    const short = 'short-secret-value';
    expect(() => assertEdgeClientIpEnv({ [EDGE_SECRET_ENV]: short })).toThrow(
      new RegExp(`${EDGE_SECRET_ENV} must be at least 32 characters`),
    );
    expect(() =>
      assertEdgeClientIpEnv({ [EDGE_SECRET_ENV]: SECRET, [EDGE_SECRET_PREVIOUS_ENV]: short }),
    ).toThrow(new RegExp(`${EDGE_SECRET_PREVIOUS_ENV} must be at least 32`));
    expect(() => assertEdgeClientIpEnv({ [EDGE_SECRET_PREVIOUS_ENV]: PREVIOUS })).toThrow(
      new RegExp(`${EDGE_SECRET_PREVIOUS_ENV} is set but ${EDGE_SECRET_ENV} is not`),
    );
    try {
      assertEdgeClientIpEnv({ [EDGE_SECRET_ENV]: short });
    } catch (error) {
      expect((error as Error).message).not.toContain(short);
    }
  });

  it('treats blank values as unset', () => {
    expect(readEdgeConfig({ [EDGE_SECRET_ENV]: '   ' })).toBeUndefined();
  });
});

describe('counting the rejections', () => {
  const add = vi.fn();
  const createCounter = vi.fn((..._args: unknown[]) => ({ add }));

  beforeEach(() => {
    resetEdgeReportingForTesting();
    add.mockClear();
    createCounter.mockClear();
  });
  afterEach(() => {
    vi.doUnmock('@quynhonsemiconductor/observability');
    vi.resetModules();
  });

  async function loadWithMockedMeter() {
    vi.resetModules();
    vi.doMock('@quynhonsemiconductor/observability', async (original) => ({
      ...(await original<typeof Observability>()),
      getMeter: () => ({ createCounter }),
    }));
    const edge = await import('./edge-client-ip');
    edge.resetEdgeReportingForTesting();
    return edge;
  }

  it('counts each refusal under edge_client_ip.rejected{reason}, with a closed reason', async () => {
    const edge = await loadWithMockedMeter();

    edge.reportEdgeRejection('bad_signature');
    edge.reportEdgeRejection('stale');
    edge.reportEdgeRejection('bad_signature');

    expect(createCounter).toHaveBeenCalledTimes(1);
    expect(createCounter.mock.calls[0]?.[0]).toBe(EDGE_REJECTED_METRIC);
    expect(add.mock.calls).toEqual([
      [1, { reason: 'bad_signature' }],
      [1, { reason: 'stale' }],
      [1, { reason: 'bad_signature' }],
    ]);
  });

  it('is wired to clientIp: a refused header is counted; an accepted one and a missing one are not', async () => {
    await loadWithMockedMeter();
    const { clientIp: wired } = await import('./client-ip');

    const good = await signed();
    wired(good, { edge: config, now: NOW_MS });
    wired({ method: 'GET', url: '/', headers: {} }, { edge: config, now: NOW_MS });
    expect(add).not.toHaveBeenCalled();

    wired({ ...good, url: '/elsewhere' }, { edge: config, now: NOW_MS });
    expect(add).toHaveBeenCalledWith(1, { reason: 'bad_signature' });
  });

  it('answers once per request: the guard, the log, idempotency and identity agree, and a refusal is counted once', async () => {
    await loadWithMockedMeter();
    vi.stubEnv(EDGE_SECRET_ENV, SECRET);
    const { clientIp: wired } = await import('./client-ip');
    const { resetEdgeConfigForTesting: reset } = await import('./edge-client-ip');
    reset();
    try {
      const refused = { ...(await signed()), url: '/not-the-signed-path' };
      const answers = [wired(refused), wired(refused), wired(refused)];
      expect(answers).toEqual([CLOUDFLARE_INTERNAL, CLOUDFLARE_INTERNAL, CLOUDFLARE_INTERNAL]);
      expect(add).toHaveBeenCalledTimes(1);

      // Another request is its own answer, and its own count.
      wired({ ...refused, headers: { ...refused.headers } });
      expect(add).toHaveBeenCalledTimes(2);

      // The accepted case is cached too: one answer for every consumer of the same request.
      const good = await signed({ now: Date.now() });
      expect(wired(good)).toBe(VISITOR);
      good.headers[EDGE_IP_HEADER] = '198.51.100.9'; // changing it afterwards does not change the answer
      expect(wired(good)).toBe(VISITOR);
      expect(add).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllEnvs();
      reset();
    }
  });

  it('never throws, even when the meter does', async () => {
    vi.resetModules();
    vi.doMock('@quynhonsemiconductor/observability', async (original) => ({
      ...(await original<typeof Observability>()),
      getMeter: () => {
        throw new Error('no meter');
      },
    }));
    const edge = await import('./edge-client-ip');
    edge.resetEdgeReportingForTesting();

    expect(() => edge.reportEdgeRejection('stale')).not.toThrow();
  });
});

describe('the secret is trimmed on both ends', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    resetEdgeConfigForTesting();
  });

  it('a Worker secret with a trailing newline signs exactly as one without', async () => {
    const plain = await signed({ secret: SECRET });
    const padded = await signed({ secret: `${SECRET}\n` });
    expect(padded.headers[EDGE_SIG_HEADER]).toBe(plain.headers[EDGE_SIG_HEADER]);
  });

  it('an API secret with a trailing newline (an env file) verifies a Worker that has none, and the other way round', async () => {
    expect(readEdgeConfig({ [EDGE_SECRET_ENV]: `${SECRET}\n` })).toEqual({ secrets: [SECRET] });
    vi.stubEnv(EDGE_SECRET_ENV, `${SECRET}\r\n`);
    expect(clientIp(await signed({ secret: SECRET }), { now: NOW_MS })).toBe(VISITOR);
    expect(clientIp(await signed({ secret: `\n${SECRET} ` }), { now: NOW_MS })).toBe(VISITOR);
  });

  it('the minimum length is measured after trimming, on both ends', async () => {
    const short = 's'.repeat(31);
    expect(() => readEdgeConfig({ [EDGE_SECRET_ENV]: `${short}\n\n` })).toThrow(/at least 32/);
    await expect(
      signEdgeClientIp({ secret: `${short}\n`, ip: VISITOR, method: 'GET', path: '/' }),
    ).rejects.toThrow(/at least 32/);
  });
});

describe('over real HTTP (Fastify), signed by the Worker helper', () => {
  const probeReasons: EdgeRejection[] = [];
  afterEach(() => {
    vi.unstubAllEnvs();
    resetEdgeConfigForTesting();
  });

  async function app() {
    vi.stubEnv(EDGE_SECRET_ENV, SECRET);
    const fastify = Fastify();
    fastify.all('/api/auth/*', async (request) => ({ ip: clientIp(request) }));
    fastify.get('/probe', async (request) => {
      verifyEdgeClientIp(request, config, Math.floor(Date.now() / 1000), (r) =>
        probeReasons.push(r),
      );
      return { ip: clientIp(request) };
    });
    await fastify.ready();
    return fastify;
  }

  /** What a Worker does: strip inbound edge headers, sign the request it SENDS, fetch. */
  async function throughWorker(
    fastify: Awaited<ReturnType<typeof app>>,
    visit: {
      method: 'GET' | 'POST';
      path: string;
      visitorIp: string;
      inbound?: Record<string, string>;
    },
  ) {
    const headers = new Headers({ ...visit.inbound });
    await applyEdgeClientIp(headers, {
      secret: SECRET,
      ip: visit.visitorIp,
      method: visit.method,
      path: visit.path,
    });
    return fastify.inject({
      method: visit.method,
      url: `${visit.path}?q=1`,
      headers: { 'cf-connecting-ip': CLOUDFLARE_INTERNAL, ...Object.fromEntries(headers) },
    });
  }

  it('the API sees the visitor, not the Cloudflare-internal address, for IPv4 and IPv6', async () => {
    const fastify = await app();
    for (const visitorIp of ['203.0.113.7', '2001:db8::7']) {
      const res = await throughWorker(fastify, {
        method: 'POST',
        path: '/api/auth/sign-in/social',
        visitorIp,
      });
      expect(res.json()).toEqual({ ip: visitorIp });
    }
    await fastify.close();
  });

  it('a visitor’s own x-qnsc-edge-* headers do not survive the Worker', async () => {
    const fastify = await app();
    const res = await throughWorker(fastify, {
      method: 'GET',
      path: '/api/auth/get-session',
      visitorIp: '203.0.113.7',
      inbound: { 'x-qnsc-edge-ip': '6.6.6.6', 'x-qnsc-edge-anything': 'x' },
    });
    expect(res.json()).toEqual({ ip: '203.0.113.7' });
    await fastify.close();
  });

  it('a header lifted from one request and sent straight to the API for another is ignored', async () => {
    const fastify = await app();
    const headers = new Headers();
    await applyEdgeClientIp(headers, {
      secret: SECRET,
      ip: '203.0.113.7',
      method: 'GET',
      path: '/api/auth/get-session',
    });
    const res = await fastify.inject({
      method: 'POST', // not the signed method
      url: '/api/auth/sign-in/social',
      headers: { 'cf-connecting-ip': CLOUDFLARE_INTERNAL, ...Object.fromEntries(headers) },
    });
    expect(res.json()).toEqual({ ip: CLOUDFLARE_INTERNAL });
    await fastify.close();
  });

  it.each([EDGE_IP_HEADER, EDGE_TS_HEADER, EDGE_SIG_HEADER])(
    'a repeated %s reaches the API joined with ", " (Node), and is refused: the visitor is not believed',
    async (repeated) => {
      const fastify = await app();
      probeReasons.length = 0;
      const headers = new Headers();
      await applyEdgeClientIp(headers, {
        secret: SECRET,
        ip: '203.0.113.7',
        method: 'GET',
        path: '/probe',
      });
      const raw: Record<string, string | string[]> = {
        'cf-connecting-ip': CLOUDFLARE_INTERNAL,
        ...Object.fromEntries(headers),
      };
      raw[repeated] = [raw[repeated] as string, raw[repeated] as string];

      await fastify.listen({ port: 0, host: '127.0.0.1' });
      const address = fastify.server.address() as { port: number };
      const body = await new Promise<string>((resolve, reject) => {
        const request = http.request(
          { host: '127.0.0.1', port: address.port, path: '/probe', headers: raw },
          (response) => {
            let text = '';
            response.on('data', (chunk: Buffer) => (text += chunk.toString()));
            response.on('end', () => resolve(text));
          },
        );
        request.on('error', reject);
        request.end();
      });

      expect(JSON.parse(body)).toEqual({ ip: CLOUDFLARE_INTERNAL });
      expect(probeReasons).toHaveLength(1);
      expect(['malformed', 'bad_signature']).toContain(probeReasons[0]);
      await fastify.close();
    },
  );
});
