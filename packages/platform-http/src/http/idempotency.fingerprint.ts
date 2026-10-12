import { createHash } from 'node:crypto';

/**
 * JSON with object keys sorted, so `{a:1,b:2}` and `{b:2,a:1}` are the same request. Arrays keep their
 * order (it is meaning); a Buffer is its SHA-256 (never its bytes in a string).
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalise(value)) ?? 'null';
}

function normalise(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Buffer.isBuffer(value)) return { $buffer: createHash('sha256').update(value).digest('hex') };
  if (Array.isArray(value)) return value.map(normalise);
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return Object.fromEntries(entries.map(([k, v]) => [k, normalise(v)]));
}

export interface FingerprintInput {
  method: string;
  /** The path of the request, query included. The same key on another route is another request. */
  url: string;
  body: unknown;
  headers: Record<string, string | string[] | undefined>;
}

const header = (h: FingerprintInput['headers'], name: string): string => {
  const v = h[name];
  return (Array.isArray(v) ? v[0] : v) ?? '';
};

/**
 * What the key is bound to: SHA-256 of method, URL and body. The same `Idempotency-Key` with a different
 * question is a client bug, and answering it with the first request's response would report success for work
 * that was never done.
 *
 * A body that is not parsed (a multipart upload, a stream) is not visible here, so it is fingerprinted by its
 * `content-type` and `content-length` only, which tells two different-sized uploads apart and nothing more.
 */
export function requestFingerprint(input: FingerprintInput): string {
  const parsed = input.body !== undefined && input.body !== null;
  const unparsed = parsed
    ? ''
    : `${header(input.headers, 'content-type')}|${header(input.headers, 'content-length')}`;
  return createHash('sha256')
    .update(
      `${input.method.toUpperCase()}\n${input.url}\n${canonicalJson(input.body ?? null)}\n${unparsed}`,
    )
    .digest('hex');
}
