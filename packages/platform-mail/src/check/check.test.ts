import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateCertificatePem } from '../__helpers__/certificate';
import { GraphServer } from '../__helpers__/graph-server';
import { runGraphCheck, type GraphCheckArgs } from './check';

const jwt = (claims: object): string =>
  `${Buffer.from('{"alg":"RS256"}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`;

const tokenWith = (claims: object) => ({
  getToken: () => Promise.resolve({ token: jwt(claims) }),
});

describe('runGraphCheck (platform-mail-check)', () => {
  const server = new GraphServer();
  const lines: string[] = [];
  const args = (over: Partial<GraphCheckArgs> = {}): GraphCheckArgs => ({
    tenantId: '11111111-1111-1111-1111-111111111111',
    clientId: '22222222-2222-2222-2222-222222222222',
    pem: 'unused-with-an-injected-credential',
    sender: 'noreply-rova@qnsc.vn',
    to: 'owner@qnsc.vn',
    deniedMailbox: 'noreply-opshub@qnsc.vn',
    graphBaseUrl: server.baseUrl,
    ...over,
  });
  const run = (over: Partial<GraphCheckArgs> = {}, claims: object = { appid: 'app-1' }) =>
    runGraphCheck(args(over), { credential: tokenWith(claims), stdout: (l) => lines.push(l) });

  beforeEach(async () => {
    lines.length = 0;
    server.requests.length = 0;
    await server.start();
  });
  afterEach(async () => {
    await server.stop();
  });

  it('PASS, PASS, PASS when the app sends as its mailbox and is refused as another (exit 0)', async () => {
    server.reply({ status: 202 }); // SEND
    server.reply({
      status: 403,
      body: { error: { code: 'ErrorAccessDenied' } },
      headers: { 'request-id': 'abc' },
    }); // DENIED

    expect(await run()).toBe(0);

    expect(lines[0]).toMatch(
      /^PASS {2}TOKEN {3}issued for appid=app-1; roles in the token: none \(expected when authority comes from Exchange RBAC only\)$/,
    );
    expect(lines[1]).toBe('PASS  SEND    sent as noreply-rova@qnsc.vn to owner@qnsc.vn (HTTP 202)');
    expect(lines[2]).toMatch(
      /^PASS {2}DENIED {2}as noreply-opshub@qnsc\.vn: forbidden HTTP 403 \(request-id abc\)$/,
    );
    // The two sends went out as the right mailboxes.
    expect(server.requests.map((r) => r.url)).toEqual([
      '/v1.0/users/noreply-rova%40qnsc.vn/sendMail',
      '/v1.0/users/noreply-opshub%40qnsc.vn/sendMail',
    ]);
  });

  it('FAILS the negative test when sending as another mailbox is ACCEPTED: the app can send as anyone (exit 1)', async () => {
    server.reply({ status: 202 });
    server.reply({ status: 202 });
    expect(await run()).toBe(1);
    expect(lines[2]).toBe(
      'FAIL  DENIED  sendMail AS noreply-opshub@qnsc.vn was ACCEPTED: the app can send as other mailboxes',
    );
  });

  it('FAILS the scope when the token carries an unscoped Mail.Send role (the consent that cancels the Exchange scope)', async () => {
    server.reply({ status: 202 });
    server.reply({ status: 403 });
    expect(await run({}, { appid: 'app-1', roles: ['Mail.Send'] })).toBe(1);
    expect(lines.some((l) => l.startsWith('FAIL  SCOPE'))).toBe(true);
    expect(lines[0]).toContain('roles in the token: Mail.Send');
  });

  it('expects 403 specifically: a 404 for the other mailbox is not proof of the scope', async () => {
    server.reply({ status: 202 });
    server.reply({ status: 404 });
    expect(await run()).toBe(1);
    expect(lines[2]).toMatch(/^FAIL {2}DENIED .*mailbox_not_found HTTP 404.*; expected 403$/);
  });

  it('reports a refused SEND (the allowed mailbox must work) and still runs the negative test', async () => {
    server.reply({ status: 403, headers: { 'request-id': 'r1' } });
    server.reply({ status: 403 });
    expect(await run()).toBe(1);
    expect(lines[1]).toBe('FAIL  SEND    forbidden HTTP 403 (request-id r1)');
    expect(lines[2]).toMatch(/^PASS {2}DENIED/);
  });

  it('says the scope has NOT been proven when no other mailbox is given (exit 0 would be a lie, so it is only a SKIP line)', async () => {
    server.reply({ status: 202 });
    expect(await run({ deniedMailbox: undefined })).toBe(0);
    expect(lines.at(-1)).toBe(
      'SKIP  DENIED  no --denied-mailbox given; the scope has NOT been proven',
    );
  });

  it('stops at TOKEN when the certificate is refused, and never prints a long opaque value', async () => {
    const credential = {
      getToken: () =>
        Promise.reject(
          new Error(
            `AADSTS700027: Client assertion contains an invalid signature. ${'A'.repeat(200)}\ntrace`,
          ),
        ),
    };
    const code = await runGraphCheck(args(), { credential, stdout: (l) => lines.push(l) });
    expect(code).toBe(1);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^FAIL {2}TOKEN {3}AADSTS700027/);
    expect(lines[0]).not.toContain('A'.repeat(80));
    expect(server.requests).toHaveLength(0);
  });

  it('never prints the token or the key', async () => {
    server.reply({ status: 202 });
    server.reply({ status: 403 });
    const pem = generateCertificatePem();
    const keyFragment = pem.split('\n')[1]!.slice(0, 24);
    await run({ pem });
    const out = lines.join('\n');
    expect(keyFragment.length).toBeGreaterThan(10);
    expect(out).not.toContain(keyFragment);
    expect(out).not.toContain('signature');
  });
});
