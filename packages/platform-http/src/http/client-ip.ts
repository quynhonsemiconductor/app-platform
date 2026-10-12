import { isIP } from 'node:net';
import {
  edgeConfigFromEnv,
  reportEdgeRejection,
  verifyEdgeClientIp,
  type EdgeConfig,
} from './edge-client-ip';

/**
 * The slice of a request {@link clientIp} reads. Structural on purpose, so a Fastify
 * request, a raw Node `IncomingMessage` and a test fake all fit without a cast.
 */
export interface ClientIpRequest {
  headers?: Record<string, string | string[] | undefined>;
  /** Fastify's resolved address (honours `trustProxy`). Used only as the last fallback. */
  ip?: string;
  socket?: { remoteAddress?: string };
  /** With `url`, what a signed edge client IP is verified against (`EDGE_CLIENT_IP_SECRET`). */
  method?: string;
  url?: string;
}

export interface ClientIpOptions {
  /** Test seam: the edge configuration, instead of the environment's. `false` forces it off. */
  edge?: EdgeConfig | false;
  /** Test seam: the current time, in milliseconds. */
  now?: number;
}

/** What {@link clientIp} returns when no source yields an address. */
export const UNKNOWN_CLIENT_IP = 'unknown';

function firstHeader(req: ClientIpRequest, name: string): string | undefined {
  const value = req.headers?.[name];
  return Array.isArray(value) ? value[0] : value;
}

/** A trimmed value if (and only if) it is a literal IPv4/IPv6 address. */
function asIp(value: string | undefined): string | undefined {
  const candidate = value?.trim();
  return candidate && isIP(candidate) !== 0 ? candidate : undefined;
}

/**
 * The visitor's address from a SIGNED edge header, when the feature is on (`EDGE_CLIENT_IP_SECRET`
 * set) and the signature verifies for this request. A refused one is counted and ignored.
 */
function signedEdgeIp(req: ClientIpRequest, options: ClientIpOptions): string | undefined {
  const config = options.edge === undefined ? edgeConfigFromEnv() : options.edge || undefined;
  if (!config) return undefined;
  return verifyEdgeClientIp(req, config, Math.floor((options.now ?? Date.now()) / 1000), (reason) =>
    reportEdgeRejection(reason),
  );
}

/**
 * The address of the original client, for access logs and rate-limit keys.
 *
 * Order: a verified signed edge address (only when `EDGE_CLIENT_IP_SECRET` is set) →
 * `cf-connecting-ip` → first `x-forwarded-for` entry → socket address.
 *
 * **Behind a Cloudflare Worker or Pages Function** `cf-connecting-ip` can be a Cloudflare-internal
 * address shared by every user, and an unsigned header the Worker sets is just a header any caller could
 * set. The Worker signs the address instead (`@quynhonsemiconductor/platform-http/edge`): the signature
 * covers the address, the timestamp, the method and the path, so it cannot be forged, swapped for
 * another address, moved to another request or replayed after a minute.
 *
 * Behind Cloudflare Tunnel the origin sees only `cloudflared`'s address, and
 * `x-forwarded-for` is appended to by every hop — its first entry is whatever the client
 * chose to send. `cf-connecting-ip` is set by Cloudflare's edge, overwriting anything the
 * client supplied, so when it is present a forged `x-forwarded-for` is ignored.
 *
 * **Assumption.** `cf-connecting-ip` is only authoritative when the pods are reachable
 * *only* through the Cloudflare Tunnel and the gateway behind it — no public listener, no
 * `NodePort`, no other route in. A pod that something else can reach directly lets that
 * caller choose its own address and so pick its own rate-limit bucket. That is a property
 * of the deployment, not of this function, and nothing here can check it.
 *
 * A header value that is not a literal IP address is skipped, never used: it ends up in
 * Redis keys and log lines, and a header is attacker-controlled text.
 */
export function clientIp(req: ClientIpRequest, options: ClientIpOptions = {}): string {
  return (
    signedEdgeIp(req, options) ??
    asIp(firstHeader(req, 'cf-connecting-ip')) ??
    asIp(firstHeader(req, 'x-forwarded-for')?.split(',')[0]) ??
    req.socket?.remoteAddress ??
    req.ip ??
    UNKNOWN_CLIENT_IP
  );
}
