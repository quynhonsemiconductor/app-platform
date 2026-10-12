/**
 * Lower-cased domain part of an address, or '' when it has none. An address with more than one `@`
 * (`jane@qnsc.vn@evil.example`) has no domain we can name, so it has none: the part after the FIRST `@`
 * must not be mistaken for it.
 */
export function emailDomain(email: string): string {
  const parts = email.split('@');
  return parts.length === 2 ? (parts[1]?.trim().toLowerCase() ?? '') : '';
}

/** `domains` is one domain or a comma-separated list, as the `sso` plugin stores it. */
export function parseDomains(domains: string | readonly string[] | undefined): string[] {
  const list = typeof domains === 'string' ? domains.split(',') : [...(domains ?? [])];
  return list.map((d) => d.trim().toLowerCase()).filter(Boolean);
}

/** Exact match or sub-domain (`cs.uni.test` is in `uni.test`); a look-alike (`miuni.test`) is not. */
export function domainIn(domain: string, domains: string | readonly string[] | undefined): boolean {
  const d = domain.trim().toLowerCase();
  if (!d) return false;
  return parseDomains(domains).some((allowed) => d === allowed || d.endsWith(`.${allowed}`));
}

export function emailInDomains(
  email: string,
  domains: string | readonly string[] | undefined,
): boolean {
  return domainIn(emailDomain(email), domains);
}

// ── staff domains: exact by default, sub-domains only by an explicit `*.` entry ────────────────────

/** The prefix that opts a `staff.domains` entry into its sub-domains: `*.qnsc.vn`. */
const WILDCARD = '*.';

const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const HOSTNAME = new RegExp(`^${LABEL}(?:\\.${LABEL})*$`);

/** What is wrong with `staff.domains`, or `undefined` when it is usable. Never echoes more than the entry. */
export function staffDomainsProblem(domains: readonly unknown[]): string | undefined {
  for (const entry of domains) {
    if (typeof entry !== 'string') return 'every entry must be a string';
    const value = entry.trim().toLowerCase();
    const wildcard = value.startsWith(WILDCARD);
    const host = wildcard ? value.slice(WILDCARD.length) : value;
    if (!HOSTNAME.test(host)) {
      return `"${entry}" is not a domain name (use "qnsc.vn", or "*.qnsc.vn" for its sub-domains)`;
    }
    if (wildcard && !host.includes('.')) {
      return `"${entry}" would admit a whole top-level domain; a "*." entry needs a registrable domain ("*.qnsc.vn")`;
    }
  }
  return undefined;
}

/** `staff.domains` as it is matched: trimmed, lower-cased, empty entries dropped. */
export function normalizeStaffDomains(domains: readonly string[]): string[] {
  return domains.map((d) => d.trim().toLowerCase()).filter(Boolean);
}

/**
 * Is `domain` a staff domain? An entry matches ITSELF and nothing else (`qnsc.vn` is not `sub.qnsc.vn`);
 * an entry written `*.qnsc.vn` matches the sub-domains of `qnsc.vn` at any depth and NOT `qnsc.vn`
 * itself (list both to admit both). A look-alike (`miqnsc.vn`, `qnsc.vn.evil.example`) matches neither.
 */
export function staffDomainIn(domain: string, entries: readonly string[]): boolean {
  const d = domain.trim().toLowerCase();
  // Not shaped like a host name (an empty label, a trailing dot, a space): it matches nothing.
  if (!HOSTNAME.test(d)) return false;
  return entries.some((entry) =>
    entry.startsWith(WILDCARD) ? d.endsWith(entry.slice(1)) : d === entry,
  );
}

export function staffEmailIn(email: string, entries: readonly string[]): boolean {
  return staffDomainIn(emailDomain(email), entries);
}

/**
 * The domains a staff entry RESERVES: the bare domain, written with or without `*.`. Password sign-up and
 * consumer providers are refused for these AND their sub-domains, wider than the staff match on purpose:
 * an address under the company's own domain must not become a public account because it is not staff.
 */
export function staffReservedDomains(entries: readonly string[]): string[] {
  return entries.map((entry) =>
    entry.startsWith(WILDCARD) ? entry.slice(WILDCARD.length) : entry,
  );
}
