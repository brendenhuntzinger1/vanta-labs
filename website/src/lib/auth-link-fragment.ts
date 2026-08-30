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

// ---------------------------------------------------------------------------
// WHAT A CONFIRMATION RETURN ACTUALLY CARRIES.
//
// /auth/confirm forwards a verified signup to /account/login?verified=1, and
// GoTrue appends the session as a URL FRAGMENT. The query param and the
// fragment are two different things, and the login page used to treat the
// query param alone as proof that a token had arrived:
//
//     const [isVerificationReturn] = useState(() =>
//       searchParams.get("verified") === "1" || hash.includes("access_token="));
//
// `?verified=1` is typed, shared, bookmarked and re-opened. On any of those
// loads the fragment is empty, `getSession()` falls back to the session
// supabase-js keeps in localStorage, and the page promoted THAT into an
// httpOnly cookie and redirected — signing the visitor in as whoever last used
// the browser. Reachable in practice because our cookie lapses hourly while the
// localStorage session refreshes itself for weeks: A's cookie expires, A's
// browser session survives, B opens their own confirmation link on the shared
// machine, B's one-time token is already spent, and B lands as A.
//
// The other half is the same fragment read for the opposite reason. When a
// token is spent or expired GoTrue does not send tokens — it redirects with
// `#error=access_denied&error_code=otp_expired`. Nothing read that, so the
// branch fell through to a bare `return` and the customer was left on an
// ordinary, unannotated sign-in form with no idea what had happened and nothing
// offering a new link. Not a rare branch: mailbox security scanners pre-fetch
// links and burn them, which is what happened to the applicant of 2026-08-28
// whose auth log reads "One-time token not found".
//
// So the fragment is classified once, at first render, before supabase-js can
// consume it (the browser client is lazily constructed on first `supabase.auth`
// access, which happens later, inside an effect).
// ---------------------------------------------------------------------------

export type AuthReturnKind =
  /** A real session arrived in the fragment. Safe to establish a cookie. */
  | "session"
  /** GoTrue reported a dead link. Say so, and offer a new one. */
  | "error"
  /** Nothing arrived. Never sign anyone in on this. */
  | "none";

export interface AuthReturn {
  kind: AuthReturnKind;
  /** GoTrue's `error_code`, when it sent one (e.g. "otp_expired"). */
  errorCode?: string;
}

/** Fragment markers that mean a session really is present. */
const SESSION_MARKERS = ["access_token", "refresh_token"] as const;

/**
 * Classify the URL fragment of a return from an emailed auth link.
 *
 * Parsed, never substring-matched: `#error_description=your+access_token+is...`
 * contains the marker and carries no session.
 */
export function classifyAuthReturn(hash: string): AuthReturn {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!raw) return { kind: "none" };

  const params = new URLSearchParams(raw);

  // Error first. A fragment can carry both an error and a stale token, and the
  // error is the thing the customer needs to be told about.
  const errorCode = params.get("error_code") ?? params.get("error");
  if (errorCode) {
    return { kind: "error", errorCode };
  }

  for (const marker of SESSION_MARKERS) {
    if (params.get(marker)) return { kind: "session" };
  }

  return { kind: "none" };
}

/**
 * The message to show for a dead confirmation link.
 *
 * Every branch names a next step, because the failure this whole change exists
 * to fix was a customer staring at a page that told them nothing.
 */
export function deadAuthLinkMessage(errorCode?: string): string {
  const code = String(errorCode ?? "").toLowerCase();
  if (code === "otp_expired" || code === "expired_token") {
    return "That confirmation link has expired. Enter your email below and we'll send you a fresh one.";
  }
  if (code === "access_denied") {
    return "That confirmation link has already been used. If you haven't signed in yet, enter your email below and we'll send you a new one.";
  }
  return "We couldn't complete that confirmation link. Enter your email below and we'll send you a new one.";
}
