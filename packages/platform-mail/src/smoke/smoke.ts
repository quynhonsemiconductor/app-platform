import { randomUUID } from 'node:crypto';
import type { MailEnv } from '../config';
import { MailConfigError, MailSendError, type MailErrorCode } from '../errors';
import { createEmailSender, type CreateEmailSenderOptions } from '../factory';
import type { EmailMessage } from '../message';

/**
 * The post-deploy smoke test: ONE real email, sent directly through the transport the app uses.
 *
 * It exists to answer, minutes after a deploy and before any user asks, "can this product send
 * mail?" — the question a green health check does not answer, because `/readyz` never talks to
 * Exchange. A wrong mailbox, a missing federated token, a management scope that was never
 * assigned, an Entra app without the role: every one of them is invisible until the first
 * password reset fails. It bypasses the queue on purpose, so it proves the Graph path even when
 * no worker is running.
 */

/**
 * Exit codes. Distinct so a deploy pipeline (or a person reading a Job's status) can tell WHICH
 * thing is wrong without reading the log; every failure prints the same short line.
 *
 * | code | meaning                                                                        |
 * | ---- | ------------------------------------------------------------------------------ |
 * | 0    | one message was accepted by the provider                                        |
 * | 1    | failed in some other way (provider down, timeout, network, a rejected message)  |
 * | 2    | configuration: a variable is missing or refused (this includes `smtp` in production and a recipient outside `@qnsc.vn`) |
 * | 3    | authentication: no token could be obtained, or the provider refused it (401)    |
 * | 4    | **forbidden** (403): the app may not send from this mailbox — the RBAC scope is wrong |
 * | 5    | throttled (429) even after the transport's own retries                          |
 * | 6    | the sender mailbox does not exist (404)                                          |
 */
export const SMOKE_EXIT = Object.freeze({
  ok: 0,
  failed: 1,
  config: 2,
  auth: 3,
  forbidden: 4,
  throttled: 5,
  mailboxNotFound: 6,
});

export const SMOKE_CATEGORY = 'ops.smoke';

/** The only domain the smoke test may email: it must never reach a customer. */
export const SMOKE_DOMAIN = 'qnsc.vn';

/** Longest the whole run may take; a Job must never hang. */
export const SMOKE_TIMEOUT_MS = 60_000;

const EXIT_FOR_CODE: Readonly<Partial<Record<MailErrorCode, number>>> = {
  config: SMOKE_EXIT.config,
  unauthenticated: SMOKE_EXIT.auth,
  forbidden: SMOKE_EXIT.forbidden,
  throttled: SMOKE_EXIT.throttled,
  mailbox_not_found: SMOKE_EXIT.mailboxNotFound,
};

export interface SmokeDeps {
  env: MailEnv;
  /** One line to standard output (success). */
  stdout: (line: string) => void;
  /** One line to standard error (failure). */
  stderr: (line: string) => void;
  /** Test seams, passed to `createEmailSender`. */
  credential?: CreateEmailSenderOptions['credential'];
  fetch?: CreateEmailSenderOptions['fetch'];
  loadSmtp?: CreateEmailSenderOptions['loadSmtp'];
  now?: () => Date;
  timeoutMs?: number;
}

const PLAIN_ADDRESS = /^[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+)$/;
// A version is printed into a subject: keep it to what a release tag looks like.
const SAFE_VERSION = /^[A-Za-z0-9._+-]{1,64}$/;

/**
 * `MAIL_SMOKE_TO`: required, ONE plain address, and its domain must be exactly `qnsc.vn`. Refused
 * otherwise, and the refusal never echoes the value. (A subdomain, a list and a display name are
 * all refused: the rule is "a mailbox we own", checked as strictly as it is cheap.)
 */
function smokeRecipient(env: MailEnv): string {
  const raw = env['MAIL_SMOKE_TO']?.trim();
  if (!raw) {
    throw new MailConfigError(
      `MAIL_SMOKE_TO is required: the @${SMOKE_DOMAIN} address that receives the test message.`,
    );
  }
  const match = PLAIN_ADDRESS.exec(raw);
  if (!match || match[1]!.toLowerCase() !== SMOKE_DOMAIN) {
    throw new MailConfigError(
      `MAIL_SMOKE_TO must be one plain @${SMOKE_DOMAIN} address; the smoke test never emails anyone else.`,
    );
  }
  return raw;
}

function smokeMessage(to: string, env: MailEnv, now: Date): EmailMessage {
  const rawVersion = env['SERVICE_VERSION']?.trim();
  const version = rawVersion && SAFE_VERSION.test(rawVersion) ? rawVersion : 'unknown';
  const timestamp = now.toISOString();
  return {
    to,
    subject: `[smoke] platform-mail ${version} ${timestamp}`,
    html: `<p>Post-deploy mail smoke test.</p><p>Version ${version}, ${timestamp}.</p><p>Nothing to do: it confirms this deployment can send mail.</p>`,
    text: `Post-deploy mail smoke test.\nVersion ${version}, ${timestamp}.\nNothing to do: it confirms this deployment can send mail.`,
    category: SMOKE_CATEGORY,
    // Unique per run: a smoke test that deduplicated itself would prove nothing.
    idempotencyKey: `smoke:${version}:${timestamp}:${randomUUID()}`,
  };
}

/**
 * Run the smoke test and return the process exit code. Prints exactly one line: on success
 * `OK transport=… id=…` to standard output; on failure `FAILED code=… [status=…] [request=…]` to
 * standard error. Never a token, a message body, a recipient or a provider's free text.
 * `config` failures add the error's own text, which names a variable and never its value.
 */
export async function runSmoke(deps: SmokeDeps): Promise<number> {
  const { env } = deps;
  try {
    const to = smokeRecipient(env);
    // The same construction the app uses: MAIL_TRANSPORT, MAIL_GRAPH_SENDER, workload identity.
    // `smtp` is refused here when NODE_ENV=production, exactly as it is in the app.
    const sender = createEmailSender({
      env,
      ...(deps.credential ? { credential: deps.credential } : {}),
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
      ...(deps.loadSmtp ? { loadSmtp: deps.loadSmtp } : {}),
    });
    const message = smokeMessage(to, env, (deps.now ?? (() => new Date()))());

    // Direct send, not the queue: a deploy step must not depend on a worker being up.
    const result = await sender.send(message, {
      signal: AbortSignal.timeout(deps.timeoutMs ?? SMOKE_TIMEOUT_MS),
    });
    deps.stdout(`platform-mail-smoke: OK transport=${result.transport} id=${result.id}`);
    return SMOKE_EXIT.ok;
  } catch (error) {
    if (error instanceof MailConfigError) {
      deps.stderr(`platform-mail-smoke: FAILED code=config ${error.message}`);
      return SMOKE_EXIT.config;
    }
    if (error instanceof MailSendError) {
      const fields = [`code=${error.code}`];
      if (error.status !== undefined) fields.push(`status=${error.status}`);
      if (error.requestId !== undefined) fields.push(`request=${error.requestId}`);
      deps.stderr(`platform-mail-smoke: FAILED ${fields.join(' ')}`);
      return EXIT_FOR_CODE[error.code] ?? SMOKE_EXIT.failed;
    }
    // Anything else is a bug here, not a mail problem: say so without printing the error, which
    // could carry anything.
    deps.stderr('platform-mail-smoke: FAILED code=internal');
    return SMOKE_EXIT.failed;
  }
}
