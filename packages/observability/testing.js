/* eslint-disable @typescript-eslint/no-require-imports --
 * A published CommonJS shim, not source: it lets `@quynhonsemiconductor/observability/testing` resolve under TypeScript's node10 algorithm,
 * which ignores the `exports` map. Same reason as otel.js.
 */
module.exports = require('./dist/testing/index.js');
