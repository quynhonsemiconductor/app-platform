import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The SDK is stubbed: starting a real NodeSDK would install global
 * auto-instrumentation into the test process and try to reach a collector. What
 * matters here is the *policy* — when we start, what we name ourselves, what we
 * refuse to trace — not that OpenTelemetry works.
 */
const start = vi.fn();
const shutdown = vi.fn().mockResolvedValue(undefined);
const nodeSdkConstructor = vi.fn();

vi.mock('@opentelemetry/sdk-node', () => ({
  NodeSDK: class {
    constructor(config: unknown) {
      nodeSdkConstructor(config);
    }
    start = start;
    shutdown = shutdown;
  },
}));

import { AggregationType } from '@opentelemetry/sdk-metrics';
import { PROBE_PATHS } from './ignored-paths';
import {
  __ignoredRequestPaths,
  resetOtelForTesting,
  shutdownOtel,
  startOtel,
} from './otel.bootstrap';
// Imported for ONE assertion. `otel.bootstrap` cannot import `./metrics` — that module
// reaches `@nestjs/common`, and the bootstrap must not pull Nest in before
// `sdk.start()` — so the instrument name is a literal there. A spec has no such
// constraint, so this is where the literal and the canonical name are pinned together.
import { METRIC_NAMES } from './metrics';

const ORIGINAL_ENV = { ...process.env };

describe('startOtel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetOtelForTesting();
    process.env = { ...ORIGINAL_ENV };
    delete process.env['OTEL_ENABLED'];
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('does nothing unless OTEL_ENABLED is exactly "true"', () => {
    expect(startOtel({ defaultServiceName: 'svc' })).toBe(false);
    expect(start).not.toHaveBeenCalled();
  });

  it.each(['false', 'TRUE', '1', ''])('treats OTEL_ENABLED=%o as off', (value) => {
    // Only the literal "true" enables it — no truthiness surprises.
    process.env['OTEL_ENABLED'] = value;
    expect(startOtel({ defaultServiceName: 'svc' })).toBe(false);
  });

  it('starts when enabled', () => {
    process.env['OTEL_ENABLED'] = 'true';
    expect(startOtel({ defaultServiceName: 'svc' })).toBe(true);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('is idempotent — a second call does not double-register instrumentation', () => {
    process.env['OTEL_ENABLED'] = 'true';
    startOtel({ defaultServiceName: 'svc' });
    startOtel({ defaultServiceName: 'svc' });
    expect(start).toHaveBeenCalledTimes(1);
  });

  describe('service identity', () => {
    beforeEach(() => {
      process.env['OTEL_ENABLED'] = 'true';
    });

    it('falls back to the caller-supplied name', () => {
      startOtel({ defaultServiceName: 'rova-api' });
      expect(nodeSdkConstructor.mock.calls[0][0]).toMatchObject({ serviceName: 'rova-api' });
    });

    it('reads the env var the caller nominates, so worker and api can differ', () => {
      // A single task definition can host both processes; without a distinct var
      // they would report as the same service.
      process.env['OTEL_WORKER_SERVICE_NAME'] = 'rova-worker';
      startOtel({
        defaultServiceName: 'fallback',
        serviceNameEnvVar: 'OTEL_WORKER_SERVICE_NAME',
      });
      expect(nodeSdkConstructor.mock.calls[0][0]).toMatchObject({ serviceName: 'rova-worker' });
    });

    it('stamps namespace, version, environment and instance id on the resource', () => {
      process.env['SERVICE_VERSION'] = '1.4.2';
      process.env['NODE_ENV'] = 'production';
      startOtel({ defaultServiceName: 'svc' });

      const { resource } = nodeSdkConstructor.mock.calls[0][0] as {
        resource: { attributes: Record<string, unknown> };
      };
      expect(resource.attributes).toMatchObject({
        'service.name': 'svc',
        'service.version': '1.4.2',
        'deployment.environment.name': 'production',
        'service.namespace': 'qnsc',
      });
      // Per-task, so a trace can be pinned to one container.
      expect(resource.attributes['service.instance.id']).toEqual(expect.any(String));
    });

    // Regression guard. NODE_ENV is a runtime MODE, not a deployment identity, and
    // products deliberately pin it to "production" outside production — rova's
    // develop does, because `devLoginAllowed` is `nodeEnv !== 'production'` and a
    // public host must not expose passwordless dev-login. Deriving deployment
    // identity from it labelled every develop signal as production.
    it('takes the deployment environment from DEPLOYMENT_ENV, not NODE_ENV', () => {
      process.env['NODE_ENV'] = 'production'; // as rova's develop really runs
      process.env['DEPLOYMENT_ENV'] = 'develop';
      startOtel({ defaultServiceName: 'svc' });

      const { resource } = nodeSdkConstructor.mock.calls[0][0] as {
        resource: { attributes: Record<string, unknown> };
      };
      expect(resource.attributes['deployment.environment.name']).toBe('develop');
    });

    it('falls back to NODE_ENV when DEPLOYMENT_ENV is unset', () => {
      // Keeps a deployment that has not adopted DEPLOYMENT_ENV on its old behaviour
      // rather than reporting "unknown".
      process.env['NODE_ENV'] = 'production';
      delete process.env['DEPLOYMENT_ENV'];
      startOtel({ defaultServiceName: 'svc' });

      const { resource } = nodeSdkConstructor.mock.calls[0][0] as {
        resource: { attributes: Record<string, unknown> };
      };
      expect(resource.attributes['deployment.environment.name']).toBe('production');
    });

    // The same root cause reached sampling: `isProd` gated the DEFAULT ratio, so a
    // develop pinned to NODE_ENV=production silently sampled at the production 0.1
    // and dropped 90% of the traces it was collecting them for.
    it.each([
      ['develop', 'TraceIdRatioBased{1}'],
      ['production', 'TraceIdRatioBased{0.1}'],
    ])('defaults the sampling ratio from DEPLOYMENT_ENV=%s', (env, expected) => {
      process.env['NODE_ENV'] = 'production'; // identical in both deployments
      process.env['DEPLOYMENT_ENV'] = env;
      delete process.env['OTEL_SAMPLING_PROBABILITY'];
      startOtel({ defaultServiceName: 'svc' });

      const { sampler } = nodeSdkConstructor.mock.calls[0][0] as { sampler: unknown };
      expect(String(sampler)).toContain(expected);
    });
  });

  /**
   * The p99 alert on rova reported `10000`. That is not a latency — it is the largest
   * finite boundary of the OTel JS default explicit histogram, which `histogram_quantile`
   * clamps to, so a 12s request and a 180s request were the same number. Those requests
   * return 200 (the resilience presets budget 60s x 3 attempts), so the 5xx alert could
   * not see them either. Widening the buckets is opt-in, because it restates the
   * exported `_bucket` series and invalidates whatever was built on the old ones.
   */
  describe('httpDurationBoundaries', () => {
    beforeEach(() => {
      process.env['OTEL_ENABLED'] = 'true';
    });

    // `httpInstrumentationDuration: 'keep'` with no buckets is the old configuration exactly: nothing in `views`.
    it("adds no views key at all when the buckets are omitted and the instrumentation's duration is kept", () => {
      startOtel({ defaultServiceName: 'svc', httpInstrumentationDuration: 'keep' });

      const config = nodeSdkConstructor.mock.calls[0][0] as Record<string, unknown>;
      expect('views' in config).toBe(false);
    });

    it('registers a bucket view on http.server.duration with exactly the given boundaries, scoped to our meter', () => {
      const boundaries = [0, 100, 1_000, 10_000, 30_000, 60_000, 120_000, 300_000];
      startOtel({ defaultServiceName: 'svc', httpDurationBoundaries: boundaries });

      const { views } = nodeSdkConstructor.mock.calls[0][0] as { views: Record<string, unknown>[] };
      const buckets = views.filter(
        (v) =>
          (v['aggregation'] as { type: unknown }).type ===
          AggregationType.EXPLICIT_BUCKET_HISTOGRAM,
      );
      expect(buckets).toEqual([
        {
          meterName: 'qnsc',
          instrumentName: 'http.server.duration',
          aggregation: { type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM, options: { boundaries } },
        },
      ]);
    });

    it('with the instrumentation kept, the bucket view is the old unscoped one (it applies to both, as before)', () => {
      startOtel({
        defaultServiceName: 'svc',
        httpDurationBoundaries: [1, 2, 3],
        httpInstrumentationDuration: 'keep',
      });
      const { views } = nodeSdkConstructor.mock.calls[0][0] as { views: unknown[] };
      expect(views).toEqual([
        {
          instrumentName: 'http.server.duration',
          aggregation: {
            type: AggregationType.EXPLICIT_BUCKET_HISTOGRAM,
            options: { boundaries: [1, 2, 3] },
          },
        },
      ]);
    });

    // Guards the one duplicated string in the package. `otel.bootstrap` may not import
    // `./metrics` (Nest), so the instrument name is a literal there; if someone renames
    // the metric in METRIC_NAMES the View would silently select nothing and the buckets
    // would revert to the defaults with no error anywhere. This is that error.
    it('selects the same instrument name METRIC_NAMES declares', () => {
      startOtel({ defaultServiceName: 'svc', httpDurationBoundaries: [1, 2, 3] });

      const { views } = nodeSdkConstructor.mock.calls[0][0] as {
        views: { instrumentName: string; aggregation: { type: unknown } }[];
      };
      const buckets = views.find(
        (v) => v.aggregation.type === AggregationType.EXPLICIT_BUCKET_HISTOGRAM,
      );
      expect(buckets?.instrumentName).toBe(METRIC_NAMES.HTTP_SERVER_DURATION);
    });

    // The SDK keeps the reference it is handed, so a caller mutating its own array
    // afterwards would re-bucket a live histogram past validation.
    it('copies the array so a later caller mutation cannot re-bucket a live histogram', () => {
      const boundaries = [10, 20, 30];
      startOtel({ defaultServiceName: 'svc', httpDurationBoundaries: boundaries });
      boundaries.push(-1);

      const { views } = nodeSdkConstructor.mock.calls[0][0] as {
        views: { aggregation: { type: unknown; options?: { boundaries: number[] } } }[];
      };
      const buckets = views.find(
        (v) => v.aggregation.type === AggregationType.EXPLICIT_BUCKET_HISTOGRAM,
      );
      expect(buckets?.aggregation.options?.boundaries).toEqual([10, 20, 30]);
    });

    describe('rejects a bucket set that would look fine and lie', () => {
      it('throws on an empty array, pointing at omitting the option instead', () => {
        expect(() => startOtel({ defaultServiceName: 'svc', httpDurationBoundaries: [] })).toThrow(
          /must not be empty/,
        );
        expect(start).not.toHaveBeenCalled();
      });

      // Infinity matters as much as NaN: the SDK strips it, so the array silently
      // loses an entry and the series has one fewer bucket than the operator wrote.
      it.each([
        ['NaN', [0, Number.NaN, 100]],
        ['Infinity', [0, 100, Number.POSITIVE_INFINITY]],
        ['-Infinity', [Number.NEGATIVE_INFINITY, 100]],
      ])('throws on %s, naming the offending value', (label, boundaries) => {
        expect(() =>
          startOtel({ defaultServiceName: 'svc', httpDurationBoundaries: boundaries }),
        ).toThrow(new RegExp(`not a finite number \\(received ${label}\\)`));
        expect(start).not.toHaveBeenCalled();
      });

      it('throws on a negative boundary, naming the offending value', () => {
        expect(() =>
          startOtel({ defaultServiceName: 'svc', httpDurationBoundaries: [0, -5, 100] }),
        ).toThrow(/httpDurationBoundaries\[1\] is negative \(received -5\)/);
        expect(start).not.toHaveBeenCalled();
      });

      // Not merely "unsorted": the SDK's aggregator sorts and de-duplicates whatever it
      // gets, so an out-of-order or repeated boundary is accepted upstream and quietly
      // becomes a different bucket set — one that no longer matches the dashboard built
      // beside it. Equal neighbours are as wrong as descending ones.
      it.each([
        ['descending', [0, 500, 100, 1_000], /500 at index 1 is not below 100 at index 2/],
        ['a repeated boundary', [0, 100, 100], /100 at index 1 is not below 100 at index 2/],
      ])('throws on %s', (_label, boundaries, expected) => {
        expect(() =>
          startOtel({ defaultServiceName: 'svc', httpDurationBoundaries: boundaries }),
        ).toThrow(expected);
        expect(start).not.toHaveBeenCalled();
      });

      // Validation runs BEFORE the OTEL_ENABLED gate. Local dev and CI run with OTel
      // off, and that is precisely where a typo in this array should surface — not in
      // the single environment that has telemetry switched on: production.
      it('throws even when OTEL_ENABLED is off, so a typo fails in dev and CI too', () => {
        delete process.env['OTEL_ENABLED'];
        expect(() =>
          startOtel({ defaultServiceName: 'svc', httpDurationBoundaries: [100, 50] }),
        ).toThrow(/strictly ascending/);
      });
    });
  });

  /**
   * ONE source of truth for the inbound request duration: `HttpMetrics`' route-labelled `http.server.duration`.
   * `startOtel` drops instrumentation-http's own server duration histogram, by meter and name.
   *
   * What that is depends on the instrumentation version. In 0.221 (the products' lockfiles) it is
   * `http.server.request.duration` in seconds, there is no name clash, and dropping it simply stops that series
   * being exported. An OLDER version records the legacy `http.server.duration` under the same name as
   * `HttpMetrics`; the legacy name is dropped too as a guard. The first describe below runs the REAL
   * instrumentation; the second simulates the legacy one and says so.
   */
  describe('httpInstrumentationDuration', () => {
    beforeEach(() => {
      process.env['OTEL_ENABLED'] = 'true';
    });

    const viewsOf = () =>
      (nodeSdkConstructor.mock.calls[0][0] as { views?: Record<string, unknown>[] }).views;

    it('drops instrumentation-http’s server duration histograms (legacy and stable names) by default', () => {
      startOtel({ defaultServiceName: 'svc' });
      expect(viewsOf()).toEqual([
        {
          meterName: '@opentelemetry/instrumentation-http',
          instrumentName: 'http.server.duration',
          aggregation: { type: AggregationType.DROP },
        },
        {
          meterName: '@opentelemetry/instrumentation-http',
          instrumentName: 'http.server.request.duration',
          aggregation: { type: AggregationType.DROP },
        },
      ]);
    });

    it('"keep" leaves it alone', () => {
      startOtel({ defaultServiceName: 'svc', httpInstrumentationDuration: 'keep' });
      expect(viewsOf()).toBeUndefined();
    });

    it("the drop views never name our meter: HttpMetrics' own series is not selected", () => {
      startOtel({ defaultServiceName: 'svc', httpDurationBoundaries: [1, 2] });
      for (const view of viewsOf()!) {
        if ((view['aggregation'] as { type: unknown }).type === AggregationType.DROP) {
          expect(view['meterName']).toBe('@opentelemetry/instrumentation-http');
        }
      }
    });

    // The REAL instrumentation, from the version this repository locks (0.221): which instruments it creates, on
    // which meter, is what the views must select. If a version change moves any of that, THIS fails, not a
    // dashboard.
    describe('the REAL @opentelemetry/instrumentation-http', () => {
      const load = async () => {
        const { createRequire } = await import('node:module');
        const fromAuto = createRequire(
          createRequire(import.meta.url).resolve('@opentelemetry/auto-instrumentations-node'),
        );
        const { HttpInstrumentation } = fromAuto('@opentelemetry/instrumentation-http') as {
          HttpInstrumentation: new (config?: object) => {
            instrumentationName: string;
            instrumentationVersion: string;
            setMeterProvider(provider: unknown): void;
            _httpServerDurationHistogram: { record(value: number, attributes: object): void };
          };
        };
        const {
          MeterProvider,
          PeriodicExportingMetricReader,
          InMemoryMetricExporter,
          AggregationTemporality,
        } = await import('@opentelemetry/sdk-metrics');
        const { metrics } = await import('@opentelemetry/api');
        const { HttpMetrics } = await import('./metrics');
        return {
          HttpInstrumentation,
          MeterProvider,
          PeriodicExportingMetricReader,
          InMemoryMetricExporter,
          AggregationTemporality,
          metrics,
          HttpMetrics,
        };
      };

      const exportReal = async (options: Parameters<typeof startOtel>[0]) => {
        const o = await load();
        startOtel(options);
        const config = nodeSdkConstructor.mock.calls.at(-1)![0] as { views?: never[] };
        const exporter = new o.InMemoryMetricExporter(o.AggregationTemporality.CUMULATIVE);
        const reader = new o.PeriodicExportingMetricReader({
          exporter,
          exportIntervalMillis: 3_600_000,
        });
        const provider = new o.MeterProvider({ readers: [reader], views: config.views ?? [] });
        o.metrics.disable();
        o.metrics.setGlobalMeterProvider(provider);
        try {
          const instrumentation = new o.HttpInstrumentation();
          instrumentation.setMeterProvider(provider); // creates the instruments, as the SDK does
          instrumentation._httpServerDurationHistogram.record(0.042, {
            'http.request.method': 'GET',
            'http.response.status_code': 200,
          });
          new o.HttpMetrics().record({
            route: '/v1/things/:id',
            method: 'GET',
            statusCode: 200,
            durationMs: 42,
          });
          await reader.forceFlush();
          const names = exporter
            .getMetrics()
            .flatMap((m) => m.scopeMetrics)
            .flatMap((scope) =>
              scope.metrics.map(
                (metric) =>
                  `${scope.scope.name}|${metric.descriptor.name}|${metric.descriptor.unit}`,
              ),
            );
          return { names, instrumentation };
        } finally {
          await provider.shutdown();
          o.metrics.disable();
        }
      };

      it('records http.server.request.duration in SECONDS on its own meter, and NOT the legacy http.server.duration (the premise)', async () => {
        const { names, instrumentation } = await exportReal({
          defaultServiceName: 'svc',
          httpInstrumentationDuration: 'keep',
        });
        expect(instrumentation.instrumentationName).toBe('@opentelemetry/instrumentation-http');
        expect(names).toContain(
          '@opentelemetry/instrumentation-http|http.server.request.duration|s',
        );
        expect(
          names.some(
            (n) => n.endsWith('|http.server.duration|ms') && n.startsWith('@opentelemetry/'),
          ),
        ).toBe(false);
        // so with the default kept there is no collision: HttpMetrics' histogram is the only http.server.duration
        expect(names.filter((n) => n.includes('|http.server.duration|'))).toEqual([
          'qnsc|http.server.duration|ms',
        ]);
      });

      it('default "drop": http.server.request.duration is no longer exported (the REAL effect); HttpMetrics’ series is untouched', async () => {
        const { names } = await exportReal({ defaultServiceName: 'svc' });
        expect(names.some((n) => n.includes('http.server.request.duration'))).toBe(false);
        expect(names).toContain('qnsc|http.server.duration|ms');
      });

      it('with "keep" and the buckets option the real instrumentation is still exported under its own name: the buckets view selects http.server.duration only', async () => {
        const { names } = await exportReal({
          defaultServiceName: 'svc',
          httpInstrumentationDuration: 'keep',
          httpDurationBoundaries: [0, 50, 500],
        });
        expect(names.filter((n) => n.includes('|http.server.duration|'))).toEqual([
          'qnsc|http.server.duration|ms',
        ]);
        expect(names).toContain(
          '@opentelemetry/instrumentation-http|http.server.request.duration|s',
        );
      });
    });

    // The behaviour, against the real SDK: feed the views startOtel built to a real MeterProvider and record the
    // way the two recorders do. Exactly ONE `http.server.duration` stream comes out, and it is HttpMetrics'.
    describe('LEGACY instrumentation (simulated: an older version recorded http.server.duration in ms) against a real MeterProvider', () => {
      const exportWith = async (options: Parameters<typeof startOtel>[0]) => {
        const {
          MeterProvider,
          PeriodicExportingMetricReader,
          InMemoryMetricExporter,
          AggregationTemporality,
        } = await import('@opentelemetry/sdk-metrics');
        const { metrics } = await import('@opentelemetry/api');
        const { HttpMetrics } = await import('./metrics');

        startOtel(options);
        const config = nodeSdkConstructor.mock.calls.at(-1)![0] as { views?: never[] };
        const exporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
        const reader = new PeriodicExportingMetricReader({
          exporter,
          exportIntervalMillis: 3_600_000,
        });
        const provider = new MeterProvider({ readers: [reader], views: config.views ?? [] });
        metrics.disable();
        metrics.setGlobalMeterProvider(provider);
        try {
          // what instrumentation-http does: its own meter, its own attributes
          provider
            .getMeter('@opentelemetry/instrumentation-http')
            .createHistogram('http.server.duration', { unit: 'ms' })
            .record(42, {
              'http.method': 'GET',
              'http.status_code': 200,
              'http.target': '/v1/things/123',
            });
          provider
            .getMeter('@opentelemetry/instrumentation-http')
            .createHistogram('http.server.request.duration', { unit: 's' })
            .record(0.042, { 'http.request.method': 'GET' });
          // what the product's interceptor does
          new HttpMetrics().record({
            route: '/v1/things/:id',
            method: 'GET',
            statusCode: 200,
            durationMs: 42,
          });
          await reader.forceFlush();
          const streams = exporter
            .getMetrics()
            .flatMap((m) => m.scopeMetrics)
            .flatMap((scope) =>
              scope.metrics.map((metric) => ({
                scope: scope.scope.name,
                name: metric.descriptor.name,
                points: metric.dataPoints.map((p) => ({
                  attributes: p.attributes,
                  value: p.value as { count?: number; buckets?: { boundaries: number[] } },
                })),
              })),
            );
          return streams;
        } finally {
          await provider.shutdown();
          metrics.disable();
        }
      };

      it('default: the legacy-named histogram is dropped, so exactly one http.server.duration stream remains: HttpMetrics’, with its route label', async () => {
        const streams = await exportWith({ defaultServiceName: 'svc' });
        const durations = streams.filter((s) => s.name === 'http.server.duration');
        expect(durations).toHaveLength(1);
        expect(durations[0]!.scope).toBe('qnsc');
        expect(durations[0]!.points).toHaveLength(1);
        expect(durations[0]!.points[0]!.attributes).toEqual({
          route: '/v1/things/:id',
          method: 'GET',
          status_class: '2xx',
        });
        expect(durations[0]!.points[0]!.value.count).toBe(1); // one request, counted once
        expect(streams.some((s) => s.name === 'http.server.request.duration')).toBe(false);
      });

      it('the buckets option applies to HttpMetrics’ histogram and does not bring the dropped one back', async () => {
        const streams = await exportWith({
          defaultServiceName: 'svc',
          httpDurationBoundaries: [0, 50, 500, 5000],
        });
        const durations = streams.filter((s) => s.name === 'http.server.duration');
        expect(durations).toHaveLength(1);
        expect(durations[0]!.scope).toBe('qnsc');
        expect(durations[0]!.points[0]!.value.buckets?.boundaries).toEqual([0, 50, 500, 5000]);
      });

      it('keep: both are exported, which is the double-reporting the default exists to prevent', async () => {
        const streams = await exportWith({
          defaultServiceName: 'svc',
          httpInstrumentationDuration: 'keep',
        });
        const scopes = streams
          .filter((s) => s.name === 'http.server.duration')
          .map((s) => s.scope)
          .sort();
        expect(scopes).toEqual(['@opentelemetry/instrumentation-http', 'qnsc']);
      });
    });
  });

  it('never traces health, readiness, or favicon requests', () => {
    // Probes run on a fixed schedule and would otherwise dominate both the trace
    // volume and the bill. `/livez` — the kubelet liveness path — was missing.
    expect([...__ignoredRequestPaths]).toEqual(
      expect.arrayContaining([...PROBE_PATHS, '/favicon.ico']),
    );
  });

  describe('probe filtering', () => {
    beforeEach(() => {
      process.env['OTEL_ENABLED'] = 'true';
    });

    // The hook the HTTP instrumentation really calls — not just the constant — so a
    // future edit that stops using the shared list fails here.
    it.each([...PROBE_PATHS, '/favicon.ico', '/livez?verbose=1'])('ignores incoming %s', (url) => {
      startOtel({ defaultServiceName: 'svc' });
      expect(ignoreHook()({ url })).toBe(true);
    });

    it('keeps real routes', () => {
      startOtel({ defaultServiceName: 'svc' });
      expect(ignoreHook()({ url: '/v1/users' })).toBe(false);
      expect(ignoreHook()({})).toBe(false);
    });
  });

  describe('instrumentations', () => {
    beforeEach(() => {
      process.env['OTEL_ENABLED'] = 'true';
    });

    it('does not include the AWS SDK instrumentation', () => {
      startOtel({ defaultServiceName: 'svc' });
      expect(instrumentationNames()).not.toContain('@opentelemetry/instrumentation-aws-sdk');
    });

    it('still includes the instrumentations the products rely on', () => {
      startOtel({ defaultServiceName: 'svc' });
      expect(instrumentationNames()).toEqual(
        expect.arrayContaining([
          '@opentelemetry/instrumentation-http',
          '@opentelemetry/instrumentation-pg',
          '@opentelemetry/instrumentation-ioredis',
        ]),
      );
    });
  });

  describe('Kubernetes resource attributes', () => {
    beforeEach(() => {
      process.env['OTEL_ENABLED'] = 'true';
      delete process.env['K8S_POD_NAME'];
      delete process.env['K8S_NAMESPACE'];
      delete process.env['K8S_NODE_NAME'];
    });

    it('maps the downward-API variables onto k8s.* resource attributes', () => {
      process.env['K8S_POD_NAME'] = 'rova-api-7d9f-x2k4q';
      process.env['K8S_NAMESPACE'] = 'rova';
      process.env['K8S_NODE_NAME'] = 'qnsc-node-1';
      startOtel({ defaultServiceName: 'svc' });

      expect(resourceAttributes()).toMatchObject({
        'k8s.pod.name': 'rova-api-7d9f-x2k4q',
        'k8s.namespace.name': 'rova',
        'k8s.node.name': 'qnsc-node-1',
      });
    });

    it('emits none of them outside Kubernetes, rather than empty strings', () => {
      startOtel({ defaultServiceName: 'svc' });
      const attributes = resourceAttributes();

      expect(Object.keys(attributes).filter((key) => key.startsWith('k8s.'))).toEqual([]);
    });

    it('skips a variable that is set but blank', () => {
      process.env['K8S_POD_NAME'] = '   ';
      process.env['K8S_NAMESPACE'] = 'rova';
      startOtel({ defaultServiceName: 'svc' });
      const attributes = resourceAttributes();

      expect(attributes).not.toHaveProperty('k8s.pod.name');
      expect(attributes['k8s.namespace.name']).toBe('rova');
    });
  });

  describe('sampling', () => {
    beforeEach(() => {
      process.env['OTEL_ENABLED'] = 'true';
      delete process.env['OTEL_SAMPLING_PROBABILITY'];
    });

    const samplerOf = () =>
      String((nodeSdkConstructor.mock.calls[0][0] as { sampler: unknown }).sampler);

    it('is parentbased_traceidratio at 0.1 in production by default', () => {
      process.env['DEPLOYMENT_ENV'] = 'production';
      startOtel({ defaultServiceName: 'svc' });

      expect(samplerOf()).toContain('ParentBased');
      expect(samplerOf()).toContain('TraceIdRatioBased{0.1}');
    });

    it('is overridable with OTEL_SAMPLING_PROBABILITY', () => {
      process.env['DEPLOYMENT_ENV'] = 'production';
      process.env['OTEL_SAMPLING_PROBABILITY'] = '0.25';
      startOtel({ defaultServiceName: 'svc' });

      expect(samplerOf()).toContain('TraceIdRatioBased{0.25}');
    });

    // `TraceIdRatioBasedSampler` turns NaN into 0 — every trace dropped, no error.
    it.each(['', 'ten-percent'])('falls back to the default for %o and says so', (value) => {
      process.env['DEPLOYMENT_ENV'] = 'production';
      process.env['OTEL_SAMPLING_PROBABILITY'] = value;
      const warning = vi.spyOn(process, 'emitWarning').mockImplementation(() => undefined);

      startOtel({ defaultServiceName: 'svc' });

      expect(samplerOf()).toContain('TraceIdRatioBased{0.1}');
      expect(warning).toHaveBeenCalledWith(
        expect.stringContaining('OTEL_SAMPLING_PROBABILITY'),
        'OtelSamplingWarning',
      );
      warning.mockRestore();
    });
  });
});

/** The `ignoreIncomingRequestHook` handed to the HTTP instrumentation. */
function ignoreHook(): (req: { url?: string }) => boolean {
  const http = instrumentations().find(
    (i) => i.instrumentationName === '@opentelemetry/instrumentation-http',
  );
  const config = http?.getConfig() as {
    ignoreIncomingRequestHook: (req: { url?: string }) => boolean;
  };
  return config.ignoreIncomingRequestHook;
}

function instrumentations(): {
  instrumentationName: string;
  getConfig(): unknown;
}[] {
  const { instrumentations: list } = nodeSdkConstructor.mock.calls[0][0] as {
    instrumentations: ({ instrumentationName: string; getConfig(): unknown } | unknown[])[];
  };
  return list.flat() as { instrumentationName: string; getConfig(): unknown }[];
}

function instrumentationNames(): string[] {
  return instrumentations().map((i) => i.instrumentationName);
}

function resourceAttributes(): Record<string, unknown> {
  const { resource } = nodeSdkConstructor.mock.calls[0][0] as {
    resource: { attributes: Record<string, unknown> };
  };
  return resource.attributes;
}

describe('shutdownOtel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetOtelForTesting();
  });

  it('is safe when OTel never started', async () => {
    await expect(shutdownOtel()).resolves.toBeUndefined();
    expect(shutdown).not.toHaveBeenCalled();
  });

  it('flushes the SDK when it did start', async () => {
    process.env['OTEL_ENABLED'] = 'true';
    startOtel({ defaultServiceName: 'svc' });
    await shutdownOtel();
    expect(shutdown).toHaveBeenCalledTimes(1);
    delete process.env['OTEL_ENABLED'];
  });
});
