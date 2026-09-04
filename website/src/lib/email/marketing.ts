import "server-only";
import { sendEmail } from "@/lib/email/send";
import { supabaseAdmin } from "@/lib/supabase-server";
import { generateUnsubscribeToken } from "@/lib/email/unsubscribe";
import { getSiteUrl } from "@/lib/env";
import { getEmailRuntimeConfig, resolveMarketingFrom, resolveMarketingReplyTo } from "@/lib/email/settings";
import type { EmailSendResult, EmailTemplate } from "@/lib/email/types";
import { escapeHtml } from "@/lib/email/templates";
import { isNonMailableAddress } from "@/lib/email/non-mailable";

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

/**
 * Pull the bare address out of a From value.
 *
 * A From may be `"Vanta Labs <news@mail.example.com>"` or just
 * `news@mail.example.com`. A List-Unsubscribe mailto must carry only the
 * address — the display-name form makes the header unparseable, which is worse
 * than having no mailto fallback at all.
 */
export function extractEmailAddress(from: string): string {
  const value = String(from ?? "").trim();
  const angled = value.match(/<([^>]+)>/);
  const candidate = (angled ? angled[1] : value).trim();
  return candidate.includes("@") ? candidate : "";
}

export async function sendMarketingEmail(
  input: {
    to: string;
    campaignType: string;
    referenceId?: string;
    templateKey: string;
    openTrackingPixelUrl?: string;
    /**
     * The caller already wrote the email_send_log row (it claimed the
     * send-once slot before calling). Writing a second one here would be a
     * duplicate the automation unique index rejects anyway.
     */
    alreadyLogged?: boolean;
  } & EmailTemplate,
): Promise<EmailSendResult & { suppressed?: boolean }> {
  const email = input.to.trim().toLowerCase();

  // THE SINK-ADDRESS GUARD BELONGS HERE, NOT ONLY IN THE AUDIENCE RESOLVERS.
  //
  // Filtering it in resolveAudience covers campaigns, and campaigns are the one
  // marketing path that goes through an audience at all. Cart recovery, the
  // post-purchase and win-back automations, birthday and back-in-stock mail all
  // pick their own recipient and call straight into this wrapper — so a sink
  // address typed at checkout still reached them, and a send to
  // bounced@resend.dev manufactures a bounce against the sending domain every
  // time. One check at the choke point covers every marketing path there is,
  // including the ones added after this comment.
  if (isNonMailableAddress(email)) {
    return { success: false, suppressed: true, error: "Address cannot receive mail (provider test domain)" };
  }

  const { data: suppressed } = await supabaseAdmin
    .from("email_suppressions")
    .select("email")
    .eq("email", email)
    .maybeSingle();

  if (suppressed) {
    return { success: false, suppressed: true, error: "Recipient has unsubscribed from marketing emails" };
  }

  const token = generateUnsubscribeToken(email);
  // WHICH MESSAGE THEY UNSUBSCRIBED FROM. Carried as a plain parameter, not
  // signed: it changes nothing about whether the opt-out is honoured (the
  // token does that) and only says which send prompted it, so a campaign or a
  // flow with an unusual unsubscribe rate can be found. Capped and sanitised
  // again on the receiving side.
  const unsubscribeSource = `${input.campaignType}${input.referenceId && input.campaignType === "campaign" ? `:${input.referenceId}` : ""}`.slice(0, 120);
  const unsubscribeUrl = `${getSiteUrl()}/api/unsubscribe?email=${encodeURIComponent(email)}&token=${token}&s=${encodeURIComponent(unsubscribeSource)}`;
  // WHY THIS PERSON IS RECEIVING IT — and it has to be TRUE of them.
  //
  // This line used to read "because you're a Vanta Labs customer or member" on
  // every marketing send, affiliate broadcasts included. An affiliate need never
  // have bought anything, so the one line explaining why a stranger's message is
  // in their inbox was false for exactly the audience most likely to check it.
  // A recipient who cannot place why they are being mailed is a recipient who
  // presses "report spam", and a complaint costs the sending domain far more
  // than it costs the campaign.
  //
  // Keyed off campaignType because that is already how the two audiences are
  // told apart in email_send_log, so there is no second flag to keep in step.
  const isAffiliateBroadcast = input.campaignType === "affiliate_campaign";
  const reason = isAffiliateBroadcast
    ? "You're receiving this because you're a Vanta Labs affiliate."
    : "You're receiving this because you're a Vanta Labs customer or member.";
  // Naming what the opt-out actually covers matters more for an affiliate:
  // stopping the broadcasts must not read as leaving the programme, and their
  // commission, payout and account email is transactional and unaffected.
  const optOutOf = isAffiliateBroadcast ? "affiliate announcements" : "marketing emails";
  const optOutScope = isAffiliateBroadcast
    ? " Your commission, payout and account email is unaffected."
    : "";
  const footerHtml = `<p style="margin:16px 0 0;font-size:11px;color:#71717a;">${reason} <a href="${unsubscribeUrl}" style="color:#a1a1aa;">Unsubscribe</a> from ${optOutOf}.${optOutScope}</p>`;

  // Marketing sends from its OWN address when one is configured, so a campaign
  // that draws complaints damages only that domain's reputation — not the one
  // carrying receipts and password resets. Unset, this resolves to the
  // transactional From and nothing changes.
  const emailConfig = await getEmailRuntimeConfig();

  // VL-13 / E-01 — THE CAN-SPAM POSTAL ADDRESS BELONGS TO EVERY COMMERCIAL
  // MESSAGE, NOT JUST THE ONES COMPOSED IN ADMIN.
  //
  // `campaignTemplate` takes a postalAddress and renders it, and the campaign
  // sender refuses to send without one. Nothing else did. The cart-recovery
  // sequence — four emails, the highest-volume promotional mail this store
  // sends — is built from its own templates, which never had an address
  // parameter, so every recovery email went out with an unsubscribe link and no
  // physical address. So did the birthday, win-back, launch and back-in-stock
  // mails. An opt-out does not substitute for the address; 15 U.S.C. § 7704
  // requires both.
  //
  // Applying it HERE rather than threading a new parameter through every
  // template and call site means a template added tomorrow is compliant without
  // its author knowing this rule: the wrapper that already owns suppression and
  // the unsubscribe link owns the address too. Skipped when the rendered HTML
  // already carries it, so campaignTemplate's own footer is not duplicated.
  const postalAddress = String(emailConfig.marketingPostalAddress ?? "").trim();
  const alreadyCarriesAddress = Boolean(postalAddress) && input.html.includes(escapeHtml(postalAddress).replace(/\n/g, "<br/>"));
  const addressHtml = postalAddress && !alreadyCarriesAddress
    ? `<p style="margin:12px 0 0;font-size:11px;color:#71717a;">${escapeHtml(postalAddress).replace(/\n/g, "<br/>")}</p>`
    : "";

  const pixelHtml = input.openTrackingPixelUrl
    ? `<img src="${input.openTrackingPixelUrl}" width="1" height="1" alt="" style="display:none;" />`
    : "";
  // WRAPPED IN THE SAME CENTRED CONTAINER AS THE CARD ABOVE IT.
  //
  // This block is injected before </body>, which is OUTSIDE renderLayout's
  // table — so as bare <p> elements it rendered flush against the left edge of
  // the window, full width, under a neatly centred 520px card. It is the
  // legally required part of a commercial message and it looked like it had
  // fallen out of the template. Same max-width, same 32px inset, same
  // presentation-table idiom the layout uses so mail clients treat it alike.
  const appendedHtml =
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#050505;">` +
    `<tr><td align="center" style="padding:0 16px 32px;">` +
    `<table role="presentation" width="100%" style="max-width:520px;">` +
    `<tr><td style="padding:0 32px;">${footerHtml}${addressHtml}${pixelHtml}</td></tr>` +
    `</table></td></tr></table>`;

  const html = input.html.includes("</body>")
    ? input.html.replace("</body>", `${appendedHtml}</body>`)
    : `${input.html}${appendedHtml}`;
  const addressText = postalAddress && !input.text.includes(postalAddress) ? `\n\n${postalAddress}` : "";
  // The reason line is added ABOVE the opt-out, not folded into it: the literal
  // "Unsubscribe: <url>" shape is what the plain-text part has always carried
  // and what marketing-postal-address.test.ts pins, and a mail client that
  // linkifies that line is not worth breaking for a tidier sentence.
  const text = `${input.text}\n\n${reason}${optOutScope}\nUnsubscribe: ${unsubscribeUrl}${addressText}`;
  // ONE-CLICK UNSUBSCRIBE (RFC 8058), because a footer link is no longer enough.
  //
  // Gmail and Yahoo have required bulk senders to offer one-click opt-out since
  // February 2024. A commercial message without List-Unsubscribe is a message
  // their filters are entitled to score worse — and this store has just spent a
  // week learning what a filter's verdict costs, when a confirmation email was
  // DELIVERED, filed as spam, had its links stripped, and stranded four signups.
  //
  // The header carries both forms the RFC allows. The mailto is the fallback
  // for clients that do not implement one-click; the https URL is what Gmail's
  // own "Unsubscribe" button POSTs to, which is why /api/unsubscribe gained a
  // POST. Both name the same HMAC-signed token as the footer link, so all three
  // routes are the same authorisation.
  //
  // TRANSACTIONAL MAIL SETS NONE OF THIS. A receipt is not a marketing message
  // and must never offer to stop being sent; this is the marketing wrapper, and
  // that is exactly why it lives here rather than in sendEmail().
  // The mailto must name the address this message is actually FROM.
  //
  // It used to name `emailConfig.from` — the TRANSACTIONAL address — while the
  // message itself is sent from `resolveMarketingFrom()`. Identical today,
  // because no marketing From is configured. The moment one is, every campaign
  // would go out From the marketing subdomain carrying a List-Unsubscribe
  // pointing at the transactional mailbox: an unaligned opt-out header, which
  // is the shape filters score against, and opt-out replies landing in the
  // inbox that takes order questions.
  //
  // Deriving both from the same resolved value means turning separation on
  // cannot introduce the mismatch.
  // A SENDING DOMAIN IS NOT A MAILBOX, AND THE OPT-OUT MAILTO HAS TO REACH ONE.
  //
  // This used to derive the mailto from `marketingFrom`, reasoning — correctly,
  // about reputation — that an opt-out header naming a different domain than the
  // message is the shape filters score against. What it assumed, and what turned
  // out to be false, is that the marketing From is somewhere mail can arrive.
  //
  // A Resend SENDING domain is send-only. `mail.vantalabsresearch.com` has no MX
  // at all, so on the day marketing moved onto it every Reply and every mailto
  // opt-out began bouncing. RFC 8058 expects a mailto opt-out honoured within
  // two days; one that bounces is the complaint that follows, which is the exact
  // outcome the subdomain split existed to avoid.
  //
  // So the two are resolved separately and deliberately: FROM the subdomain, so
  // reputation stays split, and REPLY-TO an address that receives. A
  // cross-domain Reply-To is ordinary and costs nothing. A From nobody can
  // answer costs a customer.
  const marketingFrom = resolveMarketingFrom(emailConfig);
  const marketingReplyTo = resolveMarketingReplyTo(emailConfig);
  const unsubscribeMailbox = extractEmailAddress(marketingReplyTo);
  const listHeaders: Record<string, string> = {
    "List-Unsubscribe": `<${unsubscribeUrl}>${unsubscribeMailbox ? `, <mailto:${unsubscribeMailbox}?subject=unsubscribe>` : ""}`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };

  const result = await sendEmail({
    headers: listHeaders,
    to: input.to,
    subject: input.subject,
    html,
    text,
    from: marketingFrom,
    replyTo: marketingReplyTo,
  });

  // Logged best-effort - a logging failure must never fail the send itself.
  //
  // The OUTCOME is recorded, not just the attempt. Callers dedupe against this
  // log ("has this already gone to this address?"), and a row that doesn't say
  // whether the send succeeded turns a transient provider failure into a
  // permanent one: the recipient looks done and is never retried.
  try {
    if (input.alreadyLogged) return result;
    await supabaseAdmin.from("email_send_log").insert({
      campaign_type: input.campaignType,
      reference_id: input.referenceId ?? null,
      recipient_email: email,
      template_key: input.templateKey,
      sent_at: new Date().toISOString(),
      status: result.success ? "sent" : "failed",
      // The join to the provider's delivery events. Automations already kept
      // it; campaigns and cart recovery did not, so their delivered and
      // bounced counts could only be guessed at. Nullable for SMTP.
      ...(result.providerMessageId ? { provider_message_id: result.providerMessageId } : {}),
    });
  } catch {
    // Non-fatal.
  }

  return result;
}
