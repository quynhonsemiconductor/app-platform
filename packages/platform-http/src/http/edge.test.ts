import { createHmac } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  EDGE_HEADER_PREFIX,
  EDGE_IP_HEADER,
  EDGE_SIG_HEADER,
  EDGE_TS_HEADER,
  applyEdgeClientIp,
  signEdgeClientIp,
  stripEdgeHeaders,
} from './edge';
import { edgePath, edgeSigningString } from './edge-protocol';

const SECRET = 'a'.repeat(32);
const NOW = 1_760_000_000_000; // 1760000000 s

const nodeSignature = (secret: string, ts: number, ip: string, method: string, path: string) =>
  createHmac('sha256', secret).update(`${ts}|${ip}|${method}|${path}`).digest('base64url');

describe('the signing string', () => {
  it('is ts|ip|METHOD|path, method upper-cased, path without the query or fragment', () => {
    expect(edgeSigningString(1760000000, '203.0.113.7', 'post', '/api/auth/x?a=1#frag')).toBe(
      '1760000000|203.0.113.7|POST|/api/auth/x',
    );
  });

  it.each([
    ['/a/b?x=1', '/a/b'],
    ['/a/b#f', '/a/b'],
    ['/a/b?x=1#f', '/a/b'],
    ['', '/'],
    ['?x=1', '/'],
    ['/', '/'],
    ['/a%20b|c', '/a%20b|c'],
  ])('edgePath(%o) is %o', (raw, expected) => {
    expect(edgePath(raw)).toBe(expected);
  });
});

describe('signEdgeClientIp (WebCrypto, what a Worker runs)', () => {
  it('matches a known answer, computed independently', async () => {
    const headers = await signEdgeClientIp({
      secret: SECRET,
      ip: '203.0.113.7',
      method: 'POST',
      path: '/api/auth/sign-in/social',
      now: NOW,
    });

    expect(headers).toEqual({
      [EDGE_IP_HEADER]: '203.0.113.7',
      [EDGE_TS_HEADER]: '1760000000',
      [EDGE_SIG_HEADER]: 'gdQxzjw9N_pGx5luvB4iohEw5vNs6PGt2qm-DStr-WY',
    });
  });

  it('is byte-for-byte what Node’s HMAC gives, for IPv4 and IPv6, any method case, with a query ignored', async () => {
    for (const [ip, method, path] of [
      ['203.0.113.7', 'get', '/v1/things?limit=5'],
      ['2001:db8::1', 'POST', '/api/auth/callback/microsoft'],
      ['::ffff:203.0.113.7', 'Delete', '/'],
    ] as const) {
      const headers = await signEdgeClientIp({ secret: SECRET, ip, method, path, now: NOW });
      expect(headers[EDGE_SIG_HEADER]).toBe(
        nodeSignature(SECRET, 1760000000, ip, method.toUpperCase(), edgePath(path)),
      );
    }
  });

  it('truncates the time to whole seconds, and takes a Date', async () => {
    const a = await signEdgeClientIp({
      secret: SECRET,
      ip: '1.2.3.4',
      method: 'GET',
      path: '/',
      now: NOW + 999,
    });
    const b = await signEdgeClientIp({
      secret: SECRET,
      ip: '1.2.3.4',
      method: 'GET',
      path: '/',
      now: new Date(NOW),
    });
    expect(a[EDGE_TS_HEADER]).toBe('1760000000');
    expect(b[EDGE_SIG_HEADER]).toBe(a[EDGE_SIG_HEADER]);
  });

  it('produces a 43-character base64url signature', async () => {
    const { [EDGE_SIG_HEADER]: sig } = await signEdgeClientIp({
      secret: SECRET,
      ip: '1.2.3.4',
      method: 'GET',
      path: '/',
    });
    expect(sig).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('refuses a short secret and an address that is not one, rather than sign them', async () => {
    const base = { ip: '1.2.3.4', method: 'GET', path: '/' };
    await expect(signEdgeClientIp({ ...base, secret: 'short' })).rejects.toThrow(/at least 32/);
    for (const ip of ['', 'not-an-ip', 'evil\r\nheader', '1.2.3.4, 5.6.7.8', 'a'.repeat(100)]) {
      await expect(signEdgeClientIp({ ...base, secret: SECRET, ip })).rejects.toThrow(/not an IP/);
    }
  });

  it('never puts the secret in what it returns or in an error', async () => {
    const headers = await signEdgeClientIp({
      secret: SECRET,
      ip: '1.2.3.4',
      method: 'GET',
      path: '/',
    });
    expect(JSON.stringify(headers)).not.toContain(SECRET);
    const error = await signEdgeClientIp({
      secret: 'short-secret-value',
      ip: '1.2.3.4',
      method: 'GET',
      path: '/',
    }).catch((e: Error) => e);
    expect((error as Error).message).not.toContain('short-secret-value');
  });
});

describe('stripEdgeHeaders and applyEdgeClientIp (the Worker’s side)', () => {
  it('strips EVERY inbound x-qnsc-edge-* header, whatever its suffix or case, and nothing else', () => {
    const headers = new Headers({
      'x-qnsc-edge-ip': '6.6.6.6',
      'X-QNSC-EDGE-TS': '1',
      'x-qnsc-edge-sig': 'forged',
      'x-qnsc-edge-anything-else': 'x',
      'x-qnsc-client-ip': 'kept-not-the-edge-namespace',
      authorization: 'Bearer kept',
      cookie: 'kept=1',
    });
    stripEdgeHeaders(headers);

    expect([...headers.keys()].filter((k) => k.startsWith(EDGE_HEADER_PREFIX))).toEqual([]);
    expect(headers.get('authorization')).toBe('Bearer kept');
    expect(headers.get('cookie')).toBe('kept=1');
    expect(headers.get('x-qnsc-client-ip')).toBe('kept-not-the-edge-namespace');
  });

  it('replaces what a visitor sent with the signed trio', async () => {
    const headers = new Headers({
      'x-qnsc-edge-ip': '6.6.6.6',
      'x-qnsc-edge-ts': '1',
      'x-qnsc-edge-sig': 'forged',
    });
    const signed = await applyEdgeClientIp(headers, {
      secret: SECRET,
      ip: '203.0.113.7',
      method: 'POST',
      path: '/api/auth/sign-in/social',
      now: NOW,
    });

    expect(signed).toBe(true);
    expect(headers.get(EDGE_IP_HEADER)).toBe('203.0.113.7');
    expect(headers.get(EDGE_TS_HEADER)).toBe('1760000000');
    expect(headers.get(EDGE_SIG_HEADER)).toBe('gdQxzjw9N_pGx5luvB4iohEw5vNs6PGt2qm-DStr-WY');
  });

  it.each([null, undefined, '', 'not-an-ip'])(
    'with no usable address (%o) it strips, signs nothing and says so — the request goes unsigned',
    async (ip) => {
      const headers = new Headers({ 'x-qnsc-edge-ip': '6.6.6.6', 'x-qnsc-edge-sig': 'forged' });
      const signed = await applyEdgeClientIp(headers, {
        secret: SECRET,
        ip,
        method: 'GET',
        path: '/',
      });

      expect(signed).toBe(false);
      expect([...headers.keys()].filter((k) => k.startsWith(EDGE_HEADER_PREFIX))).toEqual([]);
    },
  );
});

describe('the Worker bundle', () => {
  // A Worker has no Node: the module it bundles must import none. Checked on the source and, when
  // built, on the compiled file and the root shim a bundler resolves.
  const src = readFileSync(join(import.meta.dirname, 'edge.ts'), 'utf8');
  const protocol = readFileSync(join(import.meta.dirname, 'edge-protocol.ts'), 'utf8');

  it('imports nothing from Node, nest, or the rest of the package', () => {
    const code = (source: string) =>
      source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const source of [src, protocol].map(code)) {
      const imports = [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]!);
      for (const spec of imports) expect(spec, spec).toMatch(/^\.\/edge-protocol$/);
    }
    expect(protocol).not.toMatch(/\bimport\b[^\n]*from/);
  });

  const root = join(import.meta.dirname, '..', '..');
  const built = existsSync(join(root, 'dist', 'http', 'edge.js'));
  it.runIf(Boolean(process.env['CI']))('is built when running on CI', () => {
    expect(built).toBe(true);
  });
  it.skipIf(!built)(
    'the compiled file requires only ./edge-protocol, and the shim points at it',
    () => {
      const compiled = readFileSync(join(root, 'dist', 'http', 'edge.js'), 'utf8');
      const requires = [...compiled.matchAll(/require\("([^"]+)"\)/g)].map((m) => m[1]);
      expect([...new Set(requires)]).toEqual(['./edge-protocol']);
      expect(readFileSync(join(root, 'edge.js'), 'utf8')).toContain("require('./dist/http/edge')");
      expect(readFileSync(join(root, 'edge.d.ts'), 'utf8')).toContain("'./dist/http/edge'");
      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
        files: string[];
      };
      expect(pkg.files).toEqual(expect.arrayContaining(['dist', 'edge.js', 'edge.d.ts']));
    },
  );
});
