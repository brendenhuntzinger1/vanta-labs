// ---------------------------------------------------------------------------
// Which GoTrue link fragments mean "this person is here to set a password".
//
// Deliberately NOT server-only: both halves of the password-setup path are
// client components, and they used to carry two hand-copied predicates that
// disagreed. Shared here so the catcher and the form cannot drift apart, and so
// the predicate itself is exercised by tests rather than asserted as source
// text.
//
// TWO TYPES, NOT ONE (the affiliate half of the 2026-08-29 signup alert).
//
// `recovery` is a password reset. `invite` is an admin invite issued by
// createPartnerInvite -> auth.admin.inviteUserByEmail, and it is the ONLY way
// an invited ambassador can ever get a password: that call creates the auth
// user with `encrypted_password` NULL, so there is nothing to sign in with
// until they set one.
//
// Accepting only `recovery` made the invite a dead end at every hop — the
// catcher would not carry the fragment, and the form would not unlock for it —
// so an invited ambassador had no route into the partner portal at all. In
// production that was ambassador ZAIN: invited 2026-08-23, approved an hour
// later with a live referral code, and still `email_confirmed_at IS NULL`,
// `last_sign_in_at IS NULL`, no password, six days on.
//
// Nothing else is accepted. `signup` in particular is NOT a password-setup
// link: a confirmation redirect carries an `access_token` like the others, and
// treating it as one would hand a no-current-password form to anyone who just
// confirmed an email — the exact widening audit E2 closed.
// ---------------------------------------------------------------------------

/** Fragment types that legitimately unlock a "choose a password" form. */
export type PasswordSetupLinkType = "recovery" | "invite";

const PASSWORD_SETUP_TYPES: readonly string[] = ["recovery", "invite"];

/**
 * The password-setup type carried by a URL fragment, or null if it is not one.
 *
 * Parsed rather than substring-matched: `#type=magiclink&next=/recovery` and
 * `#type=not-recovery` both contain the word and are not recovery links.
 */
export function passwordSetupLinkType(hash: string): PasswordSetupLinkType | null {
  if (!hash) return null;
  const params = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
  const type = params.get("type");
  if (type && PASSWORD_SETUP_TYPES.includes(type)) {
    return type as PasswordSetupLinkType;
  }
  return null;
}

/** Whether a fragment should unlock the set-a-password form. */
export function isPasswordSetupLink(hash: string): boolean {
  return passwordSetupLinkType(hash) !== null;
}

/**
 * Whether a fragment is a password-setup link that actually carries a session.
 *
 * The catcher uses this: a `type=` marker with no token is nothing to forward,
 * and following it would send someone to a form that cannot work.
 */
export function isActionablePasswordSetupLink(hash: string): boolean {
  if (!isPasswordSetupLink(hash)) return false;
  const params = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
  return Boolean(params.get("access_token"));
}
