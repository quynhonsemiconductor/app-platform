import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphServer, graphError } from '../__helpers__/graph-server';
import { SMOKE_CATEGORY, SMOKE_EXIT, runSmoke } from './smoke';

const SENDER = 'noreply-academy@qnsc.vn';
const TOKEN = 'very-secret-token-value';
const CLIENT_SECRET = 's3cret-client-value-do-not-print';
const NOW = new Date('2026-10-11T12:00:00.000Z');

const ENV = {
  MAIL_TRANSPORT: 'graph',
  MAIL_GRAPH_SENDER: SENDER,
  AZURE_TENANT_ID: '11111111-1111-1111-1111-111111111111',
  AZURE_CLIENT_ID: '22222222-2222-2222-2222-222222222222',
  AZURE_FEDERATED_TOKEN_FILE: '/never/read',
  MAIL_SMOKE_TO: 'ops@qnsc.vn',
  SERVICE_VERSION: '1.4.2',
  AZURE_CLIENT_SECRET: CLIENT_SECRET, // present, to prove it is never printed
};

let server: GraphServer;
beforeEach(async () => {
  server = new GraphServer();
  await server.start();
});
afterEach(() => server.stop());

/** Run the smoke test against the local Graph server and collect everything it printed. */
async function smoke(
  env: Record<string, string | undefined> = ENV,
  extra: Partial<Parameters<typeof runSmoke>[0]> = {},
) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runSmoke({
    env,
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    now: () => NOW,
    credential: { getToken: vi.fn(async () => ({ token: TOKEN })) },
    fetch: (input, init) =>
      fetch(String(input).replace('https://graph.microsoft.com/v1.0', server.baseUrl), init),
    ...extra,
  });
  return { code, out, err, printed: [...out, ...err].join('\n') };
}

const subjectOf = (index: number): string =>
  (server.requests[index]?.body as { message: { subject: string } }).message.subject;

describe('the exit codes', () => {
  it('202 ⇒ 0, and it prints one OK line with the transport and the provider’s request id', async () => {
    server.reply({ status: 202, headers: { 'request-id': 'graph-req-77' } });
    const { code, out, err } = await smoke();

    expect(code).toBe(SMOKE_EXIT.ok);
    expect(out).toEqual(['platform-mail-smoke: OK transport=graph id=graph-req-77']);
    expect(err).toEqual([]);
  });

  it('403 ⇒ the scope exit code (4), printing the code, the status and the request id only', async () => {
    server.reply({
      status: 403,
      headers: { 'request-id': 'rid-403' },
      body: graphError('ErrorAccessDenied'),
    });
    const { code, out, err } = await smoke();

    expect(code).toBe(SMOKE_EXIT.forbidden);
    expect(code).toBe(4);
    expect(out).toEqual([]);
    expect(err).toEqual(['platform-mail-smoke: FAILED code=forbidden status=403 request=rid-403']);
  });

  it('401 ⇒ the auth exit code (3)', async () => {
    server.reply({
      status: 401,
      headers: { 'request-id': 'rid-401' },
      body: graphError('InvalidAuthenticationToken'),
    });
    const { code, err } = await smoke();

    expect(code).toBe(SMOKE_EXIT.auth);
    expect(err).toEqual([
      'platform-mail-smoke: FAILED code=unauthenticated status=401 request=rid-401',
    ]);
  });

  it('no token at all (the federated credential is broken) ⇒ the auth exit code, and no request is made', async () => {
    const credential = {
      getToken: async () => {
        throw Object.assign(new Error('AADSTS70021: No matching federated identity record found'), {
          name: 'AuthenticationError',
        });
      },
    };
    const { code, err, printed } = await smoke(ENV, { credential });

    expect(code).toBe(SMOKE_EXIT.auth);
    expect(err).toEqual(['platform-mail-smoke: FAILED code=unauthenticated']);
    expect(server.requests).toHaveLength(0);
    expect(printed).not.toContain('AADSTS'); // the authority's own text never reaches the log
  });

  it('429 ⇒ the throttle exit code (5), after the transport’s own retries', async () => {
    const throttled = { status: 429, headers: { 'retry-after': '0', 'request-id': 'rid-429' } };
    server.reply(throttled, throttled, throttled);
    const { code, err } = await smoke();

    expect(code).toBe(SMOKE_EXIT.throttled);
    expect(err).toEqual(['platform-mail-smoke: FAILED code=throttled status=429 request=rid-429']);
    expect(server.requests).toHaveLength(3);
  });

  it('a 429 with a Retry-After too long to wait out fails at once with the throttle code', async () => {
    server.reply({ status: 429, headers: { 'retry-after': '3600' } });
    const started = Date.now();
    const { code } = await smoke();

    expect(code).toBe(SMOKE_EXIT.throttled);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(server.requests).toHaveLength(1);
  });

  it('404 ⇒ the mailbox-not-found exit code (6): the sender address is wrong', async () => {
    server.reply({ status: 404, body: graphError('ErrorInvalidUser') });
    const { code, err } = await smoke();

    expect(code).toBe(SMOKE_EXIT.mailboxNotFound);
    expect(err[0]).toMatch(/code=mailbox_not_found status=404/);
  });

  it('anything else (a 500, a hung provider) ⇒ 1, and it does not hang past its deadline', async () => {
    server.reply({ status: 500 });
    expect((await smoke()).code).toBe(SMOKE_EXIT.failed);

    server.hang = true;
    const started = Date.now();
    const timedOut = await smoke(ENV, { timeoutMs: 200 });
    expect(timedOut.code).toBe(SMOKE_EXIT.failed);
    expect(timedOut.err[0]).toMatch(/code=timeout/);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('uses distinct codes for the four things an operator must tell apart', () => {
    const codes = [SMOKE_EXIT.config, SMOKE_EXIT.auth, SMOKE_EXIT.forbidden, SMOKE_EXIT.throttled];
    expect(new Set(codes).size).toBe(4);
    expect(codes).not.toContain(SMOKE_EXIT.ok);
    expect(codes).not.toContain(SMOKE_EXIT.failed);
  });
});

describe('what it sends', () => {
  it('ONE message, directly through the transport, to MAIL_SMOKE_TO, from the app’s own mailbox', async () => {
    await smoke();

    expect(server.requests).toHaveLength(1);
    const [request] = server.requests;
    expect(request?.url).toBe(`/v1.0/users/${encodeURIComponent(SENDER)}/sendMail`);
    const { message } = request?.body as {
      message: { toRecipients: { emailAddress: { address: string } }[] };
    };
    expect(message.toRecipients).toEqual([{ emailAddress: { address: 'ops@qnsc.vn' } }]);
  });

  it('puts the version and the timestamp in the subject', async () => {
    await smoke();

    expect(subjectOf(0)).toBe('[smoke] platform-mail 1.4.2 2026-10-11T12:00:00.000Z');
  });

  it('falls back to "unknown" for a version that is absent or not release-shaped (it goes in a subject)', async () => {
    await smoke({ ...ENV, SERVICE_VERSION: undefined });
    await smoke({ ...ENV, SERVICE_VERSION: '1.0\r\nBcc: x@evil.test' });

    expect(subjectOf(0)).toBe('[smoke] platform-mail unknown 2026-10-11T12:00:00.000Z');
    expect(subjectOf(1)).toBe('[smoke] platform-mail unknown 2026-10-11T12:00:00.000Z');
  });

  it('sends the ops.smoke category through the same sender the app builds', async () => {
    expect(SMOKE_CATEGORY).toBe('ops.smoke');
    // The category is validated by the sender (lower-case words), so a rename that broke it would
    // turn every smoke test into a config-shaped failure; this run proves it still passes.
    expect((await smoke()).code).toBe(SMOKE_EXIT.ok);
  });

  it('does not touch the job queue: it needs no database, no Valkey and no worker', async () => {
    // The environment holds none of DATABASE_*, REDIS_URL or ROLE, and it still sends.
    const { code } = await smoke({
      ...ENV,
      DATABASE_HOST: undefined,
      REDIS_URL: undefined,
      ROLE: undefined,
    });
    expect(code).toBe(SMOKE_EXIT.ok);
  });
});

describe('the recipient is always an @qnsc.vn address (config exit code 2)', () => {
  it('is required', async () => {
    const { code, err } = await smoke({ ...ENV, MAIL_SMOKE_TO: undefined });

    expect(code).toBe(SMOKE_EXIT.config);
    expect(err[0]).toMatch(/code=config MAIL_SMOKE_TO is required/);
    expect(server.requests).toHaveLength(0);
  });

  it.each([
    ['another domain', 'someone@gmail.com'],
    ['a customer-looking address', 'customer@example.com'],
    ['a lookalike domain', 'ops@qnsc.vn.evil.test'],
    ['a prefix lookalike', 'ops@notqnsc.vn'],
    ['a subdomain', 'ops@mail.qnsc.vn'],
    ['a list with one outsider', 'ops@qnsc.vn,someone@gmail.com'],
    ['a display name', 'Ops <ops@qnsc.vn>'],
    ['a space-separated list', 'ops@qnsc.vn someone@gmail.com'],
    ['a newline', 'ops@qnsc.vn\nBcc: x@evil.test'],
    ['no domain', 'ops'],
    ['an empty string', '   '],
  ])('refuses %s, sends nothing, and does not echo the value', async (_label, to) => {
    const { code, err, printed } = await smoke({ ...ENV, MAIL_SMOKE_TO: to });

    expect(code).toBe(SMOKE_EXIT.config);
    expect(server.requests).toHaveLength(0);
    expect(err[0]).toMatch(/^platform-mail-smoke: FAILED code=config MAIL_SMOKE_TO/);
    const needle = to.trim().split(/[\s,<]/)[0] ?? '';
    if (needle.length > 3) expect(printed).not.toContain(needle);
  });

  it.each(['ops@qnsc.vn', 'OPS@QNSC.VN', 'first.last+smoke@Qnsc.vn', ' ops@qnsc.vn '])(
    'accepts %o',
    async (to) => {
      expect((await smoke({ ...ENV, MAIL_SMOKE_TO: to })).code).toBe(SMOKE_EXIT.ok);
    },
  );
});

describe('configuration errors (exit code 2)', () => {
  it.each([
    ['no transport', { MAIL_TRANSPORT: undefined }, /MAIL_TRANSPORT is required/],
    ['no sender mailbox', { MAIL_GRAPH_SENDER: undefined }, /MAIL_GRAPH_SENDER is required/],
    ['no tenant', { AZURE_TENANT_ID: undefined }, /AZURE_TENANT_ID is required/],
    ['an unsupported transport', { MAIL_TRANSPORT: 'resend' }, /not supported/],
  ])('%s', async (_label, patch, message) => {
    const { code, err } = await smoke({ ...ENV, ...patch });

    expect(code).toBe(SMOKE_EXIT.config);
    expect(err[0]).toMatch(message);
    expect(server.requests).toHaveLength(0);
  });

  it('smtp is refused when NODE_ENV=production — before nodemailer is even loaded', async () => {
    const loadSmtp = vi.fn(() => {
      throw new Error('the smtp module must not be loaded in production');
    });
    const { code, err } = await smoke(
      { MAIL_TRANSPORT: 'smtp', NODE_ENV: 'production', MAIL_SMOKE_TO: 'ops@qnsc.vn' },
      { loadSmtp: loadSmtp as never },
    );

    expect(code).toBe(SMOKE_EXIT.config);
    expect(err[0]).toMatch(/MAIL_TRANSPORT=smtp is refused when NODE_ENV=production/);
    expect(loadSmtp).not.toHaveBeenCalled();
  });

  it('a client secret is refused in production, as in the app', async () => {
    const { code, err } = await smoke({
      ...ENV,
      NODE_ENV: 'production',
      AZURE_FEDERATED_TOKEN_FILE: undefined,
    });

    expect(code).toBe(SMOKE_EXIT.config);
    expect(err[0]).toMatch(/refused when NODE_ENV=production/);
  });
});

describe('nothing secret is printed', () => {
  const outcomes: [string, () => void, Record<string, string | undefined>?][] = [
    ['success', () => server.reply({ status: 202 })],
    [
      '403',
      () =>
        server.reply({
          status: 403,
          body: graphError('ErrorAccessDenied', `leak ${TOKEN} ${CLIENT_SECRET}`),
        }),
    ],
    [
      '401',
      () =>
        server.reply({
          status: 401,
          body: graphError('InvalidAuthenticationToken', `leak ${TOKEN}`),
        }),
    ],
    ['429', () => server.reply({ status: 429, headers: { 'retry-after': '3600' } })],
    [
      '500',
      () => server.reply({ status: 500, body: { error: { code: 'X', message: `leak ${TOKEN}` } } }),
    ],
    ['a bad recipient', () => undefined, { MAIL_SMOKE_TO: `${CLIENT_SECRET}@gmail.com` }],
    ['a missing variable', () => undefined, { MAIL_GRAPH_SENDER: undefined }],
  ];

  it.each(outcomes)(
    '%s: no token, client secret, message body or provider text on stdout or stderr',
    async (_label, arrange, patch) => {
      arrange();
      const { printed } = await smoke({ ...ENV, ...patch });

      for (const secret of [
        TOKEN,
        CLIENT_SECRET,
        'leak',
        'Post-deploy mail smoke test',
        '/never/read',
      ]) {
        expect(printed, `printed "${secret}"`).not.toContain(secret);
      }
      // One line, and a prefix a log search can rely on.
      expect(printed.split('\n')).toHaveLength(1);
      expect(printed).toMatch(/^platform-mail-smoke: (OK|FAILED) /);
    },
  );

  it('an unexpected exception prints only code=internal, never the error', async () => {
    const { code, printed } = await smoke(ENV, {
      fetch: async () => {
        throw new TypeError(`boom ${TOKEN}`);
      },
    });

    expect(code).toBe(SMOKE_EXIT.failed);
    expect(printed).not.toContain(TOKEN);
    expect(printed).toBe('platform-mail-smoke: FAILED code=network');
  });

  it('an error that is not a mail error is reported as code=internal, without its text', async () => {
    const { code, printed } = await smoke(
      { MAIL_TRANSPORT: 'smtp', NODE_ENV: 'development', MAIL_SMOKE_TO: 'ops@qnsc.vn' },
      {
        loadSmtp: (() => ({
          createSmtpSender: () => {
            throw new Error(`boom ${TOKEN}`);
          },
        })) as never,
      },
    );

    expect(code).toBe(SMOKE_EXIT.failed);
    expect(printed).toBe('platform-mail-smoke: FAILED code=internal');
  });
});
