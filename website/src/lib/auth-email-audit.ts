import "server-only";

import { supabaseAdmin } from "@/lib/supabase-server";

// ---------------------------------------------------------------------------
// A CONFIRMATION EMAIL THAT LEAVES NO TRACE ANYWHERE.
//
// One production account sat unconfirmed for days and raised
// `signup_confirmation_stalled`. Answering the alert means asking one question
// — was the email actually sent? — and there was no way to answer it:
//
//   * sendEmail() writes nothing. It hands the message to the provider and
//     returns a result the caller may do anything or nothing with.
//   * /api/auth/signup does nothing with it on success, and on failure calls
//     fallBackToSupabaseConfirmation, which also writes nothing.
//   * So `email_send_log` and `pending_emails` are both empty for that address
//     whether the send SUCCEEDED, FAILED, or was never attempted at all.
//
// Zero rows meant zero information. The operator could not tell a provider
// outage from a customer who mistyped their address from a Gmail spam filing —
// which are three completely different responses.
//
// The order pipeline solved this long ago (order_email_log, and the retry queue
// behind it). The auth emails, which are the ones a customer is BLOCKED by,
// were the pair that never got it.
//
// WHY A LOG ROW RATHER THAN THE RETRY QUEUE. A failed confirmation already has
// a recovery path — Supabase's own sender goes out immediately as the fallback
// — so queueing a second attempt would send some customers two links. What was
// missing was not another retry, it was the record.
//
// Never throws and never blocks the send: an audit row that can take the signup
// down with it is worse than no audit row.
// ---------------------------------------------------------------------------

/** The auth emails a customer is blocked by until one arrives. */
export type AuthEmailKind =
  | "signup_confirmation"
  | "signup_confirmation_resend"
  | "signup_confirmation_supabase_fallback"
  | "password_reset"
  | "email_change";

export async function recordAuthEmailAttempt(input: {
  kind: AuthEmailKind;
  email: string;
  success: boolean;
  error?: string;
}): Promise<void> {
  try {
    await supabaseAdmin.from("email_send_log").insert({
      // Namespaced the same way automations use `automation:<key>`, so the auth
      // mail is filterable as a group without colliding with campaign types.
      campaign_type: `auth:${input.kind}`,
      // No campaign or order to point at; the failure reason is the useful
      // thing to carry, and it is what tells a provider outage apart from a
      // rejected address. Bounded because a provider error can be verbose.
      reference_id: input.success ? null : String(input.error ?? "").slice(0, 200) || "unknown",
      recipient_email: input.email,
      template_key: input.kind,
      sent_at: new Date().toISOString(),
      status: input.success ? "sent" : "failed",
    });
  } catch {
    // Non-fatal, exactly as in lib/email/marketing.ts: the email is what
    // matters and it has already gone.
  }
}
