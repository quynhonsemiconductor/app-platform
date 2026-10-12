import { decodeJwt } from 'jose';
import { google } from 'better-auth/social-providers';
import { refuseCallbackWith, rememberStaffSignIn, validRoles } from './callback-errors';
import { normalizeStaffDomains, staffEmailIn } from './domains';
import type { IdentityLogger, SecurityEvent } from './events';

export interface StaffOptions {
  /** The QNSC Entra tenant id. */
  tenantId: string;
  clientId: string;
  clientSecret: string;
  /**
   * Email domain(s) of staff: password sign-up is refused for them (ADR 0002, decision 2), and a tenant
   * member is admitted only with an address on one. **Each entry matches exactly that domain**:
   * `qnsc.vn` admits `jane@qnsc.vn` and not `jane@sub.qnsc.vn`. Sub-domains are an explicit opt-in:
   * `*.qnsc.vn` admits `sub.qnsc.vn` and `a.b.qnsc.vn` but not `qnsc.vn` itself, so list both to admit
   * both. A `*.` entry needs a registrable domain (`*.vn` is refused). Sub-domains of an entry stay
   * RESERVED either way (password and consumer-provider sign-up is refused for them): a sub-domain
   * that is not staff has no way in, rather than becoming a public account.
   */
  domains: string[];
  /**
   * May B2B GUESTS of the tenant sign in? Product policy, default `false` (ADR 0002, decision 3):
   * rova sets `true` for vendors; opshub keeps `false`.
   */
  allowGuests?: boolean;
  /**
   * Must a tenant MEMBER's user principal name be on a `staff.domains` entry, as the `email` claim must?
   * Default `true`. An Entra UPN suffix has to be a domain the tenant has verified, so this holds the
   * member to the company's own domain on a claim the `email` attribute (which an administrator, or a
   * recycled mailbox, can point at anyone) cannot stand in for. Read from `upn`, else `preferred_username`
   * (present in v2 id_tokens under the `profile` scope); with neither, the sign-in is refused. Set `false`
   * only if your members' UPNs are not on a staff domain (`*.onmicrosoft.com`, say), and say why.
   * Guests are exempt: their UPN is `name_domain#EXT#@tenant`.
   */
  requireUpnOnStaffDomain?: boolean;
  /** Only for tests or a sovereign cloud. Default `https://login.microsoftonline.com`. */
  authority?: string;
}

export interface GoogleOptions {
  clientId: string;
  clientSecret: string;
}

/** Called with an address a provider has just asserted as verified. */
export type VerifiedEmailHook = (email: string) => Promise<unknown>;

/** The existing account for an address, if any, with the provider ids and account ids it holds. */
export type AccountLookup = (email: string) => Promise<{
  user?: { id: string };
  accounts: Array<{ providerId: string; accountId: string }>;
} | null>;

/** The claim a member's UPN is read from: `upn` if the app registration emits it, else `preferred_username`. */
function upnClaim(claims: Record<string, unknown>): string | undefined {
  return [claims['upn'], claims['preferred_username']].find(
    (v): v is string => typeof v === 'string' && v.includes('@'),
  );
}

/**
 * The domain part of the UPN, lower-cased, for diagnosis: only when it looks like a host name (so nothing
 * odd is ever logged), at most 100 characters. Never the part before the `@`.
 */
function upnSuffix(claims: Record<string, unknown>): string | undefined {
  const upn = upnClaim(claims);
  const suffix = upn?.split('@').pop()?.trim().toLowerCase();
  return suffix && suffix.length <= 100 && /^[a-z0-9.-]+$/.test(suffix) ? suffix : undefined;
}

/** The member's user principal name: `upn` if the app registration emits it, else `preferred_username`. */
function upnOnStaffDomain(
  claims: Record<string, unknown>,
  staffDomains: readonly string[],
): boolean {
  const candidate = upnClaim(claims);
  return candidate !== undefined && staffEmailIn(candidate, staffDomains);
}

/**
 * Whether an Entra id_token is for a B2B guest. Entra marks guests in more than one way depending on
 * the app registration's optional claims, so any of them counts: `acct = 1`, an `idp` claim naming a
 * different issuer than the token's, or `#EXT#` in the user principal name. (Manual check M1 in
 * ADR 0002 confirms which of these the QNSC tenant emits.)
 */
export function isEntraGuest(claims: Record<string, unknown>): boolean {
  if (claims['acct'] === 1 || claims['acct'] === '1') return true;
  const idp = claims['idp'];
  if (typeof idp === 'string' && idp !== claims['iss']) return true;
  return [claims['upn'], claims['preferred_username']].some(
    (v) => typeof v === 'string' && v.includes('#EXT#'),
  );
}

/**
 * Microsoft provider for the staff preset. It replaces Better Auth's `getUserInfo` for these reasons
 * (WP-9 D12, review S3): the default asks for `User.Read` and fetches a Graph photo; in the code flow it
 * never checks `tid`; it knows nothing of B2B guests; and it would link an Entra identity to ANY
 * existing account with the same email.
 *
 * - A tenant MEMBER is accepted only with an email whose domain is in `staff.domains`; anything else
 *   (a member whose mailbox is on another domain, a mail alias, an unexpected claim) returns `null`, so no
 *   account is created or linked on an address the company does not own. The squatting rule runs for
 *   members only.
 * - A MEMBER whose user principal name is not on `staff.domains` is refused too (`requireUpnOnStaffDomain`, on by
 *   default).
 * - A MEMBER never links to an existing user that already holds a DIFFERENT Microsoft identity (`oid`): that
 *   is refused with `MICROSOFT_IDENTITY_CHANGED`, audited as `account.microsoft_link_refused`, and writes
 *   nothing. A relink is an explicit administrator operation (`unlinkMicrosoftAccount`).
 * - A GUEST (when `allowGuests`) never auto-links: if the address belongs to an existing account that
 *   does not already hold THIS Entra identity, the sign-in is refused with `ACCOUNT_LINK_REQUIRED`.
 *   Guests are created with an unverified email, so Better Auth refuses to link them even in a race.
 *
 * Returning `null` ends the callback with an error redirect and writes nothing.
 */
export function microsoftProvider(
  staff: StaffOptions,
  hooks: {
    onVerifiedEmail: VerifiedEmailHook;
    lookup: AccountLookup;
    emit?: (event: SecurityEvent) => Promise<void>;
    /** Is there already an account for this Microsoft identity (`oid`)? Its owner is signed in normally. */
    knownIdentity?: (oid: string) => Promise<boolean>;
    logger?: IdentityLogger;
  },
) {
  const staffDomains = normalizeStaffDomains(staff.domains);
  const requireUpn = staff.requireUpnOnStaffDomain ?? true;
  return {
    clientId: staff.clientId,
    clientSecret: staff.clientSecret,
    tenantId: staff.tenantId,
    ...(staff.authority ? { authority: staff.authority } : {}),
    disableDefaultScope: true,
    scope: ['openid', 'profile', 'email'],
    disableProfilePhoto: true,
    // Authorization-code flow only. The id_token sign-in (`signInSocial({ idToken })`) takes ANY token that
    // is valid for this client id, with no nonce binding, and never runs the claims through the product's
    // `onStaffSignIn`: it would mint a session around the hook.
    disableIdTokenSignIn: true,
    getUserInfo: async (token: { idToken?: string | undefined }) => {
      if (!token.idToken) return null;
      const claims = decodeJwt(token.idToken) as Record<string, unknown>;
      if (claims['tid'] !== staff.tenantId) return null;
      const { oid, email } = claims;
      if (typeof oid !== 'string' || typeof email !== 'string') return null;

      const guest = isEntraGuest(claims);
      if (guest && !(staff.allowGuests ?? false)) return null;
      if (!guest && !staffEmailIn(email, staffDomains)) return null;
      if (!guest && requireUpn && !upnOnStaffDomain(claims, staffDomains)) {
        // Names the problem the admin has to fix: the UPN SUFFIX (a domain, never the person), in the
        // redirect code, an event and a log line. The `email` check above stays generic.
        const suffix = upnSuffix(claims);
        refuseCallbackWith('UPN_NOT_ON_STAFF_DOMAIN');
        await hooks.emit?.({
          name: 'staff.upn_refused',
          detail: {
            reason: suffix === undefined ? 'absent' : 'suffix_not_staff',
            suffix: suffix ?? '',
          },
        });
        hooks.logger?.warn(
          suffix === undefined
            ? 'A staff sign-in was refused: the id_token carries no UPN (upn / preferred_username).'
            : `A staff sign-in was refused: its UPN suffix "${suffix}" is not on staff.domains. Add it, or set staff.requireUpnOnStaffDomain: false.`,
          { code: 'identity.upn_not_on_staff_domain' },
        );
        return null;
      }

      if (guest) {
        const existing = await hooks.lookup(email);
        const sameIdentity = existing?.accounts.some(
          (a) => a.providerId === 'microsoft' && a.accountId === oid,
        );
        if (existing && !sameIdentity) {
          refuseCallbackWith('ACCOUNT_LINK_REQUIRED');
          return null;
        }
      } else {
        // The `email` claim is an attribute, not a person: a recycled mailbox, or anyone who can edit `mail`,
        // gives a DIFFERENT Entra object the address of an existing user. Better Auth would link that second
        // identity to the user and sign it in as them. An existing user who already holds a Microsoft
        // identity is only ever signed in by THAT identity; a new one is refused (nothing written), and an
        // administrator relinks on purpose with `unlinkMicrosoftAccount`.
        //
        // EXCEPT an identity that already has its own account: Better Auth signs in the OWNER of
        // (microsoft, oid) whatever address the token carries, so a known oid is never refused because
        // its address now matches someone else's (the recycled-mailbox case works for the person who
        // really is that oid).
        const known = (await hooks.knownIdentity?.(oid)) === true;
        const existing = known ? null : await hooks.lookup(email);
        const microsoft = existing?.accounts.filter((a) => a.providerId === 'microsoft') ?? [];
        if (existing && microsoft.length > 0 && !microsoft.some((a) => a.accountId === oid)) {
          refuseCallbackWith('MICROSOFT_IDENTITY_CHANGED');
          await hooks.emit?.({
            name: 'account.microsoft_link_refused',
            ...(existing.user ? { userId: existing.user.id } : {}),
            detail: { reason: 'different_oid' },
          });
          return null;
        }
        // Tenant membership is the verification: Entra issues no `email_verified`.
        await hooks.onVerifiedEmail(email);
      }
      // Every check has passed: keep what the token said for the product's `onStaffSignIn`, which runs
      // when this sign-in's session is created (staff-session.ts), once the user exists.
      rememberStaffSignIn({
        oid,
        tid: staff.tenantId,
        email,
        guest,
        roles: validRoles(claims['roles']),
      });
      return {
        user: {
          id: oid,
          name: typeof claims['name'] === 'string' ? claims['name'] : email,
          email,
          emailVerified: !guest,
        },
        data: claims,
      };
    },
  } as never;
}

/**
 * Google, for the public preset (review S4). Mirrors rule 1: an address on a staff domain or a
 * verified SSO domain belongs to the company sign-in, so a consumer Google account asserting it is
 * refused (`null`), exactly as password sign-up is. Otherwise the squatting rule applies to addresses
 * Google reports as verified.
 */
export function googleProvider(
  options: GoogleOptions,
  hooks: { onVerifiedEmail: VerifiedEmailHook; isReserved: (email: string) => Promise<boolean> },
) {
  const base = google(options);
  return {
    ...options,
    // Authorization-code flow only, like Microsoft: `signInSocial({ idToken })` verifies a token
    // that is valid for this client id, with no nonce binding, and mints a session from it. With it
    // enabled `/sign-in/social` would take a credential; disabled, it only returns the provider's URL.
    disableIdTokenSignIn: true,
    getUserInfo: async (token: Parameters<typeof base.getUserInfo>[0]) => {
      const info = await base.getUserInfo(token);
      if (!info?.user.email) return info;
      if (await hooks.isReserved(info.user.email)) return null;
      if (info.user.emailVerified) await hooks.onVerifiedEmail(info.user.email);
      return info;
    },
  } as never;
}
