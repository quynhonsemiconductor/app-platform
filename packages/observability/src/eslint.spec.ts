import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';
import { loggingLintConfig } from './eslint';

async function lint(code: string, filePath: string, options = {}) {
  const eslint = new ESLint({
    overrideConfigFile: true,
    overrideConfig: loggingLintConfig(options) as never,
  });
  const [result] = await eslint.lintText(code, { filePath });
  return result!.messages.map((m) => `${m.ruleId}: ${m.message.slice(0, 40)}`);
}

describe('loggingLintConfig', () => {
  it('forbids console.* in app code', async () => {
    expect(await lint("console.log('x');", 'apps/api/src/a.ts')).toEqual([
      expect.stringContaining('no-console'),
    ]);
  });

  it('allows console where explicitly exempted (CI tooling)', async () => {
    expect(
      await lint("console.log('x');", 'scripts/report-flaky-e2e.mjs', {
        consoleAllowedIn: ['scripts/report-flaky-e2e.mjs'],
      }),
    ).toEqual([]);
  });

  it('forbids a hand-written Nest bootstrap, naming the helpers', async () => {
    const msgs = await lint('NestFactory.createApplicationContext(M);', 'apps/worker/src/main.ts');
    expect(msgs).toEqual([expect.stringContaining('no-restricted-syntax')]);
    expect((await lint('NestFactory.create(M, adapter);', 'apps/api/src/main.ts')).length).toBe(1);
  });

  it('allows NestFactory in tests, and Nest’s Logger everywhere', async () => {
    expect(await lint('NestFactory.create(M);', 'apps/api/src/x.spec.ts')).toEqual([]);
    expect(await lint("new Logger('Ctx').log('x');", 'apps/api/src/svc.ts')).toEqual([]);
  });
});
