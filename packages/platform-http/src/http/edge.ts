import {
  EDGE_HEADER_PREFIX,
  EDGE_IP_HEADER,
  EDGE_SECRET_MIN_LENGTH,
  EDGE_SIG_HEADER,
  EDGE_TS_HEADER,
  edgeSigningString,
} from './edge-protocol';

/**
 * `@quynhonsemiconductor/platform-http/edge` — the Worker / Pages Function side of the signed edge
 * client IP. WebCrypto and the `Headers` class only: no Node module, so it bundles into a Worker.
 *
 * ```ts
 * import { applyEdgeClientIp } from '@quynhonsemiconductor/platform-http/edge';
 *
 * export default {
 *   async fetch(request: Request, env: { EDGE_CLIENT_IP_SECRET: string }): Promise<Response> {
 *     const target = new URL(request.url);
 *     target.hostname = 'api.qnsc.vn';
 *     const headers = new Headers(request.headers);
 *     await applyEdgeClientIp(headers, {
 *       secret: env.EDGE_CLIENT_IP_SECRET,
 *       ip: request.headers.get('cf-connecting-ip'),
 *       method: request.method,
 *       path: target.pathname, // the path of the request SENT to the API
 *     });
 *     return fetch(new Request(target, { method: request.method, headers, body: request.body }));
 *   },
 * };
 * ```
 */

export interface EdgeSignInput {
  /** At least 32 characters: `EDGE_CLIENT_IP_SECRET`, as a Worker secret. */
  secret: string;
  /** The visitor's address: `cf-connecting-ip` of the request the Worker received. */
  ip: string;
  /** The method of the request the Worker sends to the API. */
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

/** A conservative check that a Worker is not about to sign junk; the API checks strictly. */
function looksLikeIp(value: string): boolean {
  return value.length <= 45 && /^[0-9a-fA-F:.]+$/.test(value) && /[.:]/.test(value);
}

/** The three headers for one request. Rejects an unusable secret or address rather than sign them. */
export async function signEdgeClientIp(input: EdgeSignInput): Promise<EdgeHeaders> {
  if (input.secret.length < EDGE_SECRET_MIN_LENGTH) {
    throw new Error(`The edge secret must be at least ${EDGE_SECRET_MIN_LENGTH} characters.`);
  }
  if (!looksLikeIp(input.ip)) throw new Error('The edge client IP is not an IP address.');
  const nowMs = input.now instanceof Date ? input.now.getTime() : (input.now ?? Date.now());
  const ts = Math.floor(nowMs / 1000);

  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(input.secret),
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
 */
export async function applyEdgeClientIp(
  headers: Headers,
  input: Omit<EdgeSignInput, 'ip'> & { ip: string | null | undefined },
): Promise<boolean> {
  stripEdgeHeaders(headers);
  if (!input.ip || !looksLikeIp(input.ip)) return false;
  const signed = await signEdgeClientIp({ ...input, ip: input.ip });
  for (const [name, value] of Object.entries(signed)) headers.set(name, value);
  return true;
}

export {
  EDGE_HEADER_PREFIX,
  EDGE_IP_HEADER,
  EDGE_MAX_SKEW_SECONDS,
  EDGE_SECRET_MIN_LENGTH,
  EDGE_SIG_HEADER,
  EDGE_TS_HEADER,
} from './edge-protocol';
