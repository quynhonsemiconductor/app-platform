import http, { type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { EDGE_FORWARD_HEADERS, edgeForwardRequest, forwardToOrigin } from './edge';
import { verifyEdgeClientIp, type EdgeRejection } from './edge-client-ip';
import { EDGE_IP_HEADER, EDGE_SIG_HEADER, EDGE_TS_HEADER } from './edge-protocol';

const SECRET = 'forward-'.padEnd(40, 'x');
const VISITOR = '203.0.113.7';

interface Seen {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))),
  );
});

/** A server that records what it receives and answers with `respond`. */
async function listen(
  respond: (request: http.IncomingMessage, response: http.ServerResponse, body: string) => void,
): Promise<{ origin: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => (body += chunk.toString()));
    request.on('end', () => {
      seen.push({
        method: request.method ?? '',
        url: request.url ?? '',
        headers: request.headers,
        body,
      });
      respond(request, response, body);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

function visitorRequest(
  init: RequestInit & { url?: string } = {},
  headers: Record<string, string> = {},
): Request {
  return new Request(init.url ?? 'https://app.qnsc.vn/api/auth/callback/microsoft?code=abc', {
    ...init,
    headers: { 'cf-connecting-ip': VISITOR, ...headers },
  });
}

describe('forwardToOrigin: a redirect and its cookies pass through untouched', () => {
  it('returns the API’s 302, its Location and BOTH Set-Cookie headers to the browser, and follows nothing', async () => {
    const landing = await listen((_req, res) => {
      res.writeHead(200).end('the redirect target');
    });
    const api = await listen((_req, res) => {
      res.setHeader('Set-Cookie', [
        '__Host-app.session_token=abc; Path=/; HttpOnly; Secure; SameSite=Lax',
        '__Host-app.state=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax',
      ]);
      res.writeHead(302, { Location: `${landing.origin}/after-sign-in` }).end();
    });

    const response = await forwardToOrigin(visitorRequest(), {
      secret: SECRET,
      target: `${api.origin}/api/auth/callback/microsoft?code=abc`,
    });

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(`${landing.origin}/after-sign-in`);
    expect(response.headers.getSetCookie()).toEqual([
      '__Host-app.session_token=abc; Path=/; HttpOnly; Secure; SameSite=Lax',
      '__Host-app.state=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax',
    ]);
    // The Worker did not follow it: the redirect target was never contacted, and so never received
    // the signed headers or the visitor's cookies.
    expect(landing.seen).toEqual([]);
    expect(api.seen).toHaveLength(1);
  });

  it('what a hand-built `new Request(target, { method, headers, body })` does instead: follows, and re-sends the signed trio and the cookies to the redirect target', async () => {
    const landing = await listen((_req, res) => {
      res.writeHead(200).end('landed');
    });
    const api = await listen((_req, res) => {
      res.setHeader('Set-Cookie', '__Host-app.session_token=abc; Path=/');
      res.writeHead(302, { Location: `${landing.origin}/after` }).end();
    });
    const built = await edgeForwardRequest(visitorRequest(undefined, { cookie: 'a=1' }), {
      secret: SECRET,
      target: `${api.origin}/api/auth/callback/microsoft`,
    });
    const naive = new Request(built.url, { method: built.method, headers: built.headers });

    const response = await fetch(naive); // redirect: 'follow' by default

    expect(response.status).toBe(200); // the browser would never see the 302
    expect(response.headers.getSetCookie()).toEqual([]); // nor its Set-Cookie
    expect(landing.seen).toHaveLength(1);
    expect(landing.seen[0]?.headers[EDGE_SIG_HEADER]).toBeDefined(); // the signed trio went along
    expect(built.redirect).toBe('manual'); // and the helper does not do that
  });

  it('passes other statuses, bodies and headers through as they are', async () => {
    const api = await listen((_req, res) => {
      res.writeHead(409, { 'content-type': 'application/json', 'x-correlation-id': 'c-1' });
      res.end('{"error":{"code":"CONFLICT"}}');
    });
    const response = await forwardToOrigin(visitorRequest({ url: 'https://app.qnsc.vn/v1/x' }), {
      secret: SECRET,
      target: `${api.origin}/v1/x`,
    });

    expect(response.status).toBe(409);
    expect(response.headers.get('x-correlation-id')).toBe('c-1');
    expect(await response.json()).toEqual({ error: { code: 'CONFLICT' } });
  });
});

describe('edgeForwardRequest: what the API receives', () => {
  async function through(request: Request, target: (origin: string) => string, extra = {}) {
    const api = await listen((_req, res) => {
      res.writeHead(204).end();
    });
    await forwardToOrigin(request, { secret: SECRET, target: target(api.origin), ...extra });
    expect(api.seen).toHaveLength(1);
    return api.seen[0]!;
  }

  it('is signed for the method and path of the request it SENDS (after the rewrite), and verifies', async () => {
    const seen = await through(
      visitorRequest({ method: 'GET', url: 'https://app.qnsc.vn/old/path?x=1' }),
      (origin) => `${origin}/api/auth/get-session?x=1`,
    );
    const reasons: EdgeRejection[] = [];
    const ip = verifyEdgeClientIp(
      { headers: seen.headers, method: seen.method, url: seen.url },
      { secrets: [SECRET] },
      Math.floor(Date.now() / 1000),
      (r) => reasons.push(r),
    );

    expect(seen.url).toBe('/api/auth/get-session?x=1');
    expect(reasons).toEqual([]);
    expect(ip).toBe(VISITOR);
  });

  it('forwards only the allow-list, plus the signed trio; a visitor’s own edge, forwarding and cf-* headers never arrive', async () => {
    const seen = await through(
      visitorRequest(
        { method: 'GET' },
        {
          cookie: 'session=1',
          authorization: 'Bearer t',
          origin: 'https://app.qnsc.vn',
          'user-agent': 'ua',
          'x-qnsc-edge-ip': '6.6.6.6',
          'x-qnsc-edge-anything': 'x',
          'x-forwarded-for': '6.6.6.6',
          'x-real-ip': '6.6.6.6',
          'true-client-ip': '6.6.6.6',
          'x-qnsc-client-ip': '6.6.6.6',
          'x-internal-admin': 'yes',
        },
      ),
      (origin) => `${origin}/v1/things`,
    );

    expect(seen.headers['cookie']).toBe('session=1');
    expect(seen.headers['authorization']).toBe('Bearer t');
    expect(seen.headers['origin']).toBe('https://app.qnsc.vn');
    expect(seen.headers['user-agent']).toBe('ua');
    expect(seen.headers[EDGE_IP_HEADER]).toBe(VISITOR); // the Worker’s, not the visitor’s 6.6.6.6
    expect(seen.headers['x-qnsc-edge-anything']).toBeUndefined();
    for (const name of [
      'x-forwarded-for',
      'x-real-ip',
      'true-client-ip',
      'x-qnsc-client-ip',
      'cf-connecting-ip',
      'x-internal-admin',
    ]) {
      expect(seen.headers[name], name).toBeUndefined();
    }
    expect(seen.headers[EDGE_TS_HEADER]).toMatch(/^\d+$/);
  });

  it('forwards a product’s extra headers when asked, and only those', async () => {
    const seen = await through(
      visitorRequest({ method: 'GET' }, { 'x-csrf-token': 'c', 'x-other': 'o' }),
      (origin) => `${origin}/v1/things`,
      { forwardHeaders: ['X-CSRF-Token'] },
    );
    expect(seen.headers['x-csrf-token']).toBe('c');
    expect(seen.headers['x-other']).toBeUndefined();
  });

  it('streams a POST body and its content-type through', async () => {
    const seen = await through(
      visitorRequest(
        {
          url: 'https://app.qnsc.vn/api/auth/sign-in/social',
          method: 'POST',
          body: JSON.stringify({ provider: 'microsoft' }),
        },
        { 'content-type': 'application/json' },
      ),
      (origin) => `${origin}/api/auth/sign-in/social`,
    );
    expect(seen.method).toBe('POST');
    expect(seen.headers['content-type']).toBe('application/json');
    expect(JSON.parse(seen.body)).toEqual({ provider: 'microsoft' });
  });

  it.each([null, undefined])(
    'with no visitor address (%o) it still strips and sends the request, unsigned',
    async (ip) => {
      const request = new Request('https://app.qnsc.vn/v1/x', {
        headers: { 'x-qnsc-edge-ip': '6.6.6.6', 'x-qnsc-edge-sig': 'forged' },
      });
      const seen = await through(request, (origin) => `${origin}/v1/x`, { ip });
      expect(seen.headers[EDGE_IP_HEADER]).toBeUndefined();
      expect(seen.headers[EDGE_SIG_HEADER]).toBeUndefined();
    },
  );

  it('an explicit ip wins over cf-connecting-ip', async () => {
    const seen = await through(visitorRequest({ method: 'GET' }), (o) => `${o}/v1/x`, {
      ip: '198.51.100.9',
    });
    expect(seen.headers[EDGE_IP_HEADER]).toBe('198.51.100.9');
  });

  it('the allow-list is lower-case, so the match is case-insensitive', () => {
    for (const name of EDGE_FORWARD_HEADERS) expect(name).toBe(name.toLowerCase());
    expect(EDGE_FORWARD_HEADERS).not.toContain('x-forwarded-for');
    expect(EDGE_FORWARD_HEADERS.some((n) => n.startsWith('x-qnsc-edge-'))).toBe(false);
  });
});
