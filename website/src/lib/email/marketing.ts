import { redactEmailForLog } from "@/lib/log-redaction";
import "server-only";
import { sendEmail } from "@/lib/email/send";
import { supabaseAdmin } from "@/lib/supabase-server";
import { generateUnsubscribeToken } from "@/lib/email/unsubscribe";
import { getSiteUrl } from "@/lib/env";
import { getEmailRuntimeConfig, resolveMarketingFrom, resolveMarketingReplyTo } from "@/lib/email/settings";
import type { EmailSendResult, EmailTemplate } from "@/lib/email/types";
import { escapeHtml } from "@/lib/email/templates";
import { isNonMailableAddress } from "@/lib/email/non-mailable";
import { claimMarketingSend, enqueueDeferredMarketingEmail, marketingMessageAlreadySent } from "@/lib/email/frequency";

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

/** A marketing message after the wrapper has added its footer, address and pixel. */
export type RenderedMarketingEmail = { to: string; subject: string; html: string; text: string };

export type MarketingSendResult = EmailSendResult & {
  /** Unsubscribed, or a sink address: never retry. */
  suppressed?: boolean;
  /** Held back by the frequency guard; retryAt says when the window opens. */
  deferred?: boolean;
  retryAt?: number;
  /** Deferred AND parked in marketing_send_queue for the cron sweep to deliver. */
  queued?: boolean;
  /** The send-once index already holds this reference: somebody else sent it. */
  duplicate?: boolean;
};

export type MarketingSendOptions = {
  campaignType: string;
  referenceId?: string | null;
  templateKey: string;
  /**
   * The caller already claimed this send through the frequency guard and holds
   * the email_send_log row at 'sending'; close THAT row rather than claiming
   * again. Cart recovery does this so the claim precedes its coupon mint.
   */
  claimedLogId?: string | null;
  /**
   * Legacy: the caller owns the email_send_log row entirely (it wrote it before
   * calling and closes it after). No claim, no logging here.
   */
  alreadyLogged?: boolean;
  /**
   * What to do when the frequency guard defers this message. "report" (the
   * default) returns { deferred: true } and lets the caller's own sweep retry;
   * "queue" parks the rendered message in marketing_send_queue for the cron
   * sweep to deliver once the window opens — for event mail with no sweep.
   */
  onDeferred?: "report" | "queue";
  /**
   * The caller already asked the guard and found it UNAVAILABLE (un-migrated
   * database, transient error). Do not ask again — a second answer of
   * "deferred" after the caller has minted a coupon and taken its stage claim
   * would strand both. Send, and log after the fact, exactly as the legacy path.
   */
  guardUnavailable?: boolean;
};

/**
 * A caller-held claim row must not stay at 'sending' when this wrapper refuses
 * the address before the wire: the row would count as pressure for fifteen
 * minutes and read as a stranded send for ever. Best-effort, never throws.
 */
async function releaseHeldClaim(logId: string | null | undefined): Promise<void> {
  if (!logId) return;
  try {
    await supabaseAdmin.from("email_send_log").update({ status: "failed" }).eq("id", logId);
  } catch {
    // The row stays 'sending'; the guard ignores it after fifteen minutes.
  }
}

export async function sendMarketingEmail(
  input: {
    to: string;
    openTrackingPixelUrl?: string;
  } & MarketingSendOptions & EmailTemplate,
): Promise<MarketingSendResult> {
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
    await releaseHeldClaim(input.claimedLogId);
    return { success: false, suppressed: true, error: "Address cannot receive mail (provider test domain)" };
  }

  const { data: suppressed, error: suppressionError } = await supabaseAdmin
    .from("email_suppressions")
    .select("email")
    .eq("email", email)
    .maybeSingle();

  // FAILS CLOSED. An unreadable suppression table used to look exactly like
  // "not suppressed", so a transient read failure mailed people who had
  // unsubscribed, complained or bounced. Marketing mail has a retry queue and a
  // next tick; a send that cannot verify consent does not go.
  if (suppressionError) {
    await releaseHeldClaim(input.claimedLogId);
    console.error("[marketing] suppression check unavailable; refusing to send", redactEmailForLog(email), suppressionError);
    return { success: false, suppressed: false, error: "Suppression list unavailable; consent could not be verified" };
  }

  if (suppressed) {
    await releaseHeldClaim(input.claimedLogId);
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
  // Rendering is done. From here the message is data, and delivery — the
  // guard's claim, the wire, the log — is one function, shared with the
  // deferred queue so a parked message is delivered by exactly the same path.
  return sendRenderedMarketingEmail({
    rendered: { to: input.to, subject: input.subject, html, text },
    campaignType: input.campaignType,
    referenceId: input.referenceId ?? null,
    templateKey: input.templateKey,
    claimedLogId: input.claimedLogId ?? null,
    alreadyLogged: input.alreadyLogged,
    onDeferred: input.onDeferred ?? "report",
    guardUnavailable: input.guardUnavailable,
    unsubscribeUrl,
    emailConfig,
  });
}

/**
 * Deliver an already-rendered marketing message: claim the inbox through the
 * frequency guard, send, and record the outcome.
 *
 * THE CLAIM COMES FIRST. marketing_send_claim (sql/marketing-frequency-guard.sql)
 * writes the email_send_log row at 'sending' under a lock on the address, so
 * two senders in the same instant cannot both go, and every marketing sender —
 * campaigns, automations, cart recovery, restock alerts, membership mail —
 * meets the same rule here. A deferral is reported (or queued) and NOTHING is
 * sent; a claim is closed to 'sent' or 'failed' after the wire answers, with
 * the provider's message id for the delivery join.
 *
 * If the database cannot answer the claim at all — the migration has not run,
 * or a transport blip — delivery proceeds and the row is written after the
 * send, exactly as it was before the guard existed. That is fail-OPEN on the
 * frequency rule and fail-CLOSED on nothing: a missed marketing email costs
 * nothing next to a lost one, and the console says which happened.
 */
export async function sendRenderedMarketingEmail(input: {
  rendered: RenderedMarketingEmail;
  unsubscribeUrl?: string;
  emailConfig?: Awaited<ReturnType<typeof getEmailRuntimeConfig>>;
} & MarketingSendOptions): Promise<MarketingSendResult> {
  const email = input.rendered.to.trim().toLowerCase();

  // The queue's drain path arrives here directly, so the two gates the wrapper
  // applies before rendering are applied again: a person may have
  // unsubscribed since the message was parked.
  if (isNonMailableAddress(email)) {
    await releaseHeldClaim(input.claimedLogId);
    return { success: false, suppressed: true, error: "Address cannot receive mail (provider test domain)" };
  }
  if (!input.unsubscribeUrl) {
    const { data: suppressed } = await supabaseAdmin
      .from("email_suppressions")
      .select("email")
      .eq("email", email)
      .maybeSingle();
    if (suppressed) {
      await releaseHeldClaim(input.claimedLogId);
      return { success: false, suppressed: true, error: "Recipient has unsubscribed from marketing emails" };
    }
  }

  const emailConfig = input.emailConfig ?? await getEmailRuntimeConfig();
  const unsubscribeUrl = input.unsubscribeUrl
    ?? `${getSiteUrl()}/api/unsubscribe?email=${encodeURIComponent(email)}&token=${generateUnsubscribeToken(email)}`;

  // WHO HOLDS THE SEND-LOG ROW.
  //
  //   claimedLogId   the caller claimed already; close its row.
  //   alreadyLogged  the caller owns its row entirely (legacy automations path).
  //   otherwise      claim here, and let the guard decide.
  let logId: string | null = input.claimedLogId ?? null;
  let legacyLogAfterSend = false;
  if (!logId && !input.alreadyLogged && input.guardUnavailable) {
    legacyLogAfterSend = true;
  } else if (!logId && !input.alreadyLogged) {
    const claim = await claimMarketingSend({
      email,
      campaignType: input.campaignType,
      referenceId: input.referenceId ?? null,
      templateKey: input.templateKey,
    });
    switch (claim.outcome) {
      case "claimed":
        logId = claim.logId;
        break;
      case "deferred": {
        if (input.onDeferred === "queue") {
          // A deferral of a message this address ALREADY HAS is a duplicate,
          // not a delay. The send inside the quiet window that is deferring us
          // is very often this same message from an overlapping sweep or a
          // replayed activation; parking it would deliver it again tomorrow.
          if (await marketingMessageAlreadySent({ email, campaignType: input.campaignType, referenceId: input.referenceId })) {
            return { success: false, duplicate: true, error: "Already sent: this message has reached this address." };
          }
          const queued = await enqueueDeferredMarketingEmail({
            rendered: { ...input.rendered, to: email },
            campaignType: input.campaignType,
            referenceId: input.referenceId ?? null,
            templateKey: input.templateKey,
            notBefore: claim.retryAt,
          });
          return {
            success: false,
            deferred: true,
            queued,
            retryAt: claim.retryAt,
            error: queued
              ? "Deferred by the marketing frequency guard; queued for delivery once the window opens."
              : "Deferred by the marketing frequency guard, and the queue was unavailable.",
          };
        }
        return {
          success: false,
          deferred: true,
          retryAt: claim.retryAt,
          error: "Deferred: this address received a marketing email inside the last 24 hours.",
        };
      }
      case "duplicate":
        return { success: false, duplicate: true, error: "Already sent: the send-once slot for this message is taken." };
      case "refused":
        return { success: false, error: "Refused: no recipient or campaign type." };
      case "unavailable":
        console.error("[marketing] frequency guard unavailable; sending and logging after the fact", input.campaignType, claim.error);
        legacyLogAfterSend = true;
        break;
    }
  }

  // Marketing sends from its OWN address when one is configured, so a campaign
  // that draws complaints damages only that domain's reputation — not the one
  // carrying receipts and password resets. Unset, this resolves to the
  // transactional From and nothing changes. FROM the subdomain, REPLY-TO an
  // address that receives: a sending domain is not a mailbox, and the
  // List-Unsubscribe mailto has to reach one.
  const marketingFrom = resolveMarketingFrom(emailConfig);
  const marketingReplyTo = resolveMarketingReplyTo(emailConfig);
  const unsubscribeMailbox = extractEmailAddress(marketingReplyTo);
  const listHeaders: Record<string, string> = {
    "List-Unsubscribe": `<${unsubscribeUrl}>${unsubscribeMailbox ? `, <mailto:${unsubscribeMailbox}?subject=unsubscribe>` : ""}`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };

  const result = await sendEmail({
    headers: listHeaders,
    to: input.rendered.to,
    subject: input.rendered.subject,
    html: input.rendered.html,
    text: input.rendered.text,
    from: marketingFrom,
    replyTo: marketingReplyTo,
  });

  // The OUTCOME is recorded, not just the attempt. Callers dedupe against this
  // log ("has this already gone to this address?"), and a row that doesn't say
  // whether the send succeeded turns a transient provider failure into a
  // permanent one: the recipient looks done and is never retried. Best-effort:
  // a logging failure must never fail the send itself.
  try {
    if (input.alreadyLogged) return result;
    const outcome = {
      status: result.success ? "sent" : "failed",
      sent_at: new Date().toISOString(),
      // The join to the provider's delivery events. Nullable for SMTP.
      ...(result.providerMessageId ? { provider_message_id: result.providerMessageId } : {}),
    };
    if (logId && !legacyLogAfterSend) {
      await supabaseAdmin.from("email_send_log").update(outcome).eq("id", logId);
    } else {
      await supabaseAdmin.from("email_send_log").insert({
        campaign_type: input.campaignType,
        reference_id: input.referenceId ?? null,
        recipient_email: email,
        template_key: input.templateKey,
        ...outcome,
      });
    }
  } catch {
    // Non-fatal.
  }

  return result;
}
