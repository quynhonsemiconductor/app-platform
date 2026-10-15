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
 * Plain objects, no dependency on eslint itself.
 */
export interface LoggingLintOptions {
  /** Globs where `console` is allowed (CI tooling that is not app code, e.g. `scripts/report-flaky-e2e.mjs`). */
  consoleAllowedIn?: string[];
  /** Globs where `NestFactory.create*` is allowed (default: tests). */
  nestFactoryAllowedIn?: string[];
}

/** `NestFactory.create*(...)`, and any other use of the name through a namespace import (`core.NestFactory`) or a destructure. */
const NEST_FACTORY_SELECTORS = [
  "CallExpression[callee.object.name='NestFactory'][callee.property.name=/^(create|createApplicationContext|createMicroservice)$/]",
  "MemberExpression[property.name='NestFactory']",
  "VariableDeclarator[init.name='NestFactory']",
];

const BOOTSTRAP_MESSAGE =
  'Do not bootstrap Nest by hand: use createHttpApp / createWorkerApp from @quynhonsemiconductor/platform-runtime/bootstrap. They install the shared pino logger (a hand-written bootstrap logs Nest text, not JSON), OpenTelemetry, graceful shutdown and the fatal handler.';
const PINO_MESSAGE =
  "Do not build a pino logger in app code: inject Nest's Logger (it is the shared pino logger), or use createScriptLogger from @quynhonsemiconductor/observability/script-logger in a script. A second configuration drops the redaction, the field contract and the trace ids.";

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
        'no-restricted-syntax': [
          'error',
          ...NEST_FACTORY_SELECTORS.map((selector) => ({ selector, message: BOOTSTRAP_MESSAGE })),
        ],
        // The import itself, which catches an ALIAS (`import { NestFactory as NF }`) that no call-site selector can see; and the raw pino
        // constructors, so app code logs through the injected Nest logger and scripts through `createScriptLogger` (one configuration).
        'no-restricted-imports': [
          'error',
          {
            paths: [
              { name: '@nestjs/core', importNames: ['NestFactory'], message: BOOTSTRAP_MESSAGE },
              { name: 'pino', message: PINO_MESSAGE },
              { name: 'pino-http', message: PINO_MESSAGE },
            ],
          },
        ],
      },
    },
  ];
}
