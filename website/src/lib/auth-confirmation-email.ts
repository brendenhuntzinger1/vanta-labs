import "server-only";

import { sendEmail } from "@/lib/email/send";
import { accountConfirmationResendTemplate } from "@/lib/email/templates";
import { recordSystemAlert } from "@/lib/monitoring";
import { supabaseAdmin } from "@/lib/supabase-server";

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

/** Bound on how many users to inspect, so this can never become a long request. */
const PAGE_SIZE = 200;
const MAX_PAGES = 5;

/**
 * The unconfirmed account for this address, or null.
 *
 * Returns null for a CONFIRMED account on purpose. Mailing a sign-in link to
 * anyone who types an existing address into a public form would be a nuisance
 * vector even though it grants no access; unconfirmed is the one state where
 * the person is provably stuck.
 */
export async function findUnconfirmedUser(email: string): Promise<AdminUserLike | null> {
  const target = email.trim().toLowerCase();
  if (!target) return null;

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: PAGE_SIZE });
    if (error) return null;
    const users = (data?.users ?? []) as AdminUserLike[];
    const match = users.find((user) => String(user.email ?? "").toLowerCase() === target);
    if (match) {
      return match.email_confirmed_at || match.confirmed_at ? null : match;
    }
    if (users.length < PAGE_SIZE) return null;
  }
  return null;
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
export async function sendBrandedConfirmationResend(email: string, redirectTo: string): Promise<void> {
  const found = await findUnconfirmedUser(email);
  if (!found) return;

  const link = await supabaseAdmin.auth.admin.generateLink({
    type: "magiclink",
    email,
    options: { redirectTo },
  });
  if (link.error || !link.data?.properties?.action_link) return;

  const template = accountConfirmationResendTemplate({
    name: greetingName(found.user_metadata?.full_name),
    confirmUrl: link.data.properties.action_link,
  });

  const result = await sendEmail({ to: email, ...template });
  if (!result.success) {
    await fallBackToSupabaseConfirmation(email, result.error);
  }
}
