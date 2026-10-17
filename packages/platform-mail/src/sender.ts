/**
 * `@quynhonsemiconductor/platform-mail/sender`: the transport and nothing else.
 *
 * The package root also exports the `mail.send` QUEUE (`registerMailJobs`, the Valkey ledger, the smoke test), which needs `platform-jobs` and
 * pg-boss. A product that already has its own outbox and relay only needs to SEND: this entry is the contract, the errors, the configuration
 * and `createEmailSender`, with no import of `platform-jobs`, so it can be used without installing it.
 */
export * from './errors';
export * from './message';
export {
  readMailConfig,
  type MailConfig,
  type MailEnv,
  type GraphConfig,
  type SmtpConfig,
} from './config';
export { createEmailSender, type CreateEmailSenderOptions } from './factory';
export {
  createGraphSender,
  buildGraphPayload,
  parseRetryAfter,
  GRAPH_BASE_URL,
  GRAPH_SCOPE,
  type GraphSenderOptions,
  type TokenProvider,
} from './graph';
