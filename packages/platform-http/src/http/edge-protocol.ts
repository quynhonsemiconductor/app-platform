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
 * The secret as BOTH ends use it: trimmed. A secret pasted into a Worker secret or an env file often
 * carries a trailing newline; the two ends must treat it the same way, or every signature is a
 * `bad_signature` and the API silently falls back to the shared address.
 */
export function normalizeEdgeSecret(secret: string): string {
  return secret.trim();
}

/** The method as it is signed, upper-cased, or `undefined` if it is not letters only. */
export function edgeMethod(method: string): string | undefined {
  return /^[A-Za-z]+$/.test(method) ? method.toUpperCase() : undefined;
}

/**
 * Whether `ip` is shaped like an address: only hex digits, `.` and `:`, with at least one `.` or `:`,
 * at most 45 characters. This is NOT validation (the API checks with `isIP`); it is what makes the
 * signing string unambiguous: it can contain no `|`.
 */
export function isEdgeIpText(ip: string): boolean {
  return ip.length <= 45 && /^[0-9a-fA-F:.]+$/.test(ip) && /[.:]/.test(ip);
}

/**
 * What is signed: `ts|ip|METHOD|path`. Binding the method and the path means a signed header lifted from
 * one request cannot be replayed on another; binding the timestamp bounds replay of the SAME request to
 * {@link EDGE_MAX_SKEW_SECONDS}; binding the address means it cannot be swapped for another.
 *
 * Injective: `ts` is digits, `ip` is hex digits, `.` and `:`, and `METHOD` is letters, so none of them
 * can contain the `|` separator, and everything after the third `|` is the path whatever it holds. Two
 * different (ts, ip, method, path) can therefore never produce the same string. Anything that would
 * break that throws, on both ends, rather than being signed.
 */
export function edgeSigningString(ts: number, ip: string, method: string, path: string): string {
  const upper = edgeMethod(method);
  if (upper === undefined) throw new RangeError('The edge method must be letters only.');
  if (!Number.isSafeInteger(ts) || ts < 0)
    throw new RangeError('The edge timestamp is not a time.');
  if (!isEdgeIpText(ip)) throw new RangeError('The edge address is not shaped like an IP address.');
  return `${ts}|${ip}|${upper}|${edgePath(path)}`;
}
