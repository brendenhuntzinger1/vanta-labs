// ---------------------------------------------------------------------------
// What to show after supabase.auth.signUp() comes back.
//
// Supabase answers a signup for an ALREADY REGISTERED address with a success
// response carrying an obfuscated user and an empty `identities` array - and it
// sends no email at all. That is deliberate: branching the UI on that signal
// would turn the signup form into an account-enumeration oracle.
//
// The trap is what the UI then says. Telling everyone "we've sent you a link"
// is only true for new addresses; for a returning user it is a promise the
// system never keeps, and they wait on an inbox nothing was sent to. That is
// not hypothetical - it cost a real ambassador applicant a full day of retries
// before anyone noticed.
//
// So the outcome is IDENTICAL for both cases (no enumeration signal), and the
// single shared message is written to be true for both: it points a new user at
// their inbox and a returning user at sign-in and password reset, without
// revealing which of the two they are.
// ---------------------------------------------------------------------------

export const SIGNUP_CHECK_EMAIL_MESSAGE =
  "Check your email. If this address is new, a link is waiting there to finish setting up your account. " +
  "If you already have an account, sign in instead — or use “Forgot your password?” to reset it.";

export type SignupOutcome =
  | { kind: "session"; accessToken: string }
  | { kind: "check-email"; message: string }
  | { kind: "failed" };

/** The shape we care about from supabase.auth.signUp()'s `data`. */
export interface SignupResponseData {
  user: { id?: string; email?: string | null; identities?: unknown[] | null } | null;
  session: { access_token?: string | null } | null;
}

export function resolveSignupOutcome(data: SignupResponseData | null | undefined): SignupOutcome {
  if (!data?.user) {
    return { kind: "failed" };
  }

  const accessToken = data.session?.access_token;
  if (accessToken) {
    return { kind: "session", accessToken };
  }

  // NOTE: `data.user.identities` distinguishes new from existing here, and we
  // deliberately do NOT read it. Both paths return the same value so the
  // response cannot be used to probe which addresses have accounts.
  return { kind: "check-email", message: SIGNUP_CHECK_EMAIL_MESSAGE };
}
