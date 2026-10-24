# Changelog

## [0.1.7](https://github.com/quynhonsemiconductor/app-platform/compare/platform-mail-v0.1.6...platform-mail-v0.1.7) (2026-10-24)


### 🐛 Bug Fixes

* **deps:** osv sweep — msal-node 7.1.0, nodemailer 10.1.7, fast-uri and undici floors ([#309](https://github.com/quynhonsemiconductor/app-platform/issues/309)) ([362ed15](https://github.com/quynhonsemiconductor/app-platform/commit/362ed15b887af5660aa3388d33a216484b9633f7))

## [0.1.6](https://github.com/quynhonsemiconductor/app-platform/compare/platform-mail-v0.1.5...platform-mail-v0.1.6) (2026-10-20)


### ✨ Features

* **mail:** read the Graph certificate from AZURE_CLIENT_CERTIFICATE_PATH ([#284](https://github.com/quynhonsemiconductor/app-platform/issues/284)) ([5889bb3](https://github.com/quynhonsemiconductor/app-platform/commit/5889bb33aa1248547849a54c31aacafd3297a146))

## [0.1.5](https://github.com/quynhonsemiconductor/app-platform/compare/platform-mail-v0.1.4...platform-mail-v0.1.5) (2026-10-18)


### 🐛 Bug Fixes

* **platform-mail:** bounded Retry-After and the [#258](https://github.com/quynhonsemiconductor/app-platform/issues/258) verification nits ([#264](https://github.com/quynhonsemiconductor/app-platform/issues/264)) ([33959da](https://github.com/quynhonsemiconductor/app-platform/commit/33959da66dc597738153c6a69542119a315d5380))

## [0.1.4](https://github.com/quynhonsemiconductor/app-platform/compare/platform-mail-v0.1.3...platform-mail-v0.1.4) (2026-10-17)


### ✨ Features

* **platform-mail:** certificate credential for ECS, /sender entry, platform-mail-check ([#258](https://github.com/quynhonsemiconductor/app-platform/issues/258)) ([2c48e50](https://github.com/quynhonsemiconductor/app-platform/commit/2c48e504ae70c43b25c34ff54caf710b1bfa4294))

## [0.1.3](https://github.com/quynhonsemiconductor/app-platform/compare/platform-mail-v0.1.2...platform-mail-v0.1.3) (2026-10-11)


### ✨ Features

* **platform-mail:** post-deploy smoke test and per-environment mail policy ([#213](https://github.com/quynhonsemiconductor/app-platform/issues/213)) ([5806371](https://github.com/quynhonsemiconductor/app-platform/commit/58063715f11316744666373a6da9b236beab514c))

## [0.1.2](https://github.com/quynhonsemiconductor/app-platform/compare/platform-mail-v0.1.1...platform-mail-v0.1.2) (2026-10-10)


### ✨ Features

* **platform-jobs:** bound the time an unprocessed job may wait with retention.pending ([#204](https://github.com/quynhonsemiconductor/app-platform/issues/204)) ([b36f4b5](https://github.com/quynhonsemiconductor/app-platform/commit/b36f4b5aaa2ad56dd12cba0ac0f56cfc3ec9edbf))
* **platform-jobs:** redrive dead-letter jobs ([#188](https://github.com/quynhonsemiconductor/app-platform/issues/188)) ([434c2ba](https://github.com/quynhonsemiconductor/app-platform/commit/434c2bab91fe9bf67db31fd313e91e7b2a280565))


### 🐛 Bug Fixes

* **platform-mail:** make the NestJS example boot, and never start a send on an aborted attempt ([#202](https://github.com/quynhonsemiconductor/app-platform/issues/202)) ([6dd4515](https://github.com/quynhonsemiconductor/app-platform/commit/6dd4515d3547f4980c72e90ed217526eb680630d))

## [0.1.1](https://github.com/quynhonsemiconductor/app-platform/compare/platform-mail-v0.1.0...platform-mail-v0.1.1) (2026-10-10)


### ✨ Features

* **platform-mail:** add the email transport package ([#172](https://github.com/quynhonsemiconductor/app-platform/issues/172)) ([23d15ba](https://github.com/quynhonsemiconductor/app-platform/commit/23d15ba829a682d96efd465af1e336ff3f393cf9))


### 🐛 Bug Fixes

* **platform-mail:** refuse test senders in production, renew the claim, back off in place ([#187](https://github.com/quynhonsemiconductor/app-platform/issues/187)) ([49f4d0f](https://github.com/quynhonsemiconductor/app-platform/commit/49f4d0f4da26fd47400d1e3d93ff52a4b0f65de0))
