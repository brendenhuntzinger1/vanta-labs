import type { User } from "@supabase/supabase-js";

// ---------------------------------------------------------------------------
// WHETHER AN ACCOUNT HAS A PASSWORD AT ALL.
//
// It is easy to assume every account does, because until the portal added
// Google every one of them did — all 41 identities on the live project are
// `email`. An account created through a provider has no password identity, and
// two security controls were built on the assumption that one always exists:
//
//   api/account/change-password  re-authenticates with signInWithPassword
//   api/account/email-change     re-authenticates with signInWithPassword
//
// For a provider account both calls can only ever fail, so both answered
// "Current password is incorrect." — a statement that is not merely unhelpful
// but false, about a password the customer never had. The password card asks
// for a current password it is impossible to supply, and the email card refuses
// client-side before it even sends. There was no route out of either in the
// app, so the real answer was a support ticket.
//
// THE FIX IS NOT TO WEAKEN THE GATES. email-change's own header explains, at
// length, that its password check is what stops a hijacked open session from
// taking the account outright, and an email takeover survives the real owner
// changing their password back. That reasoning does not stop applying to
// provider accounts.
//
// So the product answer is a sequence rather than an exemption: an account with
// no password can SET one (which is Supabase's own documented way to add
// email+password login to an OAuth account, and cannot be a "change" gate
// because there is nothing to change), and once it has one, every existing
// control works exactly as written, for everybody, unaltered.
// ---------------------------------------------------------------------------

/** GoTrue's provider name for an email + password identity. */
const PASSWORD_PROVIDER = "email";

/**
 * Whether this account can be asked for a current password.
 *
 * Absent identities means "cannot tell" and is answered TRUE deliberately: the
 * callers use this to decide whether to RELAX a security check, so the unknown
 * case must keep the check rather than drop it. A caller that needs certainty
 * should load the user through the admin API, which always populates them.
 */
export function hasPasswordIdentity(user: Pick<User, "identities"> | null | undefined): boolean {
  const identities = user?.identities;
  if (!Array.isArray(identities) || identities.length === 0) return true;
  return identities.some((identity) => identity.provider === PASSWORD_PROVIDER);
}

/**
 * The providers an account can currently sign in with, for display.
 *
 * Used to tell someone which door they came in by, on their own settings page,
 * where they are already authenticated — this is never exposed for an address
 * that has not proven it owns the session, because that would be an
 * account-enumeration oracle.
 */
export function signInProviders(user: Pick<User, "identities"> | null | undefined): string[] {
  const identities = user?.identities;
  if (!Array.isArray(identities)) return [];
  return [...new Set(identities.map((identity) => identity.provider).filter(Boolean))];
}
