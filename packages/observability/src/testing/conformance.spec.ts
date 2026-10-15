import { describe, expect, it } from 'vitest';
import { assertLogContract, assertRedacted, createLogCapture } from './index';

const good = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    level: 'info',
    time: '2026-10-15T07:00:00.000Z',
    msg: 'hello',
    service: 'rova-worker',
    env: 'develop',
    version: 'sha-abc',
    ...over,
  });

describe('assertLogContract', () => {
  it('accepts a line carrying every contract field', () => {
    expect(() =>
      assertLogContract([good()], { service: 'rova-worker', env: 'develop' }),
    ).not.toThrow();
  });

  // The failure the kit exists for: a process that never installed the pino logger.
  it('FAILS on Nest’s default text logger line', () => {
    const text =
      '[Nest] 7  - 10/15/2026, 1:52:00 PM     LOG [Shutdown] Received SIGTERM; shutting down';
    expect(() => assertLogContract([good(), text])).toThrow(/line 2 is NOT JSON/);
  });

  it('FAILS on a multi-line text block, naming every offending line', () => {
    expect(() => assertLogContract([good(), 'Error: boom', '    at foo (x.js:1:1)'])).toThrow(
      /line 2 is NOT JSON[\s\S]*line 3 is NOT JSON/,
    );
  });

  it.each(['level', 'time', 'msg', 'service', 'env', 'version'])(
    'FAILS when `%s` is missing',
    (field) => {
      expect(() => assertLogContract([good({ [field]: undefined })])).toThrow(
        new RegExp(`missing \`${field}\``),
      );
    },
  );

  it('FAILS on pino’s numeric level and epoch time', () => {
    expect(() => assertLogContract([good({ level: 30 })])).toThrow(/numeric/);
    expect(() => assertLogContract([good({ time: 1792043678891 })])).toThrow(/ISO-8601/);
  });

  it('FAILS when env is NODE_ENV’s production instead of the deployment environment', () => {
    expect(() => assertLogContract([good({ env: 'production' })], { env: 'develop' })).toThrow(
      /env is "production", expected develop/,
    );
  });

  it('FAILS on an unserialised error', () => {
    expect(() => assertLogContract([good({ err: {} })])).toThrow(/err must be a serialised error/);
  });

  it('FAILS when nothing was captured: a silent logger is not conformant', () => {
    expect(() => assertLogContract([])).toThrow(/no log line was captured/);
  });
});

describe('assertRedacted', () => {
  it('fails when the secret appears', () => {
    expect(() => assertRedacted([good({ msg: 'token=S3CRET' })], 'S3CRET')).toThrow(/unredacted/);
    expect(() => assertRedacted([good()], 'S3CRET')).not.toThrow();
  });
});

describe('createLogCapture', () => {
  it('collects what is written to the stream AND to process.stdout.write, then restores it', () => {
    const capture = createLogCapture();
    const original = process.stdout.write;
    capture.install();
    capture.stream.write(`${good()}\n`);
    process.stdout.write('[Nest] 1 - text line\n');
    capture.restore();
    expect(process.stdout.write).toBe(original);
    expect(capture.lines()).toHaveLength(2);
    expect(capture.lines()[1]).toContain('[Nest]');
  });
});
