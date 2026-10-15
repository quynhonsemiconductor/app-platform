/**
 * `@quynhonsemiconductor/observability/testing`: the LOG CONTRACT as an executable check, for a product to run in CI.
 *
 * A product boots its real API and worker modules through the shared bootstrap (platform-runtime `prepareHttpApp` / `prepareWorkerApp`)
 * with the capture below, and `runLoggingConformance` emits a line of each kind and asserts that EVERY captured line, including the
 * ones written during boot, is a JSON object carrying every contract field. That is the failure it exists for: a process that built
 * the pino logger but never installed it writes `[Nest] 7 - ... LOG [Shutdown] ...`, which no log pipeline can parse, and nothing
 * in the product's tests noticed.
 *
 * No test-framework dependency: it throws, so it works under vitest, jest or `node --test`.
 */
import { Writable } from 'node:stream';

/** Fields every line of every runtime carries (README: "Log field contract"). */
export const REQUIRED_FIELDS = ['level', 'time', 'msg', 'service', 'env', 'version'] as const;
export const LEVEL_LABELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;
const ISO_UTC = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/;

export interface LogCapture {
  /** Hand this to the shared bootstrap as `logStream`: the shared logger writes here. */
  stream: Writable;
  /** Also collect whatever is written with process.stdout.write / process.stderr.write (Nest's default text logger, console.*). */
  install(): void;
  restore(): void;
  /** Every captured non-empty line, in order. */
  lines(): string[];
}

export function createLogCapture(): LogCapture {
  const collected: string[] = [];
  const push = (chunk: unknown): void => {
    for (const line of String(chunk).split('\n')) if (line.trim() !== '') collected.push(line);
  };
  const stream = new Writable({
    write(chunk, _enc, cb) {
      push(chunk);
      cb();
    },
  });
  let restore: (() => void) | undefined;
  return {
    stream,
    install() {
      if (restore) return;
      const origOut = process.stdout.write;
      const origErr = process.stderr.write;
      process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
        push(chunk);
        const cb = rest.find((r) => typeof r === 'function') as (() => void) | undefined;
        cb?.();
        return true;
      }) as typeof process.stdout.write;
      process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => {
        push(chunk);
        const cb = rest.find((r) => typeof r === 'function') as (() => void) | undefined;
        cb?.();
        return true;
      }) as typeof process.stderr.write;
      restore = () => {
        process.stdout.write = origOut;
        process.stderr.write = origErr;
        restore = undefined;
      };
    },
    restore() {
      restore?.();
    },
    lines: () => [...collected],
  };
}

export interface ContractExpectations {
  /** Exact `service` (or a pattern). */
  service?: string | RegExp;
  /** Exact `env`: pass the DEPLOYMENT environment you set, so `production` leaking from NODE_ENV is caught. */
  env?: string;
  version?: string | RegExp;
}

/** Throws, listing every offending line, unless every line is a JSON object satisfying the contract. */
export function assertLogContract(
  lines: readonly string[],
  expected: ContractExpectations = {},
): void {
  const problems: string[] = [];
  if (lines.length === 0)
    problems.push(
      'no log line was captured at all: the logger is not writing where the capture listens',
    );
  lines.forEach((raw, i) => {
    const where = `line ${i + 1}`;
    let line: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
        throw new Error('not an object');
      line = parsed as Record<string, unknown>;
    } catch {
      problems.push(`${where} is NOT JSON: ${raw.slice(0, 160)}`);
      return;
    }
    for (const field of REQUIRED_FIELDS) {
      if (line[field] === undefined || line[field] === null || line[field] === '')
        problems.push(`${where} is missing \`${field}\`: ${raw.slice(0, 160)}`);
    }
    if (
      typeof line['level'] === 'string' &&
      !(LEVEL_LABELS as readonly string[]).includes(line['level'])
    )
      problems.push(
        `${where}: level must be a label (${LEVEL_LABELS.join('|')}), got ${JSON.stringify(line['level'])}`,
      );
    if (typeof line['level'] === 'number')
      problems.push(`${where}: level is numeric (${line['level']}); the contract is a label`);
    if (typeof line['time'] !== 'string' || !ISO_UTC.test(line['time']))
      problems.push(`${where}: time must be ISO-8601 UTC, got ${JSON.stringify(line['time'])}`);
    if (
      line['err'] !== undefined &&
      (typeof line['err'] !== 'object' ||
        (line['err'] as Record<string, unknown>)['message'] === undefined)
    )
      problems.push(
        `${where}: err must be a serialised error {type,message,stack}, got ${JSON.stringify(line['err'])}`,
      );
    const match = (actual: unknown, want: string | RegExp | undefined, name: string): void => {
      if (want === undefined) return;
      const ok =
        typeof want === 'string'
          ? actual === want
          : typeof actual === 'string' && want.test(actual);
      if (!ok)
        problems.push(`${where}: ${name} is ${JSON.stringify(actual)}, expected ${String(want)}`);
    };
    match(line['service'], expected.service, 'service');
    match(line['env'], expected.env, 'env');
    match(line['version'], expected.version, 'version');
  });
  if (problems.length > 0)
    throw new Error(
      `Log contract violated (${problems.length}):\n  ${problems.slice(0, 20).join('\n  ')}${problems.length > 20 ? `\n  ... and ${problems.length - 20} more` : ''}`,
    );
}

/** Throws if `secret` appears anywhere in the captured output. */
export function assertRedacted(lines: readonly string[], secret: string): void {
  const leaked = lines.filter((l) => l.includes(secret));
  if (leaked.length > 0)
    throw new Error(
      `A credential reached the log output unredacted in ${leaked.length} line(s): ${leaked[0]!.slice(0, 160)}`,
    );
}

export interface BootedApp {
  /** The Nest application / context, to emit lines through. */
  app: { get: (token: never) => unknown; close: () => Promise<void> };
  /** For an HTTP app: perform one request, so a request-bound line exists. Optional. */
  request?: () => Promise<void>;
}

export interface LoggingConformanceOptions {
  /** Boot the REAL module through the shared bootstrap, writing to `logStream`. */
  boot: (logStream: Writable) => Promise<BootedApp>;
  /** What the process environment says (set DEPLOYMENT_ENV etc. before calling); checked on every line. */
  expected: ContractExpectations;
}

export const CONFORMANCE_SECRET = 'conformance-secret-token-do-not-log';

/**
 * Boot, emit one line of each kind (info, an Error, a credential-bearing object), shut down, and assert every captured line, boot
 * and shutdown included, against the contract.
 */
export async function runLoggingConformance(options: LoggingConformanceOptions): Promise<string[]> {
  const capture = createLogCapture();
  capture.install();
  let failure: unknown;
  try {
    const { Logger: NestLogger, ConsoleLogger } = await import('@nestjs/common');
    const { Logger } = await import('nestjs-pino');
    // Nest's logger override is PROCESS-GLOBAL: a logger installed by an earlier boot in this process would otherwise swallow the lines of an
    // app that never installed one, and the check would see "no output" instead of the text lines it exists to catch.
    NestLogger.overrideLogger(new ConsoleLogger());
    // nestjs-pino keeps ONE out-of-context pino logger per process, created by the first LoggingModule and reused by every later one. A second
    // boot in the same process (an API test, then a worker test) would write to the FIRST boot's stream and capture nothing.
    try {
      const { __resetOutOfContextForTests } = (await import('nestjs-pino/PinoLogger')) as {
        __resetOutOfContextForTests?: () => void;
      };
      __resetOutOfContextForTests?.();
    } catch {
      /* a nestjs-pino without the reset hook: a single boot per process still works */
    }
    const booted = await options.boot(capture.stream);
    new NestLogger('Conformance').log('conformance: a Nest Logger line');
    const pinoLogger = booted.app.get(Logger as never) as InstanceType<typeof Logger>;
    pinoLogger.log('conformance: an injected Logger line', 'Conformance');
    pinoLogger.error(
      { msg: 'conformance: an error', err: new Error('conformance boom') },
      'Conformance',
    );
    // The realistic leak: an SDK error that carries the request it made (AWS / GitHub clients do).
    pinoLogger.error(
      {
        msg: 'conformance: a credential',
        err: Object.assign(new Error('sdk call failed'), {
          config: { headers: { authorization: `Bearer ${CONFORMANCE_SECRET}` } },
        }),
      },
      'Conformance',
    );
    await booted.request?.();
    await booted.app.close();
  } catch (error) {
    failure = error;
  } finally {
    capture.restore();
  }
  const lines = capture.lines();
  // A boot that threw before anything was logged: the boot error IS the finding; "no log line" would only hide it.
  if (failure && lines.length === 0) throw failure;
  // The lines first: a process that never installed the logger fails here with the offending text lines, which is far more useful than the
  // secondary error (no Logger to inject) that followed from it.
  assertLogContract(lines, options.expected);
  if (failure) throw failure;
  assertRedacted(lines, CONFORMANCE_SECRET);
  return lines;
}
