import "server-only";
import { sendEmail } from "@/lib/email/send";
import { supabaseAdmin } from "@/lib/supabase-server";
import { generateUnsubscribeToken } from "@/lib/email/unsubscribe";
import { getSiteUrl } from "@/lib/env";
import type { EmailSendResult, EmailTemplate } from "@/lib/email/types";

// Compliance wrapper for every promotional/marketing send (welcome,
// monthly benefits, birthday, win-back, launch, back-in-stock, cart
// recovery, ...). Purely transactional templates (receipts, shipping
// updates, billing confirmations/reminders) must keep using sendEmail()
// directly - they're never suppressible, per the transactional carve-out
// most email marketing laws (CAN-SPAM, etc.) allow.
export async function sendMarketingEmail(
  input: { to: string; campaignType: string; referenceId?: string; templateKey: string } & EmailTemplate,
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

  const html = input.html.includes("</body>")
    ? input.html.replace("</body>", `${footerHtml}</body>`)
    : `${input.html}${footerHtml}`;
  const text = `${input.text}\n\nUnsubscribe: ${unsubscribeUrl}`;

  const result = await sendEmail({ to: input.to, subject: input.subject, html, text });

  // Logged best-effort - a logging failure must never fail the send itself.
  try {
    await supabaseAdmin.from("email_send_log").insert({
      campaign_type: input.campaignType,
      reference_id: input.referenceId ?? null,
      recipient_email: email,
      template_key: input.templateKey,
      sent_at: new Date().toISOString(),
    });
  } catch {
    // Non-fatal.
  }

  return result;
}
