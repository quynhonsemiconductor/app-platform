import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateCertificatePem } from '../__helpers__/certificate';
import { GraphServer } from '../__helpers__/graph-server';
import { runGraphCheck, type GraphCheckArgs } from './check';

const CLIENT = '22222222-2222-2222-2222-222222222222';

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
    deniedMailboxes: ['noreply-opshub@qnsc.vn'],
    graphBaseUrl: server.baseUrl,
    ...over,
  });
  const run = (
    over: Partial<GraphCheckArgs> = {},
    claims: object = { appid: '22222222-2222-2222-2222-222222222222' },
  ) => runGraphCheck(args(over), { credential: tokenWith(claims), stdout: (l) => lines.push(l) });

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
      /^PASS {2}TOKEN {3}issued for appid=22222222-2222-2222-2222-222222222222; roles in the token: none \(expected when authority comes from Exchange RBAC only\)$/,
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
    expect(
      await run({}, { appid: '22222222-2222-2222-2222-222222222222', roles: ['Mail.Send'] }),
    ).toBe(1);
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

  it('says the scope has NOT been proven when no other mailbox is given, and exits 3 (not 0: a green run would be a lie)', async () => {
    server.reply({ status: 202 });
    expect(await run({ deniedMailboxes: [] })).toBe(3);
    expect(lines.at(-1)).toBe(
      'SKIP  DENIED  no --denied-mailbox given; the scope has NOT been proven',
    );
  });

  it("runs the negative test against EVERY denied mailbox: the other environment's and another product's", async () => {
    server.reply({ status: 202 });
    server.reply({ status: 403 });
    server.reply({ status: 403 });
    expect(await run({ deniedMailboxes: ['noreply-rova@qnsc.vn', 'noreply-opshub@qnsc.vn'] })).toBe(
      0,
    );
    expect(lines.filter((l) => l.startsWith('PASS  DENIED'))).toHaveLength(2);
    expect(server.requests.map((r) => r.url).slice(1)).toEqual([
      '/v1.0/users/noreply-rova%40qnsc.vn/sendMail',
      '/v1.0/users/noreply-opshub%40qnsc.vn/sendMail',
    ]);
  });

  it('fails when ANY denied mailbox is accepted, even if the first was refused', async () => {
    server.reply({ status: 202 });
    server.reply({ status: 403 });
    server.reply({ status: 202 });
    expect(await run({ deniedMailboxes: ['noreply-rova@qnsc.vn', 'noreply-opshub@qnsc.vn'] })).toBe(
      1,
    );
    expect(lines.at(-1)).toMatch(
      /^FAIL {2}DENIED {2}sendMail AS noreply-opshub@qnsc\.vn was ACCEPTED/,
    );
  });

  describe('SCOPE: a mail-only app carries no application role at all', () => {
    it.each([['Mail.Send'], ['Mail.ReadWrite'], ['User.Read.All']])('fails on %s', async (role) => {
      server.reply({ status: 202 });
      server.reply({ status: 403 });
      expect(await run({}, { appid: CLIENT, roles: [role] })).toBe(1);
      expect(lines.some((l) => l.startsWith('FAIL  SCOPE') && l.includes(role))).toBe(true);
    });

    it("passes the roles an app legitimately holds when they are listed (opshub's Service app: five Graph roles)", async () => {
      const five = [
        'SecurityEvents.Read.All',
        'DeviceManagementManagedDevices.Read.All',
        'User.EnableDisableAccount.All',
        'User.Read.All',
        'User.RevokeSessions.All',
      ];
      server.reply({ status: 202 });
      server.reply({ status: 403 });
      expect(await run({ allowedRoles: five }, { appid: CLIENT, roles: five })).toBe(0);
      expect(lines.some((l) => l.startsWith('FAIL'))).toBe(false);
    });

    it('still fails on a role that is NOT listed, and on any Mail.* even when listed', async () => {
      server.reply({ status: 202 });
      server.reply({ status: 403 });
      expect(
        await run(
          { allowedRoles: ['User.Read.All'] },
          { appid: CLIENT, roles: ['User.Read.All', 'Directory.Read.All'] },
        ),
      ).toBe(1);
      expect(lines.find((l) => l.startsWith('FAIL  SCOPE'))).toContain('Directory.Read.All');
      lines.length = 0;
      server.reply({ status: 202 });
      server.reply({ status: 403 });
      expect(
        await run({ allowedRoles: ['Mail.Send'] }, { appid: CLIENT, roles: ['Mail.Send'] }),
      ).toBe(1);
      expect(lines.find((l) => l.startsWith('FAIL  SCOPE'))).toContain('Mail.Send');
    });
  });

  it('FAILS the token when it was issued for a different app than --client-id (wrong credentials), and sends nothing', async () => {
    expect(await run({}, { appid: '99999999-9999-9999-9999-999999999999' })).toBe(1);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(
      /^FAIL {2}TOKEN {3}the token was issued for appid=99999999.*not --client-id/,
    );
    expect(server.requests).toHaveLength(0);
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

  it('through the REAL certificate credential, a key it cannot use fails TOKEN without printing the key', async () => {
    // No injected credential: this is `@azure/identity`'s ClientCertificateCredential. A PEM it cannot sign with fails before any network call.
    const marker = 'bm90LWEtcmVhbC1rZXktbWFya2VyLW5vdC1hLXJlYWwta2V5';
    const pem = `${['-----BEGIN', 'PRIVATE KEY-----'].join(' ')}\n${marker}\n${['-----END', 'PRIVATE KEY-----'].join(' ')}\n${generateCertificatePem().replace(/[\s\S]*?(-----BEGIN CERTIFICATE-----)/, '$1')}`;
    const out: string[] = [];
    const code = await runGraphCheck(args({ pem }), { stdout: (l) => out.push(l) });
    expect(code).toBe(1);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/^FAIL {2}TOKEN /);
    expect(out.join('\n')).not.toContain(marker);
    expect(server.requests).toHaveLength(0);
  });
});
