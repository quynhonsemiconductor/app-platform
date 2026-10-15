import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';
import tseslint from 'typescript-eslint';
import {
  LOGGING_RESTRICTED_IMPORT_PATHS,
  LOGGING_RESTRICTED_SYNTAX,
  loggingLintConfig,
} from './eslint';

async function lint(code: string, filePath: string, options = {}) {
  const eslint = new ESLint({
    overrideConfigFile: true,
    // The consumer's config registers the typescript-eslint parser and plugin (every Nest product does); the preset relies on it.
    overrideConfig: [tseslint.configs.base, ...loggingLintConfig(options)] as never,
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

  it.each([
    ["import { NestFactory as NF } from '@nestjs/core';\nvoid NF;", 'an aliased import'],
    ["import * as core from '@nestjs/core';\ncore.NestFactory.create(M);", 'a namespace import'],
    ['const { create } = NestFactory;\nvoid create;', 'a destructure'],
  ])('catches what a call-site selector misses: %#', async (code, _what) => {
    const msgs = await lint(code, 'apps/api/src/main.ts');
    expect(msgs.length).toBeGreaterThan(0);
    expect(msgs.join('\n')).toMatch(/no-restricted-(syntax|imports)/);
  });

  it('forbids building pino in app code, and allows it in tests', async () => {
    for (const mod of ['pino', 'pino-http']) {
      const msgs = await lint(`import p from '${mod}';\nvoid p;`, 'apps/api/src/logger.ts');
      expect(msgs).toEqual([expect.stringContaining('no-restricted-imports')]);
    }
    expect(await lint("import p from 'pino';\nvoid p;", 'apps/api/src/x.spec.ts')).toEqual([]);
  });

  it('catches a renamed destructure of a dynamic import, and require()/import() of pino', async () => {
    const cases = [
      "async function f() { const { NestFactory: F } = await import('@nestjs/core'); void F; }",
      "const { NestFactory: F } = require('@nestjs/core');\nvoid F;",
      "const p = require('pino');\nvoid p;",
      "async function f() { return import('pino-http'); }",
    ];
    for (const code of cases) {
      const msgs = await lint(code, 'apps/api/src/x.ts');
      expect(msgs, code).not.toEqual([]);
      expect(msgs.join('\n'), code).toMatch(/no-restricted-(syntax|imports)/);
    }
  });

  it('does NOT flag a type-only import of pino (erased, creates no logger)', async () => {
    expect(
      await lint(
        "import type { Logger } from 'pino';\nlet l: Logger | undefined;\nvoid l;",
        'apps/api/src/a.ts',
      ),
    ).toEqual([]);
    expect(
      await lint(
        "import { type Logger } from 'pino';\nlet l: Logger | undefined;\nvoid l;",
        'apps/api/src/a.ts',
      ),
    ).toEqual([]);
  });

  it('exports the selectors and import paths so a consumer can MERGE them (flat config replaces a rule wholesale)', async () => {
    expect(LOGGING_RESTRICTED_SYNTAX.length).toBeGreaterThan(3);
    expect(LOGGING_RESTRICTED_IMPORT_PATHS.map((p) => p.name)).toEqual([
      '@nestjs/core',
      'pino',
      'pino-http',
    ]);
    // A consumer rule set AFTER the preset replaces it: the preset's check is lost...
    const replaced = new ESLint({
      overrideConfigFile: true,
      overrideConfig: [
        tseslint.configs.base,
        ...loggingLintConfig(),
        {
          rules: {
            'no-restricted-syntax': ['error', { selector: 'DebuggerStatement', message: 'no' }],
          },
        },
      ] as never,
    });
    const [lost] = await replaced.lintText('NestFactory.create(M);', {
      filePath: 'apps/api/src/m.ts',
    });
    expect(lost?.messages.map((m) => m.ruleId)).not.toContain('no-restricted-syntax');
    // ...and merging the exported entries keeps both.
    const merged = new ESLint({
      overrideConfigFile: true,
      overrideConfig: [
        tseslint.configs.base,
        ...loggingLintConfig(),
        {
          rules: {
            'no-restricted-syntax': [
              'error',
              { selector: 'DebuggerStatement', message: 'no' },
              ...LOGGING_RESTRICTED_SYNTAX,
            ],
          },
        },
      ] as never,
    });
    const [kept] = await merged.lintText('debugger;\nNestFactory.create(M);', {
      filePath: 'apps/api/src/m.ts',
    });
    expect(kept?.messages.filter((m) => m.ruleId === 'no-restricted-syntax')).toHaveLength(2);
  });
});
