import "server-only";

import { supabaseAdmin } from "@/lib/supabase-server";
import { sendMarketingEmail } from "@/lib/email/marketing";
import { campaignTemplate } from "@/lib/email/templates";
import { getEmailRuntimeConfig, marketingBlockedReason } from "@/lib/email/settings";
import { loadConsentedAudience } from "@/lib/email/audience";
import { isPaidOrderStatus, isProductPurchaseOrder } from "@/lib/ledger";
import { buildAutomationClickUrl, buildAutomationOpenUrl } from "@/lib/email/automation-links";
import { resolveSitePath } from "@/lib/email/cta-path";
import { describeOfferTerms, isOfferKey, issueCustomerOffer } from "@/lib/offers/customer-offers";
import { getSiteUrl } from "@/lib/env";
import { AUTOMATION_QUIET_MS, claimMarketingSend, isInQuietPeriod, loadLastMarketingSendAt } from "@/lib/email/frequency";

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

export {
  AUTOMATION_KEYS,
  AUTOMATION_LABELS,
  EVENT_GRACE_DAYS,
  isAutomationKey,
  type AutomationKey,
} from "@/lib/email/automation-catalog";
import { AUTOMATION_KEYS, EVENT_GRACE_DAYS, isAutomationKey, type AutomationKey } from "@/lib/email/automation-catalog";

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
type AutomationClaim =
  | { outcome: "claimed"; logId: string | null }
  | { outcome: "duplicate" }
  | { outcome: "deferred"; retryAt: number };

async function claimAutomationSend(
  campaignType: string,
  referenceId: string,
  email: string,
  templateKey: string,
): Promise<AutomationClaim> {
  // THE SHARED FREQUENCY GUARD DECIDES FIRST. marketing_send_claim takes the
  // lock on the address, refuses if anything marketing-shaped reached it
  // inside the window (a campaign in the same cron tick included), and
  // otherwise writes this very row at 'sending' — the same send-once slot,
  // under the same unique index, that this function used to insert directly.
  const claim = await claimMarketingSend({ email, campaignType, referenceId, templateKey });
  if (claim.outcome === "claimed") return { outcome: "claimed", logId: claim.logId };
  if (claim.outcome === "deferred") return { outcome: "deferred", retryAt: claim.retryAt };
  if (claim.outcome === "duplicate") return { outcome: "duplicate" };
  if (claim.outcome === "refused") return { outcome: "duplicate" };

  // The guard could not answer (an un-migrated database, a transport blip).
  // Fall back to the direct claim this sweep always made, so retention mail
  // keeps going out with the send-once guarantee intact — only the cross-sender
  // frequency rule is lost this tick, and the console says so.
  console.error("[automations] frequency guard unavailable; claiming the send-once slot directly", claim.error);
  const { error } = await supabaseAdmin.from("email_send_log").insert({
    campaign_type: campaignType,
    reference_id: referenceId,
    recipient_email: email,
    template_key: templateKey,
    sent_at: new Date().toISOString(),
    status: "sending",
  });
  if (!error) return { outcome: "claimed", logId: null };
  if (error.code === "23505") return { outcome: "duplicate" };   // already claimed — not an error
  // Anything else must NOT silently become a send. Refusing here means the
  // sweep skips a recipient it cannot prove is unsent, which is the direction
  // that does not mail somebody twice.
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
/**
 * When each episode reference last received this automation (ms), for the
 * ladder-spacing rule in selectAutomationTargets. Same read as loadAlreadySent
 * with the timestamp kept.
 */
async function loadSentAtByReference(key: AutomationKey): Promise<Map<string, number>> {
  const sentAt = new Map<string, number>();
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabaseAdmin
      .from("email_send_log")
      .select("reference_id, sent_at")
      .eq("campaign_type", `automation:${key}`)
      .neq("status", "failed")
      .range(from, from + PAGE - 1);
    if (error) throw error;
    const rows = (data ?? []) as Array<{ reference_id?: string | null; sent_at?: string | null }>;
    for (const row of rows) {
      const reference = String(row.reference_id ?? "");
      const at = Date.parse(String(row.sent_at ?? ""));
      if (!reference || !Number.isFinite(at)) continue;
      sentAt.set(reference, Math.max(sentAt.get(reference) ?? 0, at));
    }
    if (rows.length < PAGE) break;
  }
  return sentAt;
}

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
      .select("order_id, customer_email, payment_status, created_at, order_type")
      .range(from, from + PAGE - 1);
    if (error) throw error;
    const rows = data ?? [];
    for (const row of rows) {
      if (!isPaidOrderStatus(row.payment_status as string | null)) continue;
      // A membership charge or a replacement reship is a paid order and NOT a
      // purchase of product (EMAIL-02): "your first order" after a plan signup,
      // "time to restock" thirty days after a free reship, and a win-back clock
      // reset by every monthly renewal were all this one missing line.
      if (!isProductPurchaseOrder(row as { order_type?: string | null })) continue;
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

const DAY_MS = 24 * 60 * 60 * 1000;

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
  /** When a guest opted in (marketing_subscribers.opted_in_at), keyed by email. */
  subscribedAt?: Map<string, number>;
  paidOrders: PaidOrder[];
  alreadySent: Set<string>;
  /** Most recent marketing send per address — see frequency.ts. */
  lastMarketingSentAt?: Map<string, number>;
  quietMs?: number;
  /**
   * Called for every target that is DUE but held by the quiet period. Nothing
   * is consumed for it and the next sweep reconsiders it; the caller counts
   * these as deferred so the sweep's numbers say what actually happened.
   */
  onDeferred?: (target: AutomationTarget) => void;
  /**
   * The earlier step of this automation's ladder, when one is enabled: when it
   * reached each episode, and its own delay. Win-back 2 is then sent only
   * after Win-back 1 went AND the gap between the two delays has passed since.
   * Without it, enabling both on a base of long-lapsed customers sent both a
   * day apart — message 2 carrying the gift before message 1 had a chance.
   */
  ladderPredecessor?: { sentAt: Map<string, number>; delayDays: number } | null;
  now: number;
  limit?: number;
}): AutomationTarget[] {
  const cutoff = input.now - input.delayDays * DAY_MS;
  // Event-keyed flows only look this far back; see EVENT_GRACE_DAYS.
  const oldest = cutoff - EVENT_GRACE_DAYS * DAY_MS;
  const targets: AutomationTarget[] = [];

  const lastPaidAt = new Map<string, number>();
  const firstPaidAt = new Map<string, number>();
  for (const order of input.paidOrders) {
    const last = lastPaidAt.get(order.email);
    if (last === undefined || order.at > last) lastPaidAt.set(order.email, order.at);
    const first = firstPaidAt.get(order.email);
    if (first === undefined || order.at < first) firstPaidAt.set(order.email, order.at);
  }

  // THE QUIET PERIOD, applied once here for every flow. A recipient mailed by
  // anything marketing-shaped inside the window is DEFERRED this sweep and
  // reconsidered next time; nothing is consumed and no slot is claimed. The
  // database claim in the sweep is the check that holds under concurrency —
  // this one is the cheap pre-read that keeps the sweep from minting a gift
  // for a message it will not send.
  const quiet = (target: AutomationTarget) => {
    const held = isInQuietPeriod({
      lastMarketingSentAt: input.lastMarketingSentAt?.get(target.email),
      now: input.now,
      quietMs: input.quietMs,
    });
    if (held) input.onDeferred?.(target);
    return held;
  };

  if (input.key === "welcome_intro" || input.key === "welcome_no_purchase") {
    // "Consented at" is the account's creation for an account holder and the
    // opt-in time for a guest subscriber. Either way it is when the person
    // first said yes, which is what a welcome is timed from.
    for (const email of input.consented) {
      if (lastPaidAt.has(email)) continue;
      const consentedAt = input.accounts.has(email)
        ? input.accountCreatedAt.get(email)
        : input.subscribedAt?.get(email);
      if (consentedAt === undefined || consentedAt > cutoff || consentedAt < oldest) continue;
      if (input.alreadySent.has(email)) continue;
      if (quiet({ email, referenceId: email })) continue;
      targets.push({ email, referenceId: email });
    }
  } else if (input.key === "post_purchase") {
    // The FIRST order only. The message explains the COA, storage and support
    // — things a second-time buyer already knows. Repeat orders are the
    // reorder reminder's job.
    for (const order of input.paidOrders) {
      if (!input.consented.has(order.email)) continue;
      if (firstPaidAt.get(order.email) !== order.at) continue;
      if (order.at > cutoff || order.at < oldest) continue;
      if (input.alreadySent.has(order.orderId)) continue;
      if (quiet({ email: order.email, referenceId: order.orderId })) continue;
      targets.push({ email: order.email, referenceId: order.orderId });
    }
  } else if (input.key === "replenishment") {
    // Keyed on the ORDER, and only while it is still the customer's latest:
    // someone who has ordered again since does not need reminding about the
    // order before.
    for (const order of input.paidOrders) {
      if (!input.consented.has(order.email)) continue;
      if (lastPaidAt.get(order.email) !== order.at) continue;
      if (order.at > cutoff || order.at < oldest) continue;
      if (input.alreadySent.has(order.orderId)) continue;
      if (quiet({ email: order.email, referenceId: order.orderId })) continue;
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
      if (input.ladderPredecessor) {
        // Not "due" until the earlier step has been sent for THIS episode and
        // the ladder's own spacing has elapsed since. Nothing is consumed; the
        // next sweep asks again.
        const previousAt = input.ladderPredecessor.sentAt.get(reference);
        const spacingMs = Math.max(0, input.delayDays - input.ladderPredecessor.delayDays) * DAY_MS;
        if (previousAt === undefined || input.now - previousAt < spacingMs) continue;
      }
      if (quiet({ email, referenceId: reference })) continue;
      targets.push({ email, referenceId: reference });
    }
  }

  const limit = input.limit ?? AUTOMATION_BATCH_LIMIT;
  return targets.slice(0, limit);
}

/** Guest opt-in times from marketing_subscribers, keyed by lowercase email. */
async function loadSubscribedAt(): Promise<Map<string, number>> {
  const subscribed = new Map<string, number>();
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabaseAdmin
      .from("marketing_subscribers")
      .select("email, opted_in_at")
      .is("unsubscribed_at", null)
      .order("email", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    const rows = data ?? [];
    for (const row of rows) {
      const email = String(row.email ?? "").trim().toLowerCase();
      const at = new Date(String(row.opted_in_at)).getTime();
      if (email && Number.isFinite(at)) subscribed.set(email, at);
    }
    if (rows.length < PAGE) break;
  }
  return subscribed;
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
  /** Held back by the marketing frequency guard this sweep; retried next sweep. */
  deferred: number;
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
  const result: AutomationSweepResult = { sent: 0, skipped: 0, failed: 0, deferred: 0, byKey: {}, errors: [] };

  const config = await getEmailRuntimeConfig();
  const blocked = marketingBlockedReason(config);
  if (blocked) {
    result.errors.push(blocked);
    return result;
  }

  let automations: AutomationRow[];
  try {
    // Priority order, whatever order the database returned them in.
    automations = (await loadAutomations())
      .filter((row) => row.enabled)
      .sort((a, b) => AUTOMATION_KEYS.indexOf(a.key) - AUTOMATION_KEYS.indexOf(b.key));
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
  const needsWelcome = automations.some((row) => row.key === "welcome_no_purchase" || row.key === "welcome_intro");
  const accountCreatedAt = needsWelcome ? await loadAccountCreatedAt() : new Map<string, number>();
  const subscribedAt = needsWelcome ? await loadSubscribedAt() : new Map<string, number>();

  // THE QUIET PERIOD IS READ ONCE AND KEPT CURRENT. Each successful send below
  // stamps the map, so an automation later in the priority order sees what an
  // earlier one just did — the whole reason they run in order.
  let lastMarketingSentAt: Map<string, number>;
  try {
    lastMarketingSentAt = await loadLastMarketingSendAt({ now, lookbackMs: AUTOMATION_QUIET_MS });
  } catch (error) {
    // Fail CLOSED for this sweep: with no picture of recent sends, every
    // automation waits half an hour rather than risking three offers in a day.
    result.errors.push(`quiet-period read failed; automations deferred this sweep: ${error instanceof Error ? error.message : String(error)}`);
    return result;
  }

  for (const automation of automations) {
    try {
      const alreadySent = await loadAlreadySent(automation.key);
      // Win-back 2 follows Win-back 1 when both are enabled (see ladderPredecessor).
      const predecessor = automation.key === "winback_60"
        ? automations.find((row) => row.key === "winback_30") ?? null
        : null;
      const ladderPredecessor = predecessor
        ? { sentAt: await loadSentAtByReference(predecessor.key), delayDays: predecessor.delay_days }
        : null;
      const targets = selectAutomationTargets({
        key: automation.key,
        delayDays: automation.delay_days,
        ladderPredecessor,
        consented: audience.all,
        accounts: audience.accounts,
        accountCreatedAt,
        subscribedAt,
        paidOrders,
        alreadySent,
        lastMarketingSentAt,
        onDeferred: () => { result.deferred++; },
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
        const claim = await claimAutomationSend(campaignType, target.referenceId, target.email, templateKey);
        if (claim.outcome === "deferred") {
          // Held by the frequency guard: something else reached this inbox
          // inside the window. Nothing is consumed; the next sweep reconsiders.
          result.deferred++;
          continue;
        }
        if (claim.outcome === "duplicate") {
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
          const issued = await issueCustomerOffer({
            offerKey: automation.offer_key,
            email: target.email,
            // Provenance: which send minted this gift, so a redemption can credit
            // the automation even when the customer never clicked the tracked link.
            automationKey: automation.key,
            referenceId: target.referenceId,
          });
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
          // The sweep closes it itself (closeAutomationSend), whichever way the
          // claim was taken.
          alreadyLogged: true,
          ...template,
        });

        if (sendResult.success) {
          await closeAutomationSend(campaignType, target.referenceId, "sent", sendResult.providerMessageId);
          lastMarketingSentAt.set(target.email, Date.now());
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
