#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { runGraphCheck } from './check';

/**
 * `platform-mail-check`: the owner's TOKEN / SEND / DENIED proof (see `check.ts`).
 *
 *   platform-mail-check --tenant <guid> --client-id <guid> --cert mail.crt --key mail.key \
 *     --sender noreply-<product>@qnsc.vn --to you@qnsc.vn \
 *     --denied-mailbox <the OTHER environment's mailbox> [--denied-mailbox <another product's mailbox>] \
 *     [--allowed-role <application role the app legitimately holds> ...]
 *
 * Exit: 0 every check passed; 1 a check failed; 2 usage; 3 nothing failed but the scope was not proven (no denied mailbox, which the CLI refuses
 * to run without).
 */
const USAGE =
  'usage: platform-mail-check --tenant <guid> --client-id <guid> --cert <mail.crt> --key <mail.key> ' +
  '--sender <mailbox> --to <address> --denied-mailbox <mailbox> [--denied-mailbox <mailbox> ...] [--allowed-role <role> ...]';

function usage(message: string): never {
  process.stderr.write(`${message}\n${USAGE}\n`);
  process.exit(2);
}

/** The authority and the Graph endpoint are overridable ONLY for a local fake Microsoft, and then only over https: the token travels there. */
function https(name: string, value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (!/^https:\/\//i.test(value)) usage(`--${name} must be an https:// URL`);
  return value;
}

async function main(): Promise<number> {
  let values: {
    tenant?: string;
    'client-id'?: string;
    cert?: string;
    key?: string;
    sender?: string;
    to?: string;
    'denied-mailbox'?: string[];
    'allowed-role'?: string[];
    authority?: string;
    'graph-api'?: string;
  };
  try {
    values = parseArgs({
      options: {
        tenant: { type: 'string' },
        'client-id': { type: 'string' },
        cert: { type: 'string' },
        key: { type: 'string' },
        sender: { type: 'string' },
        to: { type: 'string' },
        'denied-mailbox': { type: 'string', multiple: true },
        'allowed-role': { type: 'string', multiple: true },
        authority: { type: 'string' },
        'graph-api': { type: 'string' },
      },
    }).values;
  } catch (error) {
    return usage((error as Error).message);
  }
  for (const required of ['tenant', 'client-id', 'cert', 'key', 'sender', 'to'] as const) {
    if (!values[required]) usage(`--${required} is required`);
  }
  if (!values['denied-mailbox'] || values['denied-mailbox'].length === 0) {
    usage(
      "--denied-mailbox is required: without a refused send the scope is not proven. Give the OTHER environment's mailbox (and another product's)",
    );
  }
  const read = (flag: 'key' | 'cert'): string => {
    try {
      return readFileSync(values[flag]!, 'utf8');
    } catch (error) {
      // The path is the user's own argument, so it may be named; the file's content never is.
      return usage(
        `--${flag}: cannot read ${values[flag]!} (${(error as NodeJS.ErrnoException).code ?? 'error'})`,
      );
    }
  };
  const pem = `${read('key')}\n${read('cert')}`;
  return runGraphCheck(
    {
      tenantId: values.tenant!,
      clientId: values['client-id']!,
      pem,
      sender: values.sender!,
      to: values.to!,
      deniedMailboxes: values['denied-mailbox'],
      allowedRoles: values['allowed-role'],
      authorityHost: https('authority', values.authority),
      graphBaseUrl: https('graph-api', values['graph-api']),
    },
    { stdout: (line) => process.stdout.write(`${line}\n`) },
  );
}

main()
  .then((code) => {
    process.exitCode = code;
    // Exit once the output is flushed rather than waiting for idle keep-alive sockets to time out.
    process.stderr.write('', () => process.stdout.write('', () => process.exit(code)));
  })
  .catch((error: unknown) => {
    // An unexpected failure is still one line, and never the error's own text (it can quote a request).
    process.stderr.write(
      `platform-mail-check: failed (${error instanceof Error ? error.name : 'Error'})\n`,
    );
    process.exit(1);
  });
