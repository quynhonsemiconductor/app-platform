import { randomUUID } from 'node:crypto';
import type * as AzureIdentity from '@azure/identity';
import { MailSendError } from '../errors';
import { GRAPH_SCOPE, createGraphSender, type TokenProvider } from '../graph';

/**
 * The owner's three-step proof that a product's Graph mail works AND is scoped to one mailbox, run from a workstation after the setup in the
 * product's `docs/runbooks/mail-graph.md`. The same procedure, with the same output, as the Python product's `graph_mail_check.py`, so one
 * runbook serves every product.
 *
 *   1. TOKEN   the certificate is accepted and Entra issues a Graph token;
 *   2. SEND    `sendMail` AS the sender mailbox is accepted (HTTP 202);
 *   3. DENIED  `sendMail` AS a mailbox OUTSIDE the scope is REFUSED with 403. This is the negative test: it proves the Exchange RBAC scope is
 *              what limits the app. If it is accepted, the app can send as anyone, and the setup is wrong (an unscoped `Mail.Send` consent
 *              is still granted in Entra: grants there and Exchange RBAC grants are additive).
 *
 * It sends through the package's own Graph transport, so a pass is a pass for the code the product runs. Nothing printed contains the key, the
 * certificate or a token.
 */
export interface GraphCheckArgs {
  tenantId: string;
  clientId: string;
  /** PEM with the private key AND the certificate (the key file followed by the certificate file). */
  pem: string;
  /** The mailbox the app is scoped to. */
  sender: string;
  /** Recipient of the test message (the owner). */
  to: string;
  /**
   * Real mailboxes OUTSIDE the scope; sending as each must be refused with 403. Always include the OTHER environment's mailbox (develop's app
   * against production's, and the reverse). With none, the scope is not proven: the run says so and exits 3.
   */
  deniedMailboxes: readonly string[];
  /**
   * Application roles the token MAY carry. A mail-only app carries none (its only authority is the Exchange role), so any role fails `SCOPE`.
   * An app with other application permissions (opshub's Service app: five Graph roles) lists exactly those. A `Mail.*` role fails regardless.
   */
  allowedRoles?: readonly string[] | undefined;
  /** Test seam for a local fake Microsoft: `https://login.microsoftonline.com` by default. */
  authorityHost?: string | undefined;
  /** Test seam: `https://graph.microsoft.com/v1.0` by default. */
  graphBaseUrl?: string | undefined;
}

export interface GraphCheckDeps {
  /** Replaces the `@azure/identity` certificate credential. */
  credential?: TokenProvider;
  fetch?: typeof fetch;
  stdout: (line: string) => void;
}

function claimsOf(token: string): { appid?: string; azp?: string; roles?: string[] } {
  try {
    const payload = token.split('.')[1] ?? '';
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      appid?: string;
      azp?: string;
      roles?: string[];
    };
  } catch {
    return {};
  }
}

function describe(error: unknown): string {
  if (error instanceof MailSendError) {
    return `${error.code}${error.status === undefined ? '' : ` HTTP ${error.status}`} (request-id ${error.requestId ?? 'none'})`;
  }
  // Never the raw text of an unknown error: it may quote a request. The class name is enough to find it.
  return error instanceof Error ? error.name : 'unknown error';
}

/** @returns the process exit code: 0 when every check passed, 1 on any FAIL, 3 when nothing failed but the scope was not proven (no denied mailbox). */
export async function runGraphCheck(args: GraphCheckArgs, deps: GraphCheckDeps): Promise<number> {
  let failures = 0;
  const report = (name: string, ok: boolean, detail: string): void => {
    if (!ok) failures += 1;
    deps.stdout(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(7)} ${detail}`);
  };

  let credential = deps.credential;
  if (!credential) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- optional peer, loaded lazily (like the factory)
    const { ClientCertificateCredential } = require('@azure/identity') as typeof AzureIdentity;
    credential = new ClientCertificateCredential(
      args.tenantId,
      args.clientId,
      { certificate: args.pem },
      args.authorityHost ? { authorityHost: args.authorityHost } : {},
    );
  }

  try {
    const token = await credential.getToken(GRAPH_SCOPE);
    if (!token) throw new Error('no token');
    const claims = claimsOf(token.token);
    const roles = claims.roles ?? [];
    const issuedFor = claims.appid ?? claims.azp;
    if (issuedFor?.toLowerCase() !== args.clientId.toLowerCase()) {
      report(
        'TOKEN',
        false,
        `the token was issued for appid=${issuedFor ?? 'unknown'}, not --client-id ${args.clientId}: this is not the app you are proving`,
      );
      return 1;
    }
    report(
      'TOKEN',
      true,
      `issued for appid=${claims.appid ?? claims.azp ?? 'unknown'}; roles in the token: ${
        roles.length > 0
          ? roles.join(', ')
          : 'none (expected when authority comes from Exchange RBAC only)'
      }`,
    );
    // A mail-only app carries NO application role: its mail authority is the Exchange role alone. Any role it does carry is a grant made in Entra,
    // and an Entra grant is additive to (and, for Mail.*, wider than) the Exchange scope.
    const allowed = new Set(args.allowedRoles ?? []);
    const mailRoles = roles.filter((r) => r.startsWith('Mail.'));
    const unexpected = roles.filter((r) => !allowed.has(r));
    if (mailRoles.length > 0 || unexpected.length > 0) {
      report(
        'SCOPE',
        false,
        mailRoles.length > 0
          ? `the token carries ${mailRoles.join(', ')}: an unscoped Mail.* role in Entra makes the Exchange scope meaningless; remove the consent`
          : `the token carries ${unexpected.join(', ')}, not in --allowed-role${allowed.size === 0 ? ' (none given: a mail-only app carries no application role)' : ''}: remove the grant in Entra or list it`,
      );
    } else {
      report(
        'SCOPE',
        true,
        `roles seen: ${roles.length > 0 ? roles.join(', ') : 'none'}; all allowed, no Mail.*`,
      );
    }
  } catch (error) {
    // AADSTS errors name the problem (700027: the certificate in Entra is not the one whose key you hold); the name alone is not enough.
    const text = error instanceof Error ? (error.message.split('\n')[0] ?? error.name) : 'no token';
    report('TOKEN', false, text.replace(/[A-Za-z0-9+/=_-]{80,}/g, '[redacted]').slice(0, 300));
    return 1;
  }

  const sendAs = async (mailbox: string, subject: string, text: string): Promise<void> => {
    const sender = createGraphSender({
      sender: mailbox,
      credential: credential,
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
      ...(args.graphBaseUrl ? { baseUrl: args.graphBaseUrl } : {}),
      // A check, not a mail: no retry loop that could turn one refused attempt into three.
      maxAttempts: 1,
    });
    await sender.send({
      to: args.to,
      subject,
      html: `<p>${text}</p>`,
      text,
      category: 'ops.check',
      idempotencyKey: `graph-check:${randomUUID()}`,
    });
  };

  try {
    await sendAs(args.sender, 'Graph mail check', 'Test message from platform-mail-check.');
    report('SEND', true, `sent as ${args.sender} to ${args.to} (HTTP 202)`);
  } catch (error) {
    report('SEND', false, describe(error));
  }

  for (const denied of args.deniedMailboxes) {
    try {
      await sendAs(denied, 'Graph mail check (must be refused)', 'This must not arrive.');
      report(
        'DENIED',
        false,
        `sendMail AS ${denied} was ACCEPTED: the app can send as other mailboxes`,
      );
    } catch (error) {
      const forbidden = error instanceof MailSendError && error.status === 403;
      report(
        'DENIED',
        forbidden,
        `as ${denied}: ${describe(error)}${forbidden ? '' : '; expected 403'}`,
      );
    }
  }
  if (args.deniedMailboxes.length === 0) {
    deps.stdout('SKIP  DENIED  no --denied-mailbox given; the scope has NOT been proven');
    return failures > 0 ? 1 : 3;
  }
  return failures > 0 ? 1 : 0;
}
