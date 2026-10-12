import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Better Auth's OAuth callback has one generic failure for "the provider's answer is not acceptable"
 * (`error=unable_to_get_user_info`) and no way for a custom `getUserInfo` to say WHY. This carries a
 * specific code from `getUserInfo` to the response of the same request, so the browser lands on
 * `?error=ACCOUNT_LINK_REQUIRED` and the product can tell the user what to do.
 */
const store = new AsyncLocalStorage<{
  code?: string;
  staffSignIn?: StaffSignInClaims;
  createdUsers?: Set<string>;
}>();

/**
 * What the Microsoft id_token of a staff sign-in said, validated. `roles` is the Entra App Roles claim:
 * always an array of strings, empty when the token carries none.
 */
export interface StaffSignInClaims {
  /** The Entra object id: the stable identity of the person in the tenant. */
  oid: string;
  tid: string;
  email: string;
  /**
   * Whether the token is for a B2B GUEST of the tenant (Entra marks guests with `acct = 1`, an `idp`
   * that is not the issuer, or `#EXT#` in the user principal name). Only ever `true` when the product
   * set `staff.allowGuests`; otherwise guests are refused before the hook.
   */
  guest: boolean;
  roles: string[];
}

/** An App Roles claim as a bounded, de-duplicated `string[]`; anything that is not an array of strings is `[]`. */
export function validRoles(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const roles = new Set<string>();
  for (const role of value) {
    if (typeof role === 'string' && role.length > 0 && role.length <= 256) roles.add(role);
    if (roles.size >= 200) break;
  }
  return [...roles];
}

/**
 * Called from inside the Microsoft provider's `getUserInfo`, once the token has passed every check:
 * keeps the claims for the rest of THIS request, until the session of this sign-in is created.
 */
export function rememberStaffSignIn(claims: StaffSignInClaims): void {
  const slot = store.getStore();
  if (slot) slot.staffSignIn = claims;
}

/** The claims of the staff sign-in running in this request, once: taking them clears them. */
export function takeStaffSignIn(): StaffSignInClaims | undefined {
  const slot = store.getStore();
  const claims = slot?.staffSignIn;
  if (slot) delete slot.staffSignIn;
  return claims;
}

/**
 * Called from `databaseHooks.user.create.after`: this request created this user. Kept only for the
 * request, so that a refused staff sign-in can tell "a user this very sign-in created" (and remove it)
 * from "a user that was already there" (never touched).
 */
export function rememberCreatedUser(userId: string): void {
  const slot = store.getStore();
  if (!slot) return;
  (slot.createdUsers ??= new Set()).add(userId);
}

/** Whether THIS request created `userId`. False outside a request handled by the identity handler. */
export function wasCreatedInThisRequest(userId: string): boolean {
  return store.getStore()?.createdUsers?.has(userId) === true;
}

/** Called from inside a provider's `getUserInfo`: refuse this sign-in with `code`. */
export function refuseCallbackWith(code: string): void {
  const slot = store.getStore();
  if (slot) slot.code = code;
}

export function withCallbackErrorCodes(
  handler: (request: Request) => Promise<Response>,
): (request: Request) => Promise<Response> {
  return (request) =>
    store.run({}, async () => {
      const response = await handler(request);
      const code = store.getStore()?.code;
      const location = response.headers.get('location');
      if (!code || !location || response.status < 300 || response.status > 399) return response;
      const url = new URL(location, request.url);
      if (!url.searchParams.has('error')) return response;
      url.searchParams.set('error', code);
      const headers = new Headers(response.headers);
      headers.set(
        'location',
        location.startsWith('/') ? `${url.pathname}${url.search}` : url.toString(),
      );
      return new Response(null, { status: response.status, headers });
    });
}
