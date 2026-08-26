import "server-only";
import { sendEmail } from "@/lib/email/send";
import { supabaseAdmin } from "@/lib/supabase-server";
import { generateUnsubscribeToken } from "@/lib/email/unsubscribe";
import { getSiteUrl } from "@/lib/env";
import { getEmailRuntimeConfig, resolveMarketingFrom } from "@/lib/email/settings";
import type { EmailSendResult, EmailTemplate } from "@/lib/email/types";

// Compliance wrapper for every promotional/marketing send (welcome,
// monthly benefits, birthday, win-back, launch, back-in-stock, cart
// recovery, ...). Purely transactional templates (receipts, shipping
// updates, billing confirmations/reminders) must keep using sendEmail()
// directly - they're never suppressible, per the transactional carve-out
// most email marketing laws (CAN-SPAM, etc.) allow.
/**
 * Is this address unsubscribed from marketing email?
 *
 * sendMarketingEmail applies this same gate internally, but it reports the
 * result as `{ success: false, suppressed: true }` — indistinguishable, to a
 * caller that only checks `success`, from a provider outage. Callers that do
 * work BEFORE sending (minting a coupon, reserving a slot) need to know the
 * difference in advance, because "this person will never receive it" and "this
 * person might receive it on a retry" call for opposite behaviour.
 *
 * See finding C-06: cart recovery treated a suppressed recipient as a retryable
 * failure and re-minted a coupon for them on every sweep, for ever.
 */
export async function isMarketingSuppressed(to: string): Promise<boolean> {
  const email = to.trim().toLowerCase();
  if (!email) return false;
  const { data } = await supabaseAdmin
    .from("email_suppressions")
    .select("email")
    .eq("email", email)
    .maybeSingle();
  return Boolean(data);
}

export async function sendMarketingEmail(
  input: { to: string; campaignType: string; referenceId?: string; templateKey: string; openTrackingPixelUrl?: string } & EmailTemplate,
): Promise<EmailSendResult & { suppressed?: boolean }> {
  const email = input.to.trim().toLowerCase();

  const { data: suppressed } = await supabaseAdmin
    .from("email_suppressions")
    .select("email")
    .eq("email", email)
    .maybeSingle();

  if (suppressed) {
    return { success: false, suppressed: true, error: "Recipient has unsubscribed from marketing emails" };
  }

  const token = generateUnsubscribeToken(email);
  const unsubscribeUrl = `${getSiteUrl()}/api/unsubscribe?email=${encodeURIComponent(email)}&token=${token}`;
  const footerHtml = `<p style="margin:16px 0 0;font-size:11px;color:#71717a;">You're receiving this because you're a Vanta Labs customer or member. <a href="${unsubscribeUrl}" style="color:#a1a1aa;">Unsubscribe</a> from marketing emails.</p>`;
  const pixelHtml = input.openTrackingPixelUrl
    ? `<img src="${input.openTrackingPixelUrl}" width="1" height="1" alt="" style="display:none;" />`
    : "";
  const appendedHtml = `${footerHtml}${pixelHtml}`;

  const html = input.html.includes("</body>")
    ? input.html.replace("</body>", `${appendedHtml}</body>`)
    : `${input.html}${appendedHtml}`;
  const text = `${input.text}\n\nUnsubscribe: ${unsubscribeUrl}`;

  // Marketing sends from its OWN address when one is configured, so a campaign
  // that draws complaints damages only that domain's reputation — not the one
  // carrying receipts and password resets. Unset, this resolves to the
  // transactional From and nothing changes.
  const emailConfig = await getEmailRuntimeConfig();
  const result = await sendEmail({
    to: input.to,
    subject: input.subject,
    html,
    text,
    from: resolveMarketingFrom(emailConfig),
  });

  // Logged best-effort - a logging failure must never fail the send itself.
  //
  // The OUTCOME is recorded, not just the attempt. Callers dedupe against this
  // log ("has this already gone to this address?"), and a row that doesn't say
  // whether the send succeeded turns a transient provider failure into a
  // permanent one: the recipient looks done and is never retried.
  try {
    await supabaseAdmin.from("email_send_log").insert({
      campaign_type: input.campaignType,
      reference_id: input.referenceId ?? null,
      recipient_email: email,
      template_key: input.templateKey,
      sent_at: new Date().toISOString(),
      status: result.success ? "sent" : "failed",
    });
  } catch {
    // Non-fatal.
  }

  return result;
}
