import "server-only";

import { sendEmail } from "@/lib/email/send";
import { claimAuthEmailSend, recordAuthEmailAttempt, releaseAuthEmailClaim } from "@/lib/auth-email-audit";
import type { AuthEmailKind } from "@/lib/auth-email-audit";
import { accountConfirmationResendTemplate } from "@/lib/email/templates";
import { recordSystemAlert } from "@/lib/monitoring";
import { supabaseAdmin } from "@/lib/supabase-server";
import { brandedConfirmUrl } from "@/lib/auth-confirm-link";

// ---------------------------------------------------------------------------
// The branded way back for an account that exists but never confirmed.
//
// Shared by /api/auth/signup (which lands here when generateLink reports the
// address is already registered) and /api/auth/resend-confirmation (the
// "Resend confirmation email" button). One implementation, because two copies
// of an enumeration-safe path is two chances to leak.
//
// A SIGNUP link cannot be re-minted for these people: generateLink({ type:
// "signup" }) needs the password and we do not store it. So the resend is a
// MAGIC LINK. Verifying one confirms the address and signs them in, which is
// the outcome they were waiting for anyway.
//
// WHY NOT supabase.auth.resend(). That is what the button used to call, and it
// mails Supabase's own template — the bare <h2>, one sentence and naked <a>
// that Gmail filed as spam on 2026-08-29, stripping the link on the way so the
// recipient saw an email with nothing to click. Re-sending the identical
// message to someone who already failed to receive a usable copy of it is not
// a recovery path.
// ---------------------------------------------------------------------------

interface AdminUserLike {
  id?: string;
  email?: string | null;
  email_confirmed_at?: string | null;
  confirmed_at?: string | null;
  user_metadata?: Record<string, unknown> | null;
}

/**
 * The directory walk's page size and ceiling, for the FALLBACK path only.
 *
 * This used to be 200 × 5: the newest thousand accounts, and "no such user"
 * for everyone older. Past a thousand customers that was a signup for an
 * existing address raising a CRITICAL "no account exists" alert and sending
 * nothing, and the resend button silently doing nothing for the people who
 * most needed it. The direct lookup below is the fix; the walk is what runs
 * where its function has not been applied, and its ceiling is now a safety
 * bound on request time rather than a cap the store will grow into.
 */
const PAGE_SIZE = 1000;
const MAX_PAGES = 200;

type DirectLookup = { outcome: "found"; id: string } | { outcome: "not_found" } | { outcome: "unavailable" };

/**
 * Ask the database for the account directly — sql/auth-user-by-email.sql.
 * "unavailable" (the function is not applied, or the call failed) sends the
 * caller to the directory walk; the other two answers are authoritative.
 */
async function lookupUserIdByEmail(email: string): Promise<DirectLookup> {
  try {
    const { data, error } = await supabaseAdmin.rpc("auth_user_id_by_email", { p_email: email });
    if (error) return { outcome: "unavailable" };
    const id = typeof data === "string" ? data.trim() : "";
    return id ? { outcome: "found", id } : { outcome: "not_found" };
  } catch {
    return { outcome: "unavailable" };
  }
}

/**
 * The account for this address, or null if there genuinely is not one.
 *
 * Used to tell "no such address" apart from "that address exists and something
 * went wrong" — a distinction the enumeration-safe routes cannot make in their
 * RESPONSE but absolutely must make in their TELEMETRY. Conflating the two is
 * how a customer ends up told a link is on its way when nothing was sent and
 * nobody was told.
 *
 * ANY account, not the newest thousand: the direct lookup answers by email,
 * and the admin API then returns the user by id. Only when the lookup itself
 * is unavailable does this walk the directory, and then it walks all of it.
 */
export async function findUserByEmail(email: string): Promise<AdminUserLike | null> {
  const target = email.trim().toLowerCase();
  if (!target) return null;

  const direct = await lookupUserIdByEmail(target);
  if (direct.outcome === "not_found") return null;
  if (direct.outcome === "found") {
    try {
      const { data, error } = await supabaseAdmin.auth.admin.getUserById(direct.id);
      if (!error && data?.user) return data.user as AdminUserLike;
    } catch {
      // Fall through to the walk: the id is real, the fetch was the problem.
    }
  }

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: PAGE_SIZE });
    if (error) return null;
    const users = (data?.users ?? []) as AdminUserLike[];
    const match = users.find((user) => String(user.email ?? "").toLowerCase() === target);
    if (match) return match;
    if (users.length < PAGE_SIZE) return null;
  }
  // Only reachable past MAX_PAGES × PAGE_SIZE accounts with the direct lookup
  // unavailable. Say so, because a silent null here is a false "no account".
  console.error("[auth-confirmation-email] user directory walk hit its ceiling; apply sql/auth-user-by-email.sql");
  return null;
}

/**
 * The unconfirmed account for this address, or null.
 *
 * Returns null for a CONFIRMED account on purpose. Mailing a sign-in link to
 * anyone who types an existing address into a public form would be a nuisance
 * vector even though it grants no access; unconfirmed is the one state where
 * the person is provably stuck.
 */
export async function findUnconfirmedUser(email: string): Promise<AdminUserLike | null> {
  const match = await findUserByEmail(email);
  if (!match) return null;
  return match.email_confirmed_at || match.confirmed_at ? null : match;
}

/** Best-effort first name for the greeting. Never used for anything else. */
function greetingName(fullName: unknown): string {
  return String(fullName ?? "").trim().split(/\s+/)[0] ?? "";
}

/**
 * Hand a send back to Supabase Auth when ours refuses.
 *
 * Strictly additive, the same bargain /api/auth/password-reset strikes: moving
 * a send in-house makes our provider a new single point of failure for account
 * access, so when our path fails we do what the old code did. The customer
 * still gets an email — the plain one — and the operator gets told that
 * branding and bounce visibility are off, because that combination is exactly
 * what stranded four accounts.
 */
export async function fallBackToSupabaseConfirmation(email: string, providerError?: string): Promise<void> {
  try {
    await supabaseAdmin.auth.resend({ type: "signup", email });
  } catch (resendError) {
    console.error("[auth-confirmation-email] supabase fallback send failed", resendError);
  }

  await recordSystemAlert({
    type: "signup_confirmation_provider_failed",
    severity: "warning",
    message:
      "The configured email provider refused a signup confirmation, so it fell back to Supabase Auth's "
      + "own email. Signup still works, but that message is unbranded and invisible to the bounce "
      + "webhook — which is the combination that stranded four accounts on 2026-08-29.",
    context: { providerError: providerError ?? null },
    dedupeWindowMs: 60 * 60 * 1000,
  }).catch(() => {});
}

/**
 * Send a branded magic link to an unconfirmed account. Silent about everything.
 *
 * Returns nothing and throws nothing: every caller answers its client
 * identically whether or not this did anything, so there is no outcome worth
 * reporting upward.
 */
export async function sendBrandedConfirmationResend(
  email: string,
  redirectTo: string,
  /**
   * Debounce against a different key than this function's own kind.
   *
   * The signup route calls this when the address is already registered and
   * unconfirmed — i.e. on a double-click — and that email is, to the customer,
   * the same confirmation the other request just sent. Passing
   * "signup_confirmation" makes the two collide instead of both going out.
   */
  debounceAs?: AuthEmailKind,
): Promise<void> {
  const found = await findUnconfirmedUser(email);
  if (!found) {
    // NOT AN ERROR, BUT NOT NOTHING EITHER.
    //
    // findUnconfirmedUser answers null for a CONFIRMED account, and every
    // account created through Google is confirmed on arrival. So a Google-first
    // customer who fills in the signup form reaches here, no mail is sent, and
    // she is still shown "Check your email." The shared message now points her
    // at the provider route as well, which is the real fix; this line is so that
    // the branch is visible at all, because previously it returned in silence
    // and nothing recorded that a confirmation had been asked for and skipped.
    console.info("[auth] confirmation resend skipped: no unconfirmed user for that address");
    return;
  }

  // ONE PER MINUTE. Three impatient clicks of "resend" used to mint three magic
  // links and send three emails, each carrying a DIFFERENT token — so acting on
  // any but the newest produced "the link doesn't work". The claim is taken
  // before the link is minted, so a losing caller costs nothing.
  //
  // The claim is keyed on `claimedAs`, and so is everything that closes or
  // releases it below. Recording the outcome under this function's own kind
  // while the claim sat under the debounce key left the row at 'sending' for
  // ever on every double-clicked signup.
  const claimedAs: AuthEmailKind = debounceAs ?? "signup_confirmation_resend";
  if (!(await claimAuthEmailSend("signup_confirmation_resend", email, claimedAs))) return;

  const link = await supabaseAdmin.auth.admin.generateLink({
    type: "magiclink",
    email,
    options: { redirectTo },
  });
  if (link.error || !link.data?.properties?.action_link) {
    // Nothing was sent, so the minute's slot goes back — otherwise a customer
    // whose link failed to mint is refused a retry for an email they never got.
    await releaseAuthEmailClaim(claimedAs, email);
    return;
  }

  const template = accountConfirmationResendTemplate({
    name: greetingName(found.user_metadata?.full_name),
    confirmUrl: brandedConfirmUrl({
      hashedToken: link.data.properties.hashed_token,
      type: link.data.properties.verification_type ?? "magiclink",
      next: "/account",
      fallbackActionLink: link.data.properties.action_link,
    }),
  });

  const result = await sendEmail({ to: email, ...template });
  // Logged for the same reason as the first send — see lib/auth-email-audit.ts.
  // A customer who asked for a second link is, by definition, one the first one
  // did not reach, so this is the attempt an operator most needs a record of.
  await recordAuthEmailAttempt({
    kind: "signup_confirmation_resend",
    email,
    success: result.success,
    error: result.error,
    claimedAs,
  });
  if (!result.success) {
    await fallBackToSupabaseConfirmation(email, result.error);
    await recordAuthEmailAttempt({
      kind: "signup_confirmation_supabase_fallback",
      email,
      success: true,
    });
  }
}
