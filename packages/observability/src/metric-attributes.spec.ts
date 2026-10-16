/**
 * Metric ATTRIBUTE names, checked on what the SDK actually exports.
 *
 * Why: through OTLP -> Prometheus, a metric attribute called `job` is overwritten with `service.namespace/service.name` (and `instance` with
 * `service.instance.id`). `JobMetrics` used `job`, so every cron of a worker collapsed into ONE series, several writers hit that series at the same
 * timestamp (discarded as duplicates by Grafana), and no alert could name the job. Nothing failed, because the exporter and every unit test saw a
 * perfectly good attribute; only the Prometheus translation destroys it. This pins the names that translation would damage.
 *
 * The names a Prometheus backend reserves or rewrites: `job`, `instance` (from the resource), `le` (histogram buckets), `quantile`, `__*`.
 * Plus: two attribute keys that sanitise to the SAME Prometheus label (`a.b` and `a_b`) would collide.
 */
import { metrics } from '@opentelemetry/api';
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthMetrics, HttpMetrics, JobMetrics, QueueMetrics, SecurityMetrics } from './metrics';

const RESERVED = new Set(['job', 'instance', 'le', 'quantile', '__name__']);
const sanitise = (key: string): string => key.replace(/[^a-zA-Z0-9_]/g, '_');

/** Every attribute key on every exported data point, with the metric it was seen on. */
async function exportedKeys(drive: () => Promise<void> | void): Promise<Map<string, string[]>> {
  const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const reader = new PeriodicExportingMetricReader({
    exporter,
    exportIntervalMillis: 3_600_000,
  });
  const provider = new MeterProvider({ readers: [reader] });
  metrics.disable();
  metrics.setGlobalMeterProvider(provider);
  await drive();
  await provider.forceFlush();
  const seen = new Map<string, string[]>();
  for (const resourceMetrics of exporter.getMetrics()) {
    for (const scope of resourceMetrics.scopeMetrics) {
      for (const metric of scope.metrics) {
        for (const point of metric.dataPoints) {
          const keys = Object.keys(point.attributes);
          seen.set(metric.descriptor.name, [
            ...new Set([...(seen.get(metric.descriptor.name) ?? []), ...keys]),
          ]);
        }
      }
    }
  }
  await provider.shutdown();
  metrics.disable();
  return seen;
}

describe('metric attribute names survive the Prometheus translation', () => {
  let seen: Map<string, string[]>;

  beforeAll(async () => {
    seen = await exportedKeys(async () => {
      new HttpMetrics().record({
        route: '/x',
        method: 'GET',
        statusCode: 500,
        durationMs: 3,
        errorCode: 'BOOM',
      });
      const jobs = new JobMetrics();
      await jobs.time('nightly', () => Promise.resolve());
      await jobs.time('nightly', () => Promise.reject(new Error('x'))).catch(() => undefined);
      const queue = new QueueMetrics();
      queue.recordProcessed('outbox', 2);
      queue.recordFailure('outbox', 1);
      queue.recordLag('outbox', 4);
      new SecurityMetrics().recordFailOpen('rate_limit');
      new AuthMetrics().recordLogin('sso', 'failure');
    });
  });

  afterAll(() => metrics.disable());

  it('exports the instruments this test drives (so an empty export cannot pass it)', () => {
    for (const name of [
      'http.server.requests',
      'job.runs',
      'job.failures',
      'job.duration',
      'queue.processed',
    ]) {
      expect([...seen.keys()], `${name} was not exported`).toContain(name);
    }
  });

  it('no attribute is a name Prometheus reserves or rewrites', () => {
    const offenders = [...seen].flatMap(([metric, keys]) =>
      keys.filter((k) => RESERVED.has(k) || k.startsWith('__')).map((k) => `${metric}: ${k}`),
    );
    expect(offenders).toEqual([]);
  });

  it('no two attributes of one metric sanitise to the same Prometheus label', () => {
    const collisions = [...seen].flatMap(([metric, keys]) => {
      const bySanitised = new Map<string, string[]>();
      for (const k of keys)
        bySanitised.set(sanitise(k), [...(bySanitised.get(sanitise(k)) ?? []), k]);
      return [...bySanitised]
        .filter(([, ks]) => ks.length > 1)
        .map(([, ks]) => `${metric}: ${ks.join(' / ')}`);
    });
    expect(collisions).toEqual([]);
  });

  it('the job metrics carry the job as `job_name`', () => {
    expect(seen.get('job.runs')).toEqual(expect.arrayContaining(['job_name', 'outcome']));
    expect(seen.get('job.failures')).toEqual(['job_name']);
    expect(seen.get('job.duration')).toEqual(expect.arrayContaining(['job_name']));
  });
});
