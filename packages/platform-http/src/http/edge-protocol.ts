/**
 * The signed edge client IP: the part both ends share.
 *
 * Behind a Cloudflare Worker or Pages Function, `cf-connecting-ip` may not be the visitor (a
 * subrequest across zones carries a Cloudflare-internal address for EVERYONE), and any plain header the
 * Worker sets is only a header to the API: a caller that reaches the API without the Worker can set it
 * too. So the Worker SIGNS the address it saw, with a secret only it and the API hold, and the API
 * believes the address only if the signature verifies for THIS request.
 *
 * ZERO imports, on purpose: this file is bundled into a Worker, where there is no `node:` anything.
 */

/** Everything under this prefix is the edge's to set; the Worker strips inbound ones, the API ignores unsigned ones. */
export const EDGE_HEADER_PREFIX = 'x-qnsc-edge-';

/** The visitor's address, as the Worker saw it in `cf-connecting-ip`. */
export const EDGE_IP_HEADER = 'x-qnsc-edge-ip';
/** When it was signed, in whole seconds since the epoch. */
export const EDGE_TS_HEADER = 'x-qnsc-edge-ts';
/** `base64url(HMAC-SHA256(secret, "ts|ip|METHOD|path"))`, 43 characters. */
export const EDGE_SIG_HEADER = 'x-qnsc-edge-sig';

/** How far the signature's timestamp may be from the verifier's clock, either way, in seconds. */
export const EDGE_MAX_SKEW_SECONDS = 60;

/** A secret shorter than this is refused: it is a key, not a password. */
export const EDGE_SECRET_MIN_LENGTH = 32;

/**
 * The path as it is signed: the path of the request the API receives, without the query string or
 * fragment. The Worker signs the path of the request it SENDS to the API (after any rewrite), and the
 * API reads the path it was sent, so both ends see the same string. A query string is left out on
 * purpose: proxies and CDNs reorder and re-encode it, and nothing the signature protects (who the
 * visitor is) depends on it.
 */
export function edgePath(raw: string): string {
  const end = raw.search(/[?#]/);
  const path = end === -1 ? raw : raw.slice(0, end);
  return path === '' ? '/' : path;
}

/**
 * What is signed: `ts|ip|METHOD|path`. Binding the method and the path means a signed header lifted from
 * one request cannot be replayed on another; binding the timestamp bounds replay of the SAME request to
 * {@link EDGE_MAX_SKEW_SECONDS}; binding the address means it cannot be swapped for another.
 */
export function edgeSigningString(ts: number, ip: string, method: string, path: string): string {
  return `${ts}|${ip}|${method.toUpperCase()}|${edgePath(path)}`;
}
