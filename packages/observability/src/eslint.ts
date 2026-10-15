/**
 * `@quynhonsemiconductor/observability/eslint`: the lint rules that keep "one logger per runtime" true.
 *
 *   // eslint.config.mjs
 *   import { loggingLintConfig } from '@quynhonsemiconductor/observability/eslint';
 *   export default [ ...yourConfig, ...loggingLintConfig() ];
 *
 *  - `no-console`: Node app code, the migrator and the ops scripts log through the shared pino logger (`createScriptLogger` outside Nest).
 *    A human-facing report is OUTPUT, not a log: write it with `process.stdout.write`.
 *  - `NestFactory.create*` is forbidden outside the shared bootstrap (`createHttpApp` / `createWorkerApp`, platform-runtime). A hand-written
 *    bootstrap is how a worker ended up building the pino logger and never installing it, so none of its lines was JSON.
 *
 * Nest's own `new Logger(context)` stays allowed: it delegates to whatever logger the bootstrap installed, which is pino.
 *
 * Plain objects, no dependency on eslint itself. The restricted-imports rule is `@typescript-eslint/no-restricted-imports`, so the consumer's config
 * must register the `typescript-eslint` plugin (any Nest product's already does).
 */
export interface LoggingLintOptions {
  /** Globs where `console` is allowed (CI tooling that is not app code, e.g. `scripts/report-flaky-e2e.mjs`). */
  consoleAllowedIn?: string[];
  /** Globs where `NestFactory.create*` is allowed (default: tests). */
  nestFactoryAllowedIn?: string[];
}

/** `NestFactory.create*(...)`, and every other way to get hold of the name: a namespace import, a destructure, `{ NestFactory: F } = await import()`. */
const NEST_FACTORY_SELECTORS = [
  "CallExpression[callee.object.name='NestFactory'][callee.property.name=/^(create|createApplicationContext|createMicroservice)$/]",
  "MemberExpression[property.name='NestFactory']",
  "VariableDeclarator[init.name='NestFactory']",
  // `const { NestFactory: F } = await import('@nestjs/core')` / `require('@nestjs/core')`: the key is named even when the binding is renamed.
  "Property[key.name='NestFactory']",
];

/** `require('pino')` and `import('pino')`: the static `import` is covered by the restricted-imports rule, these two are not imports to ESLint. */
const PINO_SELECTORS = [
  "CallExpression[callee.name='require'][arguments.0.value=/^pino(-http)?$/]",
  'ImportExpression[source.value=/^pino(-http)?$/]',
];

const BOOTSTRAP_MESSAGE =
  'Do not bootstrap Nest by hand: use createHttpApp / createWorkerApp from @quynhonsemiconductor/platform-runtime/bootstrap. They install the shared pino logger (a hand-written bootstrap logs Nest text, not JSON), OpenTelemetry, graceful shutdown and the fatal handler.';
const PINO_MESSAGE =
  "Do not build a pino logger in app code: inject Nest's Logger (it is the shared pino logger), or use createScriptLogger from @quynhonsemiconductor/observability/script-logger in a script. A second configuration drops the redaction, the field contract and the trace ids.";

/**
 * The `no-restricted-syntax` entries of the preset, exported so a consumer that has rules of its own can MERGE them.
 *
 * ESLint flat config does not merge rule options: the LAST config that sets `no-restricted-syntax` (or `no-restricted-imports`) replaces
 * the earlier one wholesale. A product that sets its own after this preset silently loses these checks, and one that sets its own before
 * it loses its own. Spread these into yours instead:
 *
 *   'no-restricted-syntax': ['error', ...myEntries, ...LOGGING_RESTRICTED_SYNTAX],
 */
export const LOGGING_RESTRICTED_SYNTAX: ReadonlyArray<{ selector: string; message: string }> = [
  ...NEST_FACTORY_SELECTORS.map((selector) => ({ selector, message: BOOTSTRAP_MESSAGE })),
  ...PINO_SELECTORS.map((selector) => ({ selector, message: PINO_MESSAGE })),
];

/**
 * The `paths` of the preset's restricted-imports rule (`@typescript-eslint/no-restricted-imports`, so `import type { Logger } from 'pino'`,
 * which creates no logger and is erased, is allowed). Exported to merge into a consumer's own rule; see {@link LOGGING_RESTRICTED_SYNTAX}.
 */
export const LOGGING_RESTRICTED_IMPORT_PATHS: ReadonlyArray<{
  name: string;
  importNames?: string[];
  message: string;
  allowTypeImports: boolean;
}> = [
  {
    name: '@nestjs/core',
    importNames: ['NestFactory'],
    message: BOOTSTRAP_MESSAGE,
    allowTypeImports: true,
  },
  { name: 'pino', message: PINO_MESSAGE, allowTypeImports: true },
  { name: 'pino-http', message: PINO_MESSAGE, allowTypeImports: true },
];

export function loggingLintConfig(options: LoggingLintOptions = {}): object[] {
  const consoleAllowed = options.consoleAllowedIn ?? [];
  const nestFactoryAllowed = options.nestFactoryAllowedIn ?? [
    '**/*.spec.ts',
    '**/*.test.ts',
    '**/*.e2e-spec.ts',
    '**/test/**',
    '**/tests/**',
  ];
  return [
    {
      name: 'qnsc/logging/no-console',
      files: ['**/*.ts', '**/*.mts', '**/*.cts', '**/*.js', '**/*.mjs', '**/*.cjs'],
      ignores: consoleAllowed,
      rules: { 'no-console': 'error' },
    },
    {
      name: 'qnsc/logging/one-bootstrap',
      files: ['**/*.ts', '**/*.mts', '**/*.cts'],
      ignores: nestFactoryAllowed,
      rules: {
        'no-restricted-syntax': ['error', ...LOGGING_RESTRICTED_SYNTAX],
        // The import itself, which catches an ALIAS (`import { NestFactory as NF }`) that no call-site selector can see, and the raw pino
        // constructors, so app code logs through the injected Nest logger and scripts through `createScriptLogger`. The TypeScript version
        // of the rule (provided by `typescript-eslint`, which every Nest product already uses) so a TYPE-only import stays allowed.
        'no-restricted-imports': 'off',
        '@typescript-eslint/no-restricted-imports': [
          'error',
          { paths: [...LOGGING_RESTRICTED_IMPORT_PATHS] },
        ],
      },
    },
  ];
}
