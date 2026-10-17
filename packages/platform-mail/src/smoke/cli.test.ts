import { execFile } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { FakeSmtpServer } from '../__helpers__/smtp-server';

/**
 * `platform-mail-smoke` as a deploy step runs it: the BUILT file, in a fresh process, with a real
 * exit code. A TypeScript test runner cannot prove that the `bin` entry exists, starts with a
 * shebang, wires the process, and exits with what `runSmoke` returned, so this runs against `dist/`
 * (the CI test job builds first). Without a build it skips locally; on CI a missing build fails.
 *
 * The Graph outcomes are tested in `smoke.test.ts` against a local server; here the transport is the
 * non-production `smtp` one against a fake SMTP server, which needs no credentials.
 */
const root = join(import.meta.dirname, '..', '..');
const bin = join(root, 'dist', 'smoke', 'cli.js');
const built = existsSync(bin);
const run = promisify(execFile);

async function smokeCli(env: Record<string, string>) {
  try {
    const { stdout, stderr } = await run(process.execPath, [bin], {
      env: { PATH: process.env['PATH'] ?? '', ...env },
      timeout: 30_000,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failed.code ?? -1, stdout: failed.stdout ?? '', stderr: failed.stderr ?? '' };
  }
}

describe('platform-mail-smoke (the built bin)', () => {
  it.runIf(Boolean(process.env['CI']))('is built when running on CI', () => {
    expect(built).toBe(true);
  });

  describe.skipIf(!built)('in a fresh process', () => {
    it('is declared as the package bin, and starts with a node shebang', () => {
      const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
        bin: Record<string, string>;
        files: string[];
      };
      expect(pkg.bin).toEqual({
        'platform-mail-smoke': 'dist/smoke/cli.js',
        'platform-mail-check': 'dist/check/cli.js',
      });
      expect(pkg.files).toContain('dist');
      expect(readFileSync(bin, 'utf8').startsWith('#!/usr/bin/env node\n')).toBe(true);
      expect(statSync(bin).isFile()).toBe(true);
    });

    it('sends one message through smtp outside production, exits 0, and prints one OK line', async () => {
      const smtp = new FakeSmtpServer();
      await smtp.start();
      try {
        const result = await smokeCli({
          NODE_ENV: 'development',
          MAIL_TRANSPORT: 'smtp',
          MAIL_SMTP_HOST: '127.0.0.1',
          MAIL_SMTP_PORT: String(smtp.port),
          MAIL_SMOKE_TO: 'ops@qnsc.vn',
          SERVICE_VERSION: '2.3.4',
        });

        expect(result.code).toBe(0);
        expect(result.stdout).toMatch(/^platform-mail-smoke: OK transport=smtp id=\S+\n$/);
        expect(result.stderr).toBe('');
        expect(smtp.received).toHaveLength(1);
        expect(smtp.received[0]?.parsed.subject).toMatch(
          /^\[smoke\] platform-mail 2\.3\.4 \d{4}-\d{2}-\d{2}T[\d:.]+Z$/,
        );
        expect(smtp.received[0]?.rcptTo).toEqual(['ops@qnsc.vn']);
      } finally {
        await smtp.stop();
      }
    });

    it('refuses smtp when NODE_ENV=production: exit 2, nothing sent', async () => {
      const smtp = new FakeSmtpServer();
      await smtp.start();
      try {
        const result = await smokeCli({
          NODE_ENV: 'production',
          MAIL_TRANSPORT: 'smtp',
          MAIL_SMTP_HOST: '127.0.0.1',
          MAIL_SMTP_PORT: String(smtp.port),
          MAIL_SMOKE_TO: 'ops@qnsc.vn',
        });

        expect(result.code).toBe(2);
        expect(result.stdout).toBe('');
        expect(result.stderr).toMatch(
          /FAILED code=config MAIL_TRANSPORT=smtp is refused when NODE_ENV=production/,
        );
        expect(smtp.received).toHaveLength(0);
      } finally {
        await smtp.stop();
      }
    });

    it.each([
      ['a recipient outside @qnsc.vn', { MAIL_SMOKE_TO: 'customer@gmail.com' }],
      ['no recipient', {}],
    ])('refuses %s: exit 2, nothing sent', async (_label, extra) => {
      const smtp = new FakeSmtpServer();
      await smtp.start();
      try {
        const result = await smokeCli({
          NODE_ENV: 'development',
          MAIL_TRANSPORT: 'smtp',
          MAIL_SMTP_HOST: '127.0.0.1',
          MAIL_SMTP_PORT: String(smtp.port),
          ...extra,
        });

        expect(result.code).toBe(2);
        expect(result.stderr).toMatch(/^platform-mail-smoke: FAILED code=config MAIL_SMOKE_TO/);
        expect(result.stderr).not.toContain('gmail.com');
        expect(smtp.received).toHaveLength(0);
      } finally {
        await smtp.stop();
      }
    });

    it('exits 1 when the provider cannot be reached, and prints only the code', async () => {
      const smtp = new FakeSmtpServer();
      await smtp.start();
      const port = smtp.port;
      await smtp.stop(); // nothing is listening any more
      const result = await smokeCli({
        NODE_ENV: 'development',
        MAIL_TRANSPORT: 'smtp',
        MAIL_SMTP_HOST: '127.0.0.1',
        MAIL_SMTP_PORT: String(port),
        MAIL_SMOKE_TO: 'ops@qnsc.vn',
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toBe('platform-mail-smoke: FAILED code=network\n');
    });

    it('exits 2 and names the variable when the Graph configuration is incomplete', async () => {
      const result = await smokeCli({
        NODE_ENV: 'production',
        MAIL_TRANSPORT: 'graph',
        MAIL_SMOKE_TO: 'ops@qnsc.vn',
        AZURE_CLIENT_SECRET: 'must-never-be-printed',
      });

      expect(result.code).toBe(2);
      expect(result.stderr).toMatch(/MAIL_GRAPH_SENDER is required/);
      expect(result.stdout + result.stderr).not.toContain('must-never-be-printed');
    });
  });
});
