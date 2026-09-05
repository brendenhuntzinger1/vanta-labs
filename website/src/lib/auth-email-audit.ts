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
  /**
   * The key the claim was taken under, when it differs from `kind`.
   *
   * claimAuthEmailSend(kind, email, debounceAs) writes its 'sending' row as
   * `auth:${debounceAs}`; this closes it, so it has to look under the same
   * key. The signup double-click branch claims as `signup_confirmation` and
   * records as `signup_confirmation_resend` — and without this every one of
   * those rows stayed at 'sending' for ever, holding the minute's slot shut
   * against a genuine retry and reporting a send perpetually in flight.
   */
  claimedAs?: AuthEmailKind;
}): Promise<void> {
  try {
    // CLOSE THE CLAIM IF THERE IS ONE. claimAuthEmailSend() has usually already
    // written this row as 'sending'; inserting a second would be the duplicate
    // the index exists to reject, and would leave the outcome unrecorded.
    const { data: claimed } = await supabaseAdmin
      .from("email_send_log")
      .update({
        status: input.success ? "sent" : "failed",
        reference_id: input.success ? null : String(input.error ?? "").slice(0, 200) || "unknown",
      })
      .eq("campaign_type", `auth:${input.claimedAs ?? input.kind}`)
      .eq("recipient_email", input.email)
      .eq("status", "sending")
      .select("id");
    if (claimed && claimed.length > 0) return;

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

/**
 * Take the once-a-minute slot for an auth email BEFORE sending it.
 *
 * recordAuthEmailAttempt above writes AFTER the send, best-effort, and nothing
 * ever read it. So nothing stopped the same message going out twice: a
 * double-clicked signup sent two confirmations, and three impatient clicks of
 * "resend" sent three. The rate limiter allows that small burst on purpose — it
 * exists to stop flooding, not to stop a customer clicking twice.
 *
 * From the customer's side that is the repeated mail they complained about, and
 * it is worse than noise: each copy carries a DIFFERENT token, so acting on the
 * older one produces "I got the email but the link doesn't work".
 *
 * The claim is an INSERT against `email_send_log_auth_once_per_minute`
 * (sql/auth-email-debounce.sql). A 23505 means somebody already sent this
 * message to this address this minute, so this caller must not send another —
 * and, importantly, must still answer the customer as though it had, because
 * they DO have the email.
 *
 * A minute, not forever: a genuine resend later has to work. That is the only
 * route open to someone whose confirmation never arrived.
 *
 * Fails OPEN. If the claim errors for any reason other than a duplicate — an
 * un-migrated database, a transport blip — the email still goes. A missing
 * confirmation email locks a customer out of the account they just made, which
 * is a strictly worse outcome than a duplicate one.
 */
export async function claimAuthEmailSend(
  kind: AuthEmailKind,
  email: string,
  /**
   * The key to debounce ON, when it differs from the kind.
   *
   * A double-clicked signup does not take the same route twice: the first
   * request creates the account and sends `signup_confirmation`, and the second
   * finds the address already registered and unconfirmed, so it sends
   * `signup_confirmation_resend`. Two different kinds, two different claims,
   * and the customer gets two emails from one double-click — which is the whole
   * complaint. They are the same message as far as the recipient is concerned,
   * so they debounce against the same key.
   */
  debounceAs: AuthEmailKind = kind,
): Promise<boolean> {
  try {
    const { error } = await supabaseAdmin.from("email_send_log").insert({
      campaign_type: `auth:${debounceAs}`,
      recipient_email: email,
      template_key: kind,
      reference_id: null,
      sent_at: new Date().toISOString(),
      // 'sending' until the outcome is known. A send that FAILS is closed as
      // 'failed', which falls outside the unique index, so the customer can
      // immediately ask again — claiming as 'sent' up front would lock someone
      // who received nothing out of retrying for the rest of the minute.
      status: "sending",
    });
    if (!error) return true;
    if (error.code === "23505") return false;
    return true;
  } catch {
    return true;
  }
}

/**
 * Give a claimed slot back when nothing was sent.
 *
 * claimAuthEmailSend() is taken BEFORE the message exists, because for a
 * password reset the act of minting the link is what invalidates the previous
 * one — the claim has to precede the mint or it protects nothing. When the
 * mint then refuses (no account for the address, or the admin API failed) no
 * email goes out, and a 'sending' row that never closes would refuse the
 * customer's next attempt for the rest of the minute for an email they never
 * received.
 *
 * Deletes only the row this caller wrote: campaign, address, and still
 * 'sending'. A concurrent request was refused by the unique index, so it has
 * no row here to lose. Never throws — a release that fails leaves the slot to
 * age out after the minute, which is the pre-existing worst case.
 */
export async function releaseAuthEmailClaim(kind: AuthEmailKind, email: string): Promise<void> {
  try {
    await supabaseAdmin
      .from("email_send_log")
      .delete()
      .eq("campaign_type", `auth:${kind}`)
      .eq("recipient_email", email)
      .eq("status", "sending");
  } catch {
    /* best-effort; see above */
  }
}
