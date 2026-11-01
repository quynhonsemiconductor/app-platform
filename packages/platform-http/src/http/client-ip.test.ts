import { describe, expect, it } from 'vitest';
import { UNKNOWN_CLIENT_IP, clientIp } from './client-ip';

describe('clientIp', () => {
  it('prefers cf-connecting-ip over everything else', () => {
    expect(
      clientIp({
        headers: { 'cf-connecting-ip': '203.0.113.7', 'x-forwarded-for': '198.51.100.9' },
        socket: { remoteAddress: '10.0.0.5' },
        ip: '10.0.0.5',
      }),
    ).toBe('203.0.113.7');
  });

  // `x-forwarded-for` is appended to by every hop, so its first entry is whatever the client
  // sent. It is not an address source: without `cf-connecting-ip` the socket is the answer.
  it('ignores x-forwarded-for entirely and uses the socket', () => {
    expect(
      clientIp({
        headers: { 'x-forwarded-for': '198.51.100.9, 10.1.1.1, 10.0.0.2' },
        socket: { remoteAddress: '10.0.0.5' },
      }),
    ).toBe('10.0.0.5');
  });

  it('falls back to the socket address when no header is present', () => {
    expect(clientIp({ headers: {}, socket: { remoteAddress: '10.0.0.5' } })).toBe('10.0.0.5');
  });

  // The attack this exists for: the client sends its own x-forwarded-for and, because
  // each proxy APPENDS, that forged value is the first entry. Cloudflare overwrites
  // cf-connecting-ip, so when it is there the forged chain must not matter.
  it('ignores a spoofed x-forwarded-for when cf-connecting-ip is present', () => {
    expect(
      clientIp({
        headers: {
          'cf-connecting-ip': '203.0.113.7',
          'x-forwarded-for': '1.1.1.1, 203.0.113.7',
        },
        socket: { remoteAddress: '10.0.0.5' },
      }),
    ).toBe('203.0.113.7');
  });

  it('supports IPv6 and IPv4-mapped IPv6 addresses', () => {
    expect(clientIp({ headers: { 'cf-connecting-ip': '2001:db8::1' } })).toBe('2001:db8::1');
    expect(clientIp({ headers: { 'cf-connecting-ip': '::ffff:203.0.113.7' } })).toBe(
      '::ffff:203.0.113.7',
    );
  });

  it('trims whitespace around a header value', () => {
    expect(clientIp({ headers: { 'cf-connecting-ip': '  203.0.113.7 ' } })).toBe('203.0.113.7');
  });

  it('takes the first value when a header arrives as an array', () => {
    expect(clientIp({ headers: { 'cf-connecting-ip': ['203.0.113.7', '1.1.1.1'] } })).toBe(
      '203.0.113.7',
    );
  });

  // The value lands in Redis keys and log lines. Text from a header is not an address.
  it.each([
    ['not-an-ip', 'a hostname'],
    ['203.0.113.7:4444', 'an address with a port'],
    ['1.1.1.1\nfake log line', 'an injected newline'],
    ['a'.repeat(5_000), 'an enormous value'],
    ['', 'an empty value'],
  ])('skips a cf-connecting-ip that is %o (%s) and uses the socket', (bad) => {
    expect(
      clientIp({
        headers: { 'cf-connecting-ip': bad, 'x-forwarded-for': '198.51.100.9' },
        socket: { remoteAddress: '10.0.0.5' },
      }),
    ).toBe('10.0.0.5');
  });

  it('never trusts a garbage or valid x-forwarded-for', () => {
    expect(
      clientIp({
        headers: { 'x-forwarded-for': 'unknown, 198.51.100.9' },
        socket: { remoteAddress: '10.0.0.5' },
      }),
    ).toBe('10.0.0.5');
    expect(clientIp({ headers: { 'x-forwarded-for': '203.0.113.7' } })).toBe(UNKNOWN_CLIENT_IP);
  });

  it("falls back to the framework's resolved ip last", () => {
    expect(clientIp({ headers: {}, ip: '10.9.9.9' })).toBe('10.9.9.9');
    expect(clientIp({ ip: '10.9.9.9' })).toBe('10.9.9.9');
  });

  it('never throws and never returns an empty string', () => {
    expect(clientIp({})).toBe(UNKNOWN_CLIENT_IP);
    expect(clientIp({ headers: {}, socket: {} })).toBe(UNKNOWN_CLIENT_IP);
  });

  it('accepts a real Fastify request shape', async () => {
    const { default: Fastify } = await import('fastify');
    const app = Fastify();
    app.get('/', (req) => ({ ip: clientIp(req) }));
    const res = await app.inject({
      url: '/',
      headers: { 'cf-connecting-ip': '203.0.113.7', 'x-forwarded-for': '1.1.1.1' },
    });
    expect(res.json()).toEqual({ ip: '203.0.113.7' });

    const direct = await app.inject({ url: '/', remoteAddress: '192.0.2.44' });
    expect(direct.json()).toEqual({ ip: '192.0.2.44' });
    await app.close();
  });
});
