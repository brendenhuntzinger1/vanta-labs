import "server-only";

import { supabaseAdmin } from "@/lib/supabase-server";
import { sendMarketingEmail } from "@/lib/email/marketing";
import { campaignTemplate } from "@/lib/email/templates";
import { getEmailRuntimeConfig, marketingBlockedReason } from "@/lib/email/settings";
import { loadConsentedAudience } from "@/lib/email/audience";
import { isPaidOrderStatus } from "@/lib/ledger";
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
    .select("key, enabled, delay_days, subject, headline, body, promo_code, cta_label, cta_path, updated_at")
    .order("key");
  if (error) throw error;
  return (data ?? []).filter((row) => isAutomationKey(row.key)) as AutomationRow[];
}

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

  const site = getSiteUrl().replace(/\/$/, "");

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
        // Automations link straight to the destination rather than through the
        // campaign click tracker: click attribution is keyed on a campaign id,
        // and these have none. Their value is measured by orders following the
        // send, not by a per-click stamp.
        const path = automation.cta_path.startsWith("/") && !automation.cta_path.startsWith("//")
          ? automation.cta_path
          : "/products";

        const template = campaignTemplate({
          subject: automation.subject,
          previewText: automation.headline,
          headline: automation.headline,
          body: automation.body,
          promoCode: automation.promo_code,
          ctaLabel: automation.cta_label,
          ctaUrl: `${site}${path}`,
          postalAddress: config.marketingPostalAddress,
        });

        const sendResult = await sendMarketingEmail({
          to: target.email,
          campaignType: `automation:${automation.key}`,
          referenceId: target.referenceId,
          templateKey: `automation_${automation.key}`,
          ...template,
        });

        if (sendResult.success) {
          result.sent++;
          result.byKey[automation.key] = (result.byKey[automation.key] ?? 0) + 1;
        } else if (sendResult.suppressed) {
          result.skipped++;
        } else {
          result.failed++;
        }
      }
    } catch (error) {
      result.errors.push(`${automation.key}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return result;
}
