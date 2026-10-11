#!/usr/bin/env node
import { runSmoke } from './smoke';

/**
 * `platform-mail-smoke`: the entry point a deploy step or a Kubernetes Job runs inside the product
 * image. All the logic is in `runSmoke`; this only wires the process.
 */
void runSmoke({
  env: process.env,
  stdout: (line) => process.stdout.write(`${line}\n`),
  stderr: (line) => process.stderr.write(`${line}\n`),
}).then((code) => {
  process.exitCode = code;
  // Exit once the output is flushed rather than waiting for idle keep-alive sockets to time out.
  process.stderr.write('', () => process.stdout.write('', () => process.exit(code)));
});
