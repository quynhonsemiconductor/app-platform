/* eslint-disable @typescript-eslint/no-require-imports --
 * Published CommonJS shim, not source: makes `@quynhonsemiconductor/platform-mail/sender` resolve under TypeScript's node10 algorithm,
 * which ignores the `exports` map (see nest.js).
 */
module.exports = require('./dist/sender.js');
