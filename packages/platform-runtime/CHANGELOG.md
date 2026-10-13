# Changelog

## [0.1.4](https://github.com/quynhonsemiconductor/app-platform/compare/platform-runtime-v0.1.3...platform-runtime-v0.1.4) (2026-10-13)


### ✨ Features

* **platform-cache:** tryLock, a lock with an owner token; ExclusiveJob releases only its own ([#232](https://github.com/quynhonsemiconductor/app-platform/issues/232)) ([3b08830](https://github.com/quynhonsemiconductor/app-platform/commit/3b088306eadadfbf5695df1338c82eb4f6421ddf))


### 🐛 Bug Fixes

* **platform-runtime:** enableHealth no longer ends the process when there is no database pool or CacheService ([#239](https://github.com/quynhonsemiconductor/app-platform/issues/239)) ([3a0682a](https://github.com/quynhonsemiconductor/app-platform/commit/3a0682ada131eaf63e0d108dd7195fe1b8d19864))

## [0.1.3](https://github.com/quynhonsemiconductor/app-platform/compare/platform-runtime-v0.1.2...platform-runtime-v0.1.3) (2026-10-09)

### ✨ Features

- **platform-runtime:** add /livez, /readyz and graceful shutdown for pod drains ([f227cb1](https://github.com/quynhonsemiconductor/app-platform/commit/f227cb1460e3f6b016cac8c2e849c5686d4c0295))

## [0.1.2](https://github.com/quynhonsemiconductor/app-platform/compare/platform-runtime-v0.1.1...platform-runtime-v0.1.2) (2026-10-09)

### ♻️ Refactors

- **platform-http:** own sanitizeString, and relocate orphaned tests ([#131](https://github.com/quynhonsemiconductor/app-platform/issues/131)) ([0be062f](https://github.com/quynhonsemiconductor/app-platform/commit/0be062f9ef38e3fed79e7db3deb963162bd12745))

### 🔒 Security

- **deps:** clear the osv-scanner findings that turn the required check red ([#141](https://github.com/quynhonsemiconductor/app-platform/issues/141)) ([40749f7](https://github.com/quynhonsemiconductor/app-platform/commit/40749f70065df43a3776d1d3d96d0772dd0b5fc7))

## [0.1.1](https://github.com/quynhonsemiconductor/app-platform/compare/platform-runtime-v0.1.0...platform-runtime-v0.1.1) (2026-09-08)

### ✨ Features

- add platform-runtime, make the conformance kit runnable against real adapters ([#98](https://github.com/quynhonsemiconductor/app-platform/issues/98)) ([486783f](https://github.com/quynhonsemiconductor/app-platform/commit/486783f69edd0090a8251626bd7b032909945c10))
