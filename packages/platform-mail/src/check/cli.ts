#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { runGraphCheck } from './check';

/**
 * `platform-mail-check`: the owner's TOKEN / SEND / DENIED proof (see `check.ts`).
 *
 *   platform-mail-check --tenant <guid> --client-id <guid> --cert mail.crt --key mail.key \
 *     --sender noreply-<product>@qnsc.vn --to you@qnsc.vn --denied-mailbox someone-else@qnsc.vn
 */
const USAGE =
  'usage: platform-mail-check --tenant <guid> --client-id <guid> --cert <mail.crt> --key <mail.key> ' +
  '--sender <mailbox> --to <address> [--denied-mailbox <mailbox>]';

function main(): void {
  let values: Record<string, string | undefined>;
  try {
    values = parseArgs({
      options: {
        tenant: { type: 'string' },
        'client-id': { type: 'string' },
        cert: { type: 'string' },
        key: { type: 'string' },
        sender: { type: 'string' },
        to: { type: 'string' },
        'denied-mailbox': { type: 'string' },
        authority: { type: 'string' },
        'graph-api': { type: 'string' },
      },
    }).values as Record<string, string | undefined>;
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n${USAGE}\n`);
    process.exit(2);
  }
  for (const required of ['tenant', 'client-id', 'cert', 'key', 'sender', 'to']) {
    if (!values[required]) {
      process.stderr.write(`--${required} is required\n${USAGE}\n`);
      process.exit(2);
    }
  }
  const pem = readFileSync(values['key']!, 'utf8') + '\n' + readFileSync(values['cert']!, 'utf8');
  void runGraphCheck(
    {
      tenantId: values['tenant']!,
      clientId: values['client-id']!,
      pem,
      sender: values['sender']!,
      to: values['to']!,
      deniedMailbox: values['denied-mailbox'],
      authorityHost: values['authority'],
      graphBaseUrl: values['graph-api'],
    },
    { stdout: (line) => process.stdout.write(`${line}\n`) },
  ).then((code) => {
    process.exitCode = code;
    process.stderr.write('', () => process.stdout.write('', () => process.exit(code)));
  });
}

main();
