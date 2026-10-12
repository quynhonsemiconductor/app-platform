import {
  EDGE_HEADER_PREFIX,
  EDGE_IP_HEADER,
  EDGE_SECRET_MIN_LENGTH,
  EDGE_SIG_HEADER,
  EDGE_TS_HEADER,
  edgeSigningString,
  isEdgeIpText,
  normalizeEdgeSecret,
} from './edge-protocol';

/**
 * `@quynhonsemiconductor/platform-http/edge` — the Worker / Pages Function side of the signed edge
 * client IP. WebCrypto and the `Headers`/`Request` classes only: no Node module, so it bundles into a
 * Worker.
 *
 * ```ts
 * import { forwardToOrigin } from '@quynhonsemiconductor/platform-http/edge';
 *
 * export default {
 *   fetch(request: Request, env: { EDGE_CLIENT_IP_SECRET: string }): Promise<Response> {
 *     const target = new URL(request.url);
 *     target.hostname = 'api.qnsc.vn';
 *     return forwardToOrigin(request, { secret: env.EDGE_CLIENT_IP_SECRET, target });
 *   },
 * };
 * ```
 *
 * `forwardToOrigin` does what a hand-written `fetch(new Request(target, { method, headers, body }))`
 * gets wrong: it does NOT follow redirects (a default `fetch` follows, so identity's `/callback/*` 302
 * would be followed inside the Worker: the browser would never receive its `Set-Cookie`, and the signed
 * headers and the cookies would be re-sent to wherever the redirect points), it forwards only an
 * allow-list of headers, and it signs the request it actually sends.
 */

export interface EdgeSignInput {
  /** At least 32 characters once trimmed: `EDGE_CLIENT_IP_SECRET`, as a Worker secret. */
  secret: string;
  /** The visitor's address: `cf-connecting-ip` of the request the Worker received. */
  ip: string;
  /** The method of the request the Worker sends to the API (letters only). */
  method: string;
  /** The path (query ignored) of the request the Worker sends to the API, after any rewrite. */
  path: string;
  /** Test seam; defaults to now. Milliseconds since the epoch, or a Date. */
  now?: number | Date;
}

export interface EdgeHeaders {
  [EDGE_IP_HEADER]: string;
  [EDGE_TS_HEADER]: string;
  [EDGE_SIG_HEADER]: string;
}

const encoder = new TextEncoder();

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The three headers for one request. Rejects an unusable secret, method or address rather than sign them. */
export async function signEdgeClientIp(input: EdgeSignInput): Promise<EdgeHeaders> {
  // Trimmed exactly as the API trims it: a trailing newline in the secret must not be the difference
  // between a verifying signature and a silent fallback to the shared address.
  const secret = normalizeEdgeSecret(input.secret);
  if (secret.length < EDGE_SECRET_MIN_LENGTH) {
    throw new Error(`The edge secret must be at least ${EDGE_SECRET_MIN_LENGTH} characters.`);
  }
  if (!isEdgeIpText(input.ip)) throw new Error('The edge client IP is not an IP address.');
  const nowMs = input.now instanceof Date ? input.now.getTime() : (input.now ?? Date.now());
  const ts = Math.floor(nowMs / 1000);

  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(edgeSigningString(ts, input.ip, input.method, input.path)),
  );
  return {
    [EDGE_IP_HEADER]: input.ip,
    [EDGE_TS_HEADER]: String(ts),
    [EDGE_SIG_HEADER]: base64url(new Uint8Array(signature)),
  };
}

/** Delete every `x-qnsc-edge-*` header: anything a visitor sent under the edge's names is theirs, not ours. */
export function stripEdgeHeaders(headers: Headers): void {
  for (const name of [...headers.keys()]) {
    if (name.toLowerCase().startsWith(EDGE_HEADER_PREFIX)) headers.delete(name);
  }
}

/**
 * Prepare the headers of the request a Worker sends to the API: strip inbound `x-qnsc-edge-*`, then
 * (when there is a usable visitor address) set the signed trio. Always strips first, so a visitor can
 * never smuggle their own edge headers through. Resolves `true` when the signed headers were set;
 * `false` when there was no usable address (the request then goes unsigned and the API falls back to
 * its ordinary order).
 *
 * This only edits headers. Building the whole request (redirect handling, header allow-list, body) is
 * {@link edgeForwardRequest}; prefer that.
 */
export async function applyEdgeClientIp(
  headers: Headers,
  input: Omit<EdgeSignInput, 'ip'> & { ip: string | null | undefined },
): Promise<boolean> {
  stripEdgeHeaders(headers);
  if (!input.ip || !isEdgeIpText(input.ip)) return false;
  const signed = await signEdgeClientIp({ ...input, ip: input.ip });
  for (const [name, value] of Object.entries(signed)) headers.set(name, value);
  return true;
}

/**
 * The visitor's headers that are forwarded to the API by default. An allow-list, not a deny-list: what
 * is not named here (`x-forwarded-for`, `x-real-ip`, `cf-*`, `host`, the visitor's own `x-qnsc-edge-*`,
 * hop-by-hop headers, anything a visitor invents) never reaches the API. A product's own headers
 * (a CSRF token, say) go in {@link EdgeForwardOptions.forwardHeaders}.
 */
export const EDGE_FORWARD_HEADERS: readonly string[] = [
  'accept',
  'accept-language',
  'authorization',
  'content-type',
  'cookie',
  'idempotency-key',
  'if-match',
  'if-modified-since',
  'if-none-match',
  'if-unmodified-since',
  'origin',
  'range',
  'referer',
  'traceparent',
  'tracestate',
  'user-agent',
  'x-correlation-id',
  'x-requested-with',
];

export interface EdgeForwardOptions {
  /** `EDGE_CLIENT_IP_SECRET`. */
  secret: string;
  /** Where the request goes: the API's URL for THIS request (host rewritten, path as the API will see it). */
  target: URL | string;
  /** The visitor's address. Defaults to the request's `cf-connecting-ip`. */
  ip?: string | null;
  /** Further visitor headers to forward, on top of {@link EDGE_FORWARD_HEADERS}. */
  forwardHeaders?: readonly string[];
  /** Test seam; see {@link EdgeSignInput.now}. */
  now?: number | Date;
}

/**
 * The Request a Worker should send to the API for `request`:
 *
 * - `redirect: 'manual'`: the API's redirect (identity's `/callback/*` 302 with its `Set-Cookie`) is
 *   handed back to the browser untouched, never followed by the Worker;
 * - only allow-listed visitor headers, plus the signed `x-qnsc-edge-*` trio (signed for the method and
 *   the path of THIS request);
 * - the body streamed through for methods that have one.
 *
 * With no usable visitor address the request is built unsigned (the API falls back to its ordinary
 * order).
 */
export async function edgeForwardRequest(
  request: Request,
  options: EdgeForwardOptions,
): Promise<Request> {
  const target = new URL(options.target.toString());
  const allowed = new Set(
    [...EDGE_FORWARD_HEADERS, ...(options.forwardHeaders ?? [])].map((n) => n.toLowerCase()),
  );

  const headers = new Headers();
  for (const [name, value] of request.headers) {
    if (allowed.has(name.toLowerCase()) && !name.toLowerCase().startsWith(EDGE_HEADER_PREFIX)) {
      headers.append(name, value);
    }
  }
  await applyEdgeClientIp(headers, {
    secret: options.secret,
    ip: options.ip === undefined ? request.headers.get('cf-connecting-ip') : options.ip,
    method: request.method,
    path: target.pathname,
    ...(options.now === undefined ? {} : { now: options.now }),
  });

  const hasBody = request.method !== 'GET' && request.method !== 'HEAD' && request.body !== null;
  return new Request(target, {
    method: request.method,
    headers,
    redirect: 'manual',
    ...(hasBody ? { body: request.body, duplex: 'half' } : {}),
  } as RequestInit);
}

/**
 * `fetch(await edgeForwardRequest(...))`, and nothing more: the response, including a 302 and its
 * `Set-Cookie` headers, goes back to the caller exactly as the API sent it. `fetcher` is a test seam.
 */
export async function forwardToOrigin(
  request: Request,
  options: EdgeForwardOptions,
  fetcher: (request: Request) => Promise<Response> = (r) => fetch(r),
): Promise<Response> {
  return fetcher(await edgeForwardRequest(request, options));
}

export {
  EDGE_HEADER_PREFIX,
  EDGE_IP_HEADER,
  EDGE_MAX_SKEW_SECONDS,
  EDGE_SECRET_MIN_LENGTH,
  EDGE_SIG_HEADER,
  EDGE_TS_HEADER,
} from './edge-protocol';
