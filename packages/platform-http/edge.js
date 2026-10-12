/* eslint-disable @typescript-eslint/no-require-imports --
 * Published CommonJS shim, not source. It lets
 * `@quynhonsemiconductor/platform-http/edge` resolve under TypeScript's node10 algorithm, which
 * every product backend uses and which ignores an `exports` map, and under a Worker bundler.
 */
module.exports = require('./dist/http/edge');
