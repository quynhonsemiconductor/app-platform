# Changelog

## [0.6.1](https://github.com/quynhonsemiconductor/app-platform/compare/observability-v0.6.0...observability-v0.6.1) (2026-10-20)


### 🐛 Bug Fixes

* **observability:** export metrics every 60s by default to stay in the free tier ([#281](https://github.com/quynhonsemiconductor/app-platform/issues/281)) ([afe6f4a](https://github.com/quynhonsemiconductor/app-platform/commit/afe6f4af2f9ed15a4ecdd99b90dedb0d6f3a5ddb))

## [0.6.0](https://github.com/quynhonsemiconductor/app-platform/compare/observability-v0.5.0...observability-v0.6.0) (2026-10-16)


### ⚠ BREAKING CHANGES

* **observability:** the `job` label on job.* metrics is now `job_name`; queries that group or filter by it must change.

### ✨ Features

* **observability:** name the job job_name on every job metric (job is overwritten by OTLP-&gt;Prometheus) ([#251](https://github.com/quynhonsemiconductor/app-platform/issues/251)) ([e2175d6](https://github.com/quynhonsemiconductor/app-platform/commit/e2175d6ea4f1c260439e92aaf7002a61bc927745))


### 🐛 Bug Fixes

* **observability:** create the job failure series at 0 before each run ([#250](https://github.com/quynhonsemiconductor/app-platform/issues/250)) ([8e08b29](https://github.com/quynhonsemiconductor/app-platform/commit/8e08b293fb534536024d10c4e69ff332d795932e))

## [0.5.0](https://github.com/quynhonsemiconductor/app-platform/compare/observability-v0.4.2...observability-v0.5.0) (2026-10-15)


### ⚠ BREAKING CHANGES

* **observability:** the log 'level' is a label (info, error) and 'time' is ISO-8601 UTC, not pino's numeric level and epoch ms; Error values logged under err or error are serialised ({type,message,stack}) instead of {}. Queries that parse the numeric level or time must change.

### ✨ Features

* **observability:** one log shape and one bootstrap: createHttpApp / createWorkerApp, conformance kit ([#245](https://github.com/quynhonsemiconductor/app-platform/issues/245)) ([a228b5c](https://github.com/quynhonsemiconductor/app-platform/commit/a228b5c22a737d97b34067fde1ff5cbe34167ca6))

## [0.4.2](https://github.com/quynhonsemiconductor/app-platform/compare/observability-v0.4.1...observability-v0.4.2) (2026-10-15)


### 🐛 Bug Fixes

* **observability:** never log the request an error carries ([#246](https://github.com/quynhonsemiconductor/app-platform/issues/246)) ([c83402d](https://github.com/quynhonsemiconductor/app-platform/commit/c83402d30840f9446fb6504b114de6f0908f9aad))

## [0.4.1](https://github.com/quynhonsemiconductor/app-platform/compare/observability-v0.4.0...observability-v0.4.1) (2026-10-15)


### 🐛 Bug Fixes

* **observability:** service, env and version on every log line, not only request lines ([#242](https://github.com/quynhonsemiconductor/app-platform/issues/242)) ([7313f25](https://github.com/quynhonsemiconductor/app-platform/commit/7313f259b4df14239a3c095709f446405db3162c))

## [0.4.0](https://github.com/quynhonsemiconductor/app-platform/compare/observability-v0.3.0...observability-v0.4.0) (2026-10-14)


### ⚠ BREAKING CHANGES

* **observability:** the unused v8js.gc.duration and v8js.memory.heap.space.* series are no longer exported by default (pass unusedSeries: 'keep' to restore them), and the log env field now reports DEPLOYMENT_ENV when set instead of NODE_ENV.

### ✨ Features

* **observability:** drop the unused v8js series at the SDK; log the deployment environment in env ([#240](https://github.com/quynhonsemiconductor/app-platform/issues/240)) ([0960a2c](https://github.com/quynhonsemiconductor/app-platform/commit/0960a2cd6b014d65b9338137da4477ed69972e32))

## [0.3.0](https://github.com/quynhonsemiconductor/app-platform/compare/observability-v0.2.2...observability-v0.3.0) (2026-10-13)


### ⚠ BREAKING CHANGES

* **observability:** http.server.request.duration (seconds) is no longer exported by default. Move dashboards and alerts that read it to http.server.duration (ms; labels route, method, status_class), or set httpInstrumentationDuration: 'keep'. A service that does not call HttpMetrics.record() and relied on the instrumentation's duration must set 'keep'.

### ✨ Features

* **observability:** setRequestPrincipal, the one place the authenticated caller is recorded ([e35f73f](https://github.com/quynhonsemiconductor/app-platform/commit/e35f73f6adf17cfc6dfd06b8f711154fc308b4c2))


### 🐛 Bug Fixes

* **observability:** do not export instrumentation-http's server duration; HttpMetrics owns the request duration ([#237](https://github.com/quynhonsemiconductor/app-platform/issues/237)) ([e675897](https://github.com/quynhonsemiconductor/app-platform/commit/e67589755fe81d4ad1639589373de25a7e88e5e7))

## [0.2.2](https://github.com/quynhonsemiconductor/app-platform/compare/observability-v0.2.1...observability-v0.2.2) (2026-10-10)


### 🐛 Bug Fixes

* **observability,platform-http:** security/auth metrics never throw; say when DISABLE_RATE_LIMIT is ignored ([#158](https://github.com/quynhonsemiconductor/app-platform/issues/158)) ([7cecb0f](https://github.com/quynhonsemiconductor/app-platform/commit/7cecb0f680e808b2ac98efcfe2da1f3c560856ce))

## [0.2.1](https://github.com/quynhonsemiconductor/app-platform/compare/observability-v0.2.0...observability-v0.2.1) (2026-10-09)

### ✨ Features

- **observability:** k8s attributes, shared probe paths, label guard ([#145](https://github.com/quynhonsemiconductor/app-platform/issues/145)) ([fd7eb09](https://github.com/quynhonsemiconductor/app-platform/commit/fd7eb09ff7f8be8268b9fbe525741b24a7ee4521))

### 🔒 Security

- **deps:** clear the osv-scanner findings that turn the required check red ([#141](https://github.com/quynhonsemiconductor/app-platform/issues/141)) ([40749f7](https://github.com/quynhonsemiconductor/app-platform/commit/40749f70065df43a3776d1d3d96d0772dd0b5fc7))

## [0.2.0](https://github.com/quynhonsemiconductor/app-platform/compare/observability-v0.1.6...observability-v0.2.0) (2026-09-05)

### ⚠ BREAKING CHANGES

- package scope changed; update dependency names to the new scope.

### ✨ Features

- publish packages under the organization scope ([#91](https://github.com/quynhonsemiconductor/app-platform/issues/91)) ([cd3af62](https://github.com/quynhonsemiconductor/app-platform/commit/cd3af62cde67a78dda2798a4896cf902cf3c0a2a))

## [0.1.6](https://github.com/QNSC-VN/qnsc-app-platform/compare/observability-v0.1.5...observability-v0.1.6) (2026-08-31)

### ✨ Features

- **observability:** opt-in http.server.duration histogram boundaries ([#84](https://github.com/QNSC-VN/qnsc-app-platform/issues/84)) ([38aa1a2](https://github.com/QNSC-VN/qnsc-app-platform/commit/38aa1a296c5fbf21cdb2654171e7079d12dc46f0))

## [0.1.5](https://github.com/QNSC-VN/qnsc-app-platform/compare/observability-v0.1.4...observability-v0.1.5) (2026-08-30)

### ✨ Features

- **observability:** auth.login metric — is login itself working ([#82](https://github.com/QNSC-VN/qnsc-app-platform/issues/82)) ([807d2c1](https://github.com/QNSC-VN/qnsc-app-platform/commit/807d2c1957db6358d5aced021b1c04df5db7771c))

## [0.1.4](https://github.com/QNSC-VN/qnsc-app-platform/compare/observability-v0.1.3...observability-v0.1.4) (2026-07-27)

### 🐛 Bug Fixes

- **observability:** take deployment identity from DEPLOYMENT_ENV, not NODE_ENV ([#68](https://github.com/QNSC-VN/qnsc-app-platform/issues/68)) ([e0d6002](https://github.com/QNSC-VN/qnsc-app-platform/commit/e0d6002edd00a8ec61aa66f780acd103413b34d9))

## [0.1.3](https://github.com/QNSC-VN/qnsc-app-platform/compare/observability-v0.1.2...observability-v0.1.3) (2026-07-26)

### 🐛 Bug Fixes

- **observability:** pull-based pool gauges, one fail-open contract, shared ignore list ([#66](https://github.com/QNSC-VN/qnsc-app-platform/issues/66)) ([aac3b8e](https://github.com/QNSC-VN/qnsc-app-platform/commit/aac3b8e6faa99cad1ef26d2e6e592832816d1cf1))

## [0.1.2](https://github.com/QNSC-VN/qnsc-app-platform/compare/observability-v0.1.1...observability-v0.1.2) (2026-07-26)

### ✨ Features

- **observability:** metric instruments with bounded labels ([#64](https://github.com/QNSC-VN/qnsc-app-platform/issues/64)) ([b8eb80a](https://github.com/QNSC-VN/qnsc-app-platform/commit/b8eb80a0db24657b63850a097f920495218b4cc4))

## [0.1.1](https://github.com/QNSC-VN/qnsc-app-platform/compare/observability-v0.1.0...observability-v0.1.1) (2026-07-26)

### ✨ Features

- **observability:** shared OTel bootstrap, logger factory, and job context ([#62](https://github.com/QNSC-VN/qnsc-app-platform/issues/62)) ([c61765f](https://github.com/QNSC-VN/qnsc-app-platform/commit/c61765f09d87a97af873bd64aa720a7861bc51d5))
