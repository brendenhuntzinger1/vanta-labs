import "server-only";

import { supabaseAdmin } from "@/lib/supabase-server";
import { sendMarketingEmail } from "@/lib/email/marketing";
import { campaignTemplate } from "@/lib/email/templates";
import { getEmailRuntimeConfig, marketingBlockedReason } from "@/lib/email/settings";
import { loadConsentedAudience } from "@/lib/email/audience";
import { isPaidOrderStatus } from "@/lib/ledger";
import { buildAutomationClickUrl, buildAutomationOpenUrl } from "@/lib/email/automation-links";
import { resolveSitePath } from "@/lib/email/cta-path";
import { describeOfferTerms, isOfferKey, issueCustomerOffer } from "@/lib/offers/customer-offers";
import { getSiteUrl } from "@/lib/env";

/**
 * Automated retention sequences.
 *
 * These differ from campaigns in one structural way, and it drives everything
 * else: a campaign has a fixed audience decided at send time, while an
 * automation's audience is "whoever crossed a threshold since the last run" and
 * genuinely changes between sweeps. So there is no queue — eligibility is
 * recomputed each run, and duplicate suppression comes from what has already
 * been sent rather than from a work list.
 *
 * WHAT EACH ONE KEYS ON MATTERS MORE THAN IT LOOKS, because the wrong key
 * either mails someone repeatedly or mails them once and never again:
 *
 *   welcome_no_purchase  → the EMAIL. A person is new exactly once.
 *   post_purchase        → the ORDER. Every order deserves its own follow-up.
 *   winback_30 / _60     → the EMAIL + THEIR LAST ORDER DATE. This is the
 *                          subtle one. Keying on the address alone would send
 *                          one win-back ever, so a customer who returns, buys,
 *                          and lapses again would never be won back a second
 *                          time. Including the last-order date means a new
 *                          purchase starts a new dormancy episode with its own
 *                          key, and each episode gets exactly one message.
 *
 * Every send goes through sendMarketingEmail, so consent, suppression and the
 * unsubscribe footer are enforced identically to campaigns. Nothing here can
 * reach someone who has not opted in.
 */

export const AUTOMATION_KEYS = ["welcome_no_purchase", "post_purchase", "winback_30", "winback_60"] as const;
export type AutomationKey = (typeof AUTOMATION_KEYS)[number];

export function isAutomationKey(value: unknown): value is AutomationKey {
  return AUTOMATION_KEYS.includes(value as AutomationKey);
}

export type AutomationRow = {
  key: AutomationKey;
  enabled: boolean;
  delay_days: number;
  subject: string;
  headline: string;
  body: string;
  promo_code: string | null;
  cta_label: string;
  cta_path: string;
  /** One-time offer minted per recipient, or null. See customer-offers.ts. */
  offer_key: string | null;
  updated_at: string;
};

/**
 * How many recipients a single automation may mail in one sweep.
 *
 * A backstop, not a throughput target. If an automation is switched on for the
 * first time against an existing customer base, every dormant customer becomes
 * eligible at once; without a cap, one sweep would try to mail the entire list
 * inside a 60-second function. The remainder is picked up next sweep, and the
 * dedup keys mean nobody gets a second copy.
 */
export const AUTOMATION_BATCH_LIMIT = 50;

export async function loadAutomations(): Promise<AutomationRow[]> {
  const { data, error } = await supabaseAdmin
    .from("email_automations")
    .select("key, enabled, delay_days, subject, headline, body, promo_code, cta_label, cta_path, offer_key, updated_at")
    .order("key");
  if (error) throw error;
  return (data ?? []).filter((row) => isAutomationKey(row.key)) as AutomationRow[];
}

/**
 * Take the send-once slot for one (automation, reference) BEFORE sending.
 *
 * loadAlreadySent() below is a read, and the log write happens after the send,
 * so on its own the pair is a read-then-write: two overlapping sweeps both read
 * "not sent" for the same reference and both mail the customer. Nothing stopped
 * that — it simply had not happened yet.
 *
 * The claim is an INSERT against `email_send_log_automation_once`, the partial
 * unique index in sql/automation-send-once.sql. A unique violation (23505) is
 * not an error here: it is the answer. Somebody else already holds this one, so
 * this sweep does not send.
 *
 * Same shape as the order-email send-once slot, and for the same reason: the
 * only thing that can make "exactly once" true across two processes is a
 * constraint, not a lookup.
 *
 * Status is 'sending' until the outcome is known. A row left at 'sending' by a
 * crashed sweep still holds the slot, which is the safe direction — a missed
 * marketing email costs nothing next to a duplicate one, and that is exactly
 * the complaint this store already had.
 */
async function claimAutomationSend(
  campaignType: string,
  referenceId: string,
  email: string,
  templateKey: string,
): Promise<boolean> {
  const { error } = await supabaseAdmin.from("email_send_log").insert({
    campaign_type: campaignType,
    reference_id: referenceId,
    recipient_email: email,
    template_key: templateKey,
    sent_at: new Date().toISOString(),
    status: "sending",
  });
  if (!error) return true;
  if (error.code === "23505") return false;   // already claimed — not an error
  // Anything else (the index missing on an un-migrated database, a transport
  // failure) must NOT silently become a send. Refusing here means the sweep
  // skips a recipient it cannot prove is unsent, which is the direction that
  // does not mail somebody twice.
  throw error;
}

/**
 * Record how the claimed send actually went.
 *
 * `providerMessageId` is the handle that joins this row to the delivery
 * webhook's own record in email_delivery_events. Without it "we sent it" and
 * "the provider delivered it" are two claims with nothing between them, and a
 * per-automation delivery rate can only be guessed at by matching address and
 * timestamp — which double-counts the moment one person is in two sequences.
 * Absent for SMTP, which returns no id; a send without one is still a send.
 */
async function closeAutomationSend(
  campaignType: string,
  referenceId: string,
  status: "sent" | "failed",
  providerMessageId?: string | null,
): Promise<void> {
  try {
    await supabaseAdmin
      .from("email_send_log")
      .update({
        status,
        sent_at: new Date().toISOString(),
        ...(providerMessageId ? { provider_message_id: providerMessageId } : {}),
      })
      .eq("campaign_type", campaignType)
      .eq("reference_id", referenceId)
      .eq("status", "sending");
  } catch {
    // Best-effort, exactly as the log write always was: the mail has already
    // gone and a bookkeeping failure must not turn that into a retry.
  }
}

/**
 * Exported for the concurrency proof in automation-send-once.test.ts, which
 * runs two sweeps against a fake log enforcing the same unique index and
 * asserts ONE message goes out. There is no other way to exercise an
 * interleaving from a test.
 */
export const claimAutomationSendForTest = claimAutomationSend;
export const closeAutomationSendForTest = closeAutomationSend;

/** Everything already sent for an automation, as its dedup keys. */
async function loadAlreadySent(key: AutomationKey): Promise<Set<string>> {
  const sent = new Set<string>();
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabaseAdmin
      .from("email_send_log")
      .select("reference_id")
      .eq("campaign_type", `automation:${key}`)
      // Only successful sends count as "already sent". A failed attempt must
      // stay eligible, or one provider hiccup silently drops that recipient
      // from the sequence permanently.
      .neq("status", "failed")
      .range(from, from + PAGE - 1);
    if (error) throw error;
    const rows = data ?? [];
    for (const row of rows) {
      const reference = String(row.reference_id ?? "");
      if (reference) sent.add(reference);
    }
    if (rows.length < PAGE) break;
  }
  return sent;
}

type PaidOrder = { email: string; orderId: string; at: number };

async function loadPaidOrders(): Promise<PaidOrder[]> {
  const orders: PaidOrder[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabaseAdmin
      .from("orders")
      .select("order_id, customer_email, payment_status, created_at")
      .range(from, from + PAGE - 1);
    if (error) throw error;
    const rows = data ?? [];
    for (const row of rows) {
      if (!isPaidOrderStatus(row.payment_status as string | null)) continue;
      const email = String(row.customer_email ?? "").trim().toLowerCase();
      const orderId = String(row.order_id ?? "");
      const at = new Date(String(row.created_at)).getTime();
      if (!email || !orderId || !Number.isFinite(at)) continue;
      orders.push({ email, orderId, at });
    }
    if (rows.length < PAGE) break;
  }
  return orders;
}

export type AutomationTarget = { email: string; referenceId: string };

/**
 * Pure eligibility rules, exported so each automation's boundary can be
 * asserted without a database. `now` is injected for the same reason it is in
 * the audience module: an off-by-one on a 30-day threshold is invisible in
 * production and trivial to catch in a test.
 */
export function selectAutomationTargets(input: {
  key: AutomationKey;
  delayDays: number;
  consented: Set<string>;
  accounts: Set<string>;
  accountCreatedAt: Map<string, number>;
  paidOrders: PaidOrder[];
  alreadySent: Set<string>;
  now: number;
  limit?: number;
}): AutomationTarget[] {
  const cutoff = input.now - input.delayDays * 24 * 60 * 60 * 1000;
  const targets: AutomationTarget[] = [];

  const lastPaidAt = new Map<string, number>();
  for (const order of input.paidOrders) {
    const existing = lastPaidAt.get(order.email);
    if (existing === undefined || order.at > existing) lastPaidAt.set(order.email, order.at);
  }

  if (input.key === "welcome_no_purchase") {
    for (const email of input.consented) {
      if (!input.accounts.has(email)) continue;
      if (lastPaidAt.has(email)) continue;
      const created = input.accountCreatedAt.get(email);
      if (created === undefined || created > cutoff) continue;
      if (input.alreadySent.has(email)) continue;
      targets.push({ email, referenceId: email });
    }
  } else if (input.key === "post_purchase") {
    for (const order of input.paidOrders) {
      if (!input.consented.has(order.email)) continue;
      if (order.at > cutoff) continue;
      if (input.alreadySent.has(order.orderId)) continue;
      targets.push({ email: order.email, referenceId: order.orderId });
    }
  } else {
    // Win-back. Must have bought at some point — someone who never ordered is
    // the welcome sequence's job, and sending both would be two mails saying
    // opposite things.
    for (const email of input.consented) {
      const at = lastPaidAt.get(email);
      if (at === undefined || at > cutoff) continue;
      // The episode key: a later purchase produces a different reference, so
      // the customer becomes eligible again after they lapse a second time.
      const reference = `${email}:${at}`;
      if (input.alreadySent.has(reference)) continue;
      targets.push({ email, referenceId: reference });
    }
  }

  const limit = input.limit ?? AUTOMATION_BATCH_LIMIT;
  return targets.slice(0, limit);
}

/** Account creation times, keyed by lowercase email. */
async function loadAccountCreatedAt(): Promise<Map<string, number>> {
  const created = new Map<string, number>();
  const PER_PAGE = 1000;
  const MAX_PAGES = 100;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: PER_PAGE });
    if (error) throw error;
    const users = data?.users ?? [];
    for (const user of users) {
      const email = user.email?.trim().toLowerCase();
      const at = new Date(String(user.created_at)).getTime();
      if (email && Number.isFinite(at)) created.set(email, at);
    }
    if (users.length < PER_PAGE) break;
  }
  return created;
}

export type AutomationSweepResult = {
  sent: number;
  skipped: number;
  failed: number;
  byKey: Record<string, number>;
  errors: string[];
};

/**
 * Run every enabled automation once.
 *
 * Collects errors rather than throwing: this shares the cron sweep with ten
 * other jobs, and one automation with bad copy must not take down membership
 * billing or payment reconciliation alongside it.
 */
/**
 * TRACKING MUST NEVER COST A SEND.
 *
 * Both link builders sign with UNSUBSCRIBE_SECRET or SUPABASE_SERVICE_ROLE_KEY
 * and throw when neither is set. That throw would escape into the per-automation
 * try/catch in the sweep and drop EVERY recipient of that automation — a
 * misconfigured secret would silently stop retention mail rather than merely
 * stop measuring it, which is a strictly worse failure than the untracked links
 * these replaced.
 *
 * So a tracked link is an upgrade attempted per send, not a precondition of
 * one. If it cannot be minted the customer still gets a working button
 * pointing at the same place; only the click stamp is lost.
 */
function trackedCtaUrl(key: AutomationKey, email: string, referenceId: string, ctaPath: string, offerToken?: string): string {
  try {
    return buildAutomationClickUrl(key, email, referenceId, offerToken);
  } catch (error) {
    console.error("[automations] click tracking unavailable, sending a plain link", key, error);
    return resolveSitePath(ctaPath, getSiteUrl());
  }
}

/** Same contract: no pixel is better than no email. */
function trackedOpenUrl(key: AutomationKey, email: string, referenceId: string): string | undefined {
  try {
    return buildAutomationOpenUrl(key, email, referenceId);
  } catch {
    return undefined;
  }
}

export async function runAutomationSweep(input?: { now?: number }): Promise<AutomationSweepResult> {
  const now = input?.now ?? Date.now();
  const result: AutomationSweepResult = { sent: 0, skipped: 0, failed: 0, byKey: {}, errors: [] };

  const config = await getEmailRuntimeConfig();
  const blocked = marketingBlockedReason(config);
  if (blocked) {
    result.errors.push(blocked);
    return result;
  }

  let automations: AutomationRow[];
  try {
    automations = (await loadAutomations()).filter((row) => row.enabled);
  } catch (error) {
    result.errors.push(`load: ${error instanceof Error ? error.message : String(error)}`);
    return result;
  }
  if (automations.length === 0) return result;

  const audience = await loadConsentedAudience();
  if (audience.all.size === 0) return result;

  const paidOrders = await loadPaidOrders();
  // Only loaded when an automation actually needs it — paging the auth list is
  // the most expensive thing in this sweep.
  const needsAccounts = automations.some((row) => row.key === "welcome_no_purchase");
  const accountCreatedAt = needsAccounts ? await loadAccountCreatedAt() : new Map<string, number>();

  for (const automation of automations) {
    try {
      const alreadySent = await loadAlreadySent(automation.key);
      const targets = selectAutomationTargets({
        key: automation.key,
        delayDays: automation.delay_days,
        consented: audience.all,
        accounts: audience.accounts,
        accountCreatedAt,
        paidOrders,
        alreadySent,
        now,
      });

      for (const target of targets) {
        const campaignType = `automation:${automation.key}`;
        const templateKey = `automation_${automation.key}`;

        // A BLANK BUTTON IS AN INSTRUCTION, NOT AN OVERSIGHT.
        //
        // An operator who clears the button text or the destination in Admin →
        // Email means "no button on this one" — a plain note with no ask is a
        // legitimate shape for a post-purchase check-in. Both halves are needed
        // for a button, so either being blank removes it, and no tracked link
        // is minted for a button that will not be rendered.
        const ctaLabel = String(automation.cta_label ?? "").trim();
        const ctaPath = String(automation.cta_path ?? "").trim();
        const hasCta = Boolean(ctaLabel && ctaPath);

        // THESE USED TO LINK STRAIGHT TO THE DESTINATION, and a comment here
        // explained that click attribution was keyed on a campaign id which
        // automations do not have. That was true and it left the only
        // unattended part of the email system as the only unmeasurable one:
        // four automations mailing customers with no click, conversion or
        // revenue figure available for any of them.
        //
        // automation-links.ts is the keyed-on-text twin of campaign-links.ts.
        // The reference id is inside the signature, so each SEND is its own
        // cohort — a customer won back twice produces two references and two
        // separately measurable episodes.
        // CLAIM BEFORE MINTING OR SENDING. alreadySent above is a snapshot
        // taken once per automation; this is the check that holds across two
        // sweeps running at the same time. If another one already has this
        // reference, stop here.
        //
        // The claim comes BEFORE the offer is minted, and the order matters:
        // the token is never stored, so a sweep that minted first and then
        // lost the claim would throw its token away — and the sweep that won
        // would find the index already taken and mail the gift copy with no
        // token behind it. Only the claim winner mints, so the only token in
        // existence is the one in the email that actually goes out.
        if (!(await claimAutomationSend(campaignType, target.referenceId, target.email, templateKey))) {
          result.skipped++;
          continue;
        }

        // MINT THE ONE-TIME OFFER, IF THIS AUTOMATION CARRIES ONE.
        //
        // Per recipient, and only for the message about to go out. The token
        // exists in exactly two places from here: this variable, and the email
        // the customer receives — customer_offers stores only its hash.
        //
        // AN AUTOMATION THAT CARRIES A GIFT DOES NOT SEND WITHOUT ONE. The
        // operator's copy says "here is your free GHK-Cu"; a message that says
        // so with no token behind it is a promise the checkout cannot keep,
        // and the customer finds out at the till. So a missing token closes the
        // slot as 'failed' — which falls outside the send-once index, exactly
        // as a provider failure does — and the next sweep tries again, by which
        // time the usual cause (a checkout holding the previous token) has
        // settled. The automation's error list says why, so it is visible in
        // the cron report rather than silent.
        let offerToken: string | undefined;
        let offerTerms: string | undefined;
        if (isOfferKey(automation.offer_key)) {
          const issued = await issueCustomerOffer({ offerKey: automation.offer_key, email: target.email });
          if (!issued) {
            await closeAutomationSend(campaignType, target.referenceId, "failed");
            result.failed++;
            result.errors.push(`${automation.key}: no ${automation.offer_key} token could be issued for ${target.email}; send deferred to the next sweep`);
            continue;
          }
          offerToken = issued.token;
          offerTerms = describeOfferTerms(automation.offer_key, issued.expiresAt);
        }

        const template = campaignTemplate({
          subject: automation.subject,
          previewText: automation.headline,
          headline: automation.headline,
          body: automation.body,
          promoCode: automation.promo_code,
          ctaLabel: hasCta ? ctaLabel : "",
          ctaUrl: hasCta ? trackedCtaUrl(automation.key, target.email, target.referenceId, ctaPath, offerToken) : "",
          offerTerms,
          postalAddress: config.marketingPostalAddress,
        });

        const sendResult = await sendMarketingEmail({
          to: target.email,
          campaignType,
          referenceId: target.referenceId,
          templateKey,
          // Opens land on the send-log row this sweep already claimed, keyed
          // by the same (campaign_type, reference_id) pair.
          openTrackingPixelUrl: trackedOpenUrl(automation.key, target.email, target.referenceId),
          // The claim row IS the log row now, so the sender must not write a
          // second one — that is what the unique index would reject anyway.
          alreadyLogged: true,
          ...template,
        });

        if (sendResult.success) {
          await closeAutomationSend(campaignType, target.referenceId, "sent", sendResult.providerMessageId);
          result.sent++;
          result.byKey[automation.key] = (result.byKey[automation.key] ?? 0) + 1;
        } else if (sendResult.suppressed) {
          // Unsubscribed. Nothing was mailed, so release the slot rather than
          // leaving a 'sending' row that would block a legitimate later send if
          // they ever resubscribe.
          await supabaseAdmin.from("email_send_log")
            .delete()
            .eq("campaign_type", campaignType)
            .eq("reference_id", target.referenceId)
            .eq("status", "sending");
          result.skipped++;
        } else {
          // 'failed' falls outside the unique index, so this recipient stays
          // eligible for the next sweep — one provider hiccup must not drop
          // them from the sequence permanently.
          await closeAutomationSend(campaignType, target.referenceId, "failed");
          result.failed++;
        }
      }
    } catch (error) {
      result.errors.push(`${automation.key}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return result;
}
