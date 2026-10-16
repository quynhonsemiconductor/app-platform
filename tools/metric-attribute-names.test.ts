/**
 * No package may record a metric with an attribute NAMED like a Prometheus-reserved label.
 *
 * Through OTLP -> Prometheus, `job` is overwritten with `service.namespace/service.name` and `instance` with `service.instance.id`; `le` and
 * `quantile` belong to histograms and summaries; `__*` is internal. A metric attribute with one of those names is silently replaced, which collapsed
 * every cron of a worker into ONE series (JobMetrics, until 0.6.0).
 *
 * `packages/observability/src/metric-attributes.spec.ts` proves this on what the SDK exports, but only for that package's recorders. The other
 * packages (platform-runtime, platform-http, platform-jobs, platform-mail, identity) create their own meters, so this reads their SOURCE: every
 * object literal passed to `.add(` / `.record(` / `.observe(` outside tests. It is a syntactic check, so a key built dynamically is not seen;
 * it exists to catch the mistake that was actually made.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..');
const RESERVED = ['job', 'instance', 'le', 'quantile'];

/** The reserved attribute keys in instrument calls of one source file. */
export function reservedAttributeKeys(source: string): string[] {
  const found: string[] = [];
  // `.add(1, { ... })`: the object literal inside the call's parentheses (no nested call between them).
  for (const call of source.matchAll(/\.(?:add|record|observe)\(([^()]*?)\{([^{}]*)\}/g)) {
    for (const key of (call[2] ?? '').matchAll(/(?:^|[,{\s])([A-Za-z_][\w]*)\s*(?=[:,}]|$)/g)) {
      const name = key[1] as string;
      if (RESERVED.includes(name) || name.startsWith('__')) found.push(name);
    }
  }
  return found;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    if (entry === 'node_modules' || entry === 'dist') return [];
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.ts$/.test(path) && !/(\.spec\.ts|\.test\.ts|\.d\.ts)$/.test(path) ? [path] : [];
  });
}

describe('reservedAttributeKeys', () => {
  it.each([
    ['counter.add(1, { job: name })', ['job']],
    ['counter.add(1, { job })', ['job']],
    ['h.record(3, { route, instance: id, outcome })', ['instance']],
    ["this.failures.add(0, {\n job: labelGuard.bound('job', 'job', job),\n })", ['job']],
    ["g.observe(1, { le: '5' })", ['le']],
    ["c.add(1, { __name__: 'x' })", ['__name__']],
  ])('finds the reserved key in %s', (source, expected) => {
    expect(reservedAttributeKeys(source)).toEqual(expected);
  });

  it.each([
    ['counter.add(1, { job_name: name })'],
    ['counter.add(1, { queue, outcome })'],
    ['set.add(job)'],
    ['const job = 1; other.add(job, { reason })'],
  ])('leaves %s alone', (source) => {
    expect(reservedAttributeKeys(source)).toEqual([]);
  });
});

describe('metric attribute names across the packages', () => {
  it('no package records an attribute named job, instance, le, quantile or __*', () => {
    const offenders = sourceFiles(join(ROOT, 'packages')).flatMap((file) =>
      reservedAttributeKeys(readFileSync(file, 'utf8')).map(
        (key) => `${relative(ROOT, file)}: ${key}`,
      ),
    );
    expect(offenders).toEqual([]);
  });
});
