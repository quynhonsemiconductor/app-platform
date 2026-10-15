/* eslint-disable @typescript-eslint/no-require-imports --
 * Published CommonJS shim, not source: see otel.js. Makes `@quynhonsemiconductor/observability/script-logger` resolve under TypeScript's
 * node10 algorithm, which ignores the `exports` map.
 */
module.exports = require('./dist/script-logger.js');
