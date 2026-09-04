import "server-only";

import { supabaseAdmin } from "@/lib/supabase-server";
import { isRevenueOrderStatus, isSaleOrder, netOrderRevenue } from "@/lib/ledger";
import { readAllRowsBounded } from "@/lib/supabase-page";
import { AUTOMATION_KEYS, type AutomationKey } from "@/lib/email/automations";

/**
 * Per-automation performance, for the Admin → Email automations panel.
 *
 * Every number here comes from a row somebody wrote at the time the thing
 * happened, not from a join re-evaluated at read time. That is the same rule
 * the campaign report follows and for the same reason: attribution is a claim
 * about what was true when the order was placed, and deriving it live would let
 * a later automation quietly take credit for an earlier one's sales.
 *
 * WHAT EACH NUMBER IS AND IS NOT, because a rate is worse than no rate when it
 * is quietly measuring something else:
 *
 *   sends           email_send_log rows for `automation:<key>` that reached
 *                   'sent'. Rows still at 'sending' are excluded — a crashed
 *                   sweep leaves one behind and it is not evidence a message
 *                   went out.
 *   failed          Rows the provider refused. Left eligible for the next
 *                   sweep, so a high number here means a delivery problem, not
 *                   a lost customer.
 *   delivered       Joined EXACTLY, through provider_message_id, to what the
 *                   delivery webhook reported. Zero when the provider returns no
 *                   message id (SMTP) or no webhook is configured — which is why
 *                   it is reported alongside sends rather than as a percentage.
 *   opened          First-open stamps. Inflated by Apple Mail Privacy
 *                   Protection's pre-fetch and missing wherever images are
 *                   blocked; directional across sends of the SAME automation.
 *   clicks          Every click, including a customer who clicked four times.
 *   uniqueClicks    Distinct SENDS that were clicked at least once. This is the
 *                   number that belongs next to `sends`.
 *   orders          Orders whose PRIMARY marketing source is this automation
 *                   (marketing-source.ts) — a redeemed gift token or the
 *                   deciding click — counted only when they are real, paid
 *                   sales. One order is never two channels' revenue.
 *   assistedOrders  Orders this automation's link was clicked on but that were
 *                   credited elsewhere (a later campaign click, a redeemed gift
 *                   from another automation). Shown, never summed into revenue.
 *   revenue         NET of refunds, primary orders only.
 *   offersIssued    Gift tokens this automation minted (customer_offers rows
 *                   that carry its key).
 *   offersRedeemed  Of those, spent on a paid order.
 *   offersClosed    Of those, killed because the customer bought without using
 *                   them (a paid order closes the retention cycle).
 *   conversionRate  orders / sends.       revenuePerRecipient  revenue / sends.
 *   redemptionRate  offersRedeemed / offersIssued.
 *
 * THE RANGE applies to when the send went out, when the click happened, when
 * the order was placed and when the gift was issued — so "last 30 days" reads
 * as one consistent window rather than five different ones.
 *
 * A FAILED READ IS AN ERROR, NOT A ZERO. Before this a single failed query
 * showed every automation as "nothing has happened yet". The report now says
 * ok:false with the reason, and the panel renders that instead of numbers.
 */

export type StatsRangeKey = "7d" | "30d" | "90d" | "all";

export type StatsRange = {
  key: StatsRangeKey;
  /** ISO lower bound, or null for all time. */
  from: string | null;
  label: string;
};

const RANGE_DAYS: Record<Exclude<StatsRangeKey, "all">, number> = { "7d": 7, "30d": 30, "90d": 90 };

export function parseStatsRange(raw: unknown, now: number = Date.now()): StatsRange {
  const key = (typeof raw === "string" && raw in RANGE_DAYS) ? (raw as Exclude<StatsRangeKey, "all">) : raw === "all" ? "all" : "all";
  if (key === "all") return { key: "all", from: null, label: "All time" };
  const days = RANGE_DAYS[key];
  return { key, from: new Date(now - days * 24 * 60 * 60 * 1000).toISOString(), label: `Last ${days} days` };
}

export type AutomationStats = {
  key: AutomationKey;
  sends: number;
  failed: number;
  delivered: number;
  opened: number;
  clicks: number;
  uniqueClicks: number;
  orders: number;
  assistedOrders: number;
  revenue: number;
  offersIssued: number;
  offersRedeemed: number;
  offersClosed: number;
  /** null when there is no denominator yet. */
  conversionRate: number | null;
  revenuePerRecipient: number | null;
  redemptionRate: number | null;
};

export type AutomationStatsReport = {
  ok: boolean;
  /** Set when ok is false: what failed, in operator terms. */
  error?: string;
  /** True when a read hit its row ceiling and the numbers understate. */
  truncated: boolean;
  range: StatsRange;
  byKey: Record<string, AutomationStats>;
};

const EMPTY = (key: AutomationKey): AutomationStats => ({
  key,
  sends: 0,
  failed: 0,
  delivered: 0,
  opened: 0,
  clicks: 0,
  uniqueClicks: 0,
  orders: 0,
  assistedOrders: 0,
  revenue: 0,
  offersIssued: 0,
  offersRedeemed: 0,
  offersClosed: 0,
  conversionRate: null,
  revenuePerRecipient: null,
  redemptionRate: null,
});

export function emptyAutomationStatsReport(range: StatsRange, error?: string): AutomationStatsReport {
  const byKey: Record<string, AutomationStats> = {};
  for (const key of AUTOMATION_KEYS) byKey[key] = EMPTY(key);
  return { ok: !error, error, truncated: false, range, byKey };
}

/** `automation:winback_30` → `winback_30`, or null for any other send. */
function keyFromCampaignType(campaignType: string): AutomationKey | null {
  if (!campaignType.startsWith("automation:")) return null;
  const key = campaignType.slice("automation:".length);
  return (AUTOMATION_KEYS as readonly string[]).includes(key) ? (key as AutomationKey) : null;
}

/**
 * Roll every automation up in one pass, for one range.
 *
 * Never throws — the automations panel must still render its editing controls
 * when reporting is unavailable — but it never pretends either: a failed read
 * comes back as ok:false with the reason, and a truncated one says so.
 */
export async function loadAutomationStats(range: StatsRange = parseStatsRange("all")): Promise<AutomationStatsReport> {
  const report = emptyAutomationStatsReport(range);
  const from = range.from;

  try {
    const sendRead = readAllRowsBounded<{
      campaign_type: string;
      status: string | null;
      opened_at: string | null;
      clicked_at: string | null;
      provider_message_id: string | null;
    }>(
      (lo, hi) => {
        let q = supabaseAdmin
          .from("email_send_log")
          .select("campaign_type, status, opened_at, clicked_at, provider_message_id")
          .like("campaign_type", "automation:%");
        if (from) q = q.gte("sent_at", from);
        return q.order("campaign_type", { ascending: true }).range(lo, hi);
      },
      { maxRows: 500_000, label: "automation send-log read" },
    );
    const clickRead = readAllRowsBounded<{ automation_key: string }>(
      (lo, hi) => {
        let q = supabaseAdmin.from("email_automation_clicks").select("automation_key");
        if (from) q = q.gte("clicked_at", from);
        return q.order("automation_key", { ascending: true }).range(lo, hi);
      },
      { maxRows: 500_000, label: "automation click read" },
    );
    const orderRead = readAllRowsBounded<{
      attributed_automation_key: string | null;
      marketing_source_kind: string | null;
      marketing_source_ref: string | null;
      payment_status: string;
      order_type: string | null;
      amount_paid: number | null;
      refund_amount: number | null;
    }>(
      (lo, hi) => {
        let q = supabaseAdmin
          .from("orders")
          .select("attributed_automation_key, marketing_source_kind, marketing_source_ref, payment_status, order_type, amount_paid, refund_amount")
          // Primary credit OR an assisting click: both are read, and told apart below.
          .or("marketing_source_kind.eq.automation,attributed_automation_key.not.is.null");
        if (from) q = q.gte("created_at", from);
        return q.order("order_id", { ascending: true }).range(lo, hi);
      },
      { maxRows: 500_000, label: "automation attribution read" },
    );
    const offerRead = readAllRowsBounded<{
      automation_key: string | null;
      redeemed_at: string | null;
      revoke_reason: string | null;
    }>(
      (lo, hi) => {
        let q = supabaseAdmin
          .from("customer_offers")
          .select("automation_key, redeemed_at, revoke_reason")
          .not("automation_key", "is", null);
        if (from) q = q.gte("issued_at", from);
        return q.order("issued_at", { ascending: true }).range(lo, hi);
      },
      { maxRows: 500_000, label: "automation offer read" },
    );

    const [sends, clicks, orders, offers] = await Promise.all([sendRead, clickRead, orderRead, offerRead]);
    report.truncated = sends.truncated || clicks.truncated || orders.truncated || offers.truncated;

    // The message ids worth asking the delivery log about — only sends that
    // actually carry one, so a store on SMTP does not issue a pointless query.
    const messageIds = sends.rows
      .map((row) => row.provider_message_id)
      .filter((id): id is string => Boolean(id));
    const deliveredIds = messageIds.length > 0 ? await loadDeliveredMessageIds(messageIds) : new Set<string>();

    for (const row of sends.rows) {
      const key = keyFromCampaignType(String(row.campaign_type ?? ""));
      if (!key) continue;
      const entry = report.byKey[key];
      const status = String(row.status ?? "");
      if (status === "sent") entry.sends++;
      else if (status === "failed") entry.failed++;
      // 'sending' is in flight or orphaned by a crashed sweep. Neither is a
      // send, and neither is a failure.
      if (row.opened_at) entry.opened++;
      if (row.clicked_at) entry.uniqueClicks++;
      if (row.provider_message_id && deliveredIds.has(row.provider_message_id)) entry.delivered++;
    }

    for (const row of clicks.rows) {
      const key = String(row.automation_key ?? "");
      if (report.byKey[key]) report.byKey[key].clicks++;
    }

    for (const row of orders.rows) {
      if (!isRevenueOrderStatus(row.payment_status as string | null)) continue;
      if (!isSaleOrder(row.order_type)) continue;
      const primaryKey = row.marketing_source_kind === "automation" ? String(row.marketing_source_ref ?? "") : "";
      const primary = report.byKey[primaryKey];
      if (primary) {
        primary.orders++;
        primary.revenue += netOrderRevenue(row);
      }
      const touchedKey = String(row.attributed_automation_key ?? "");
      if (touchedKey && touchedKey !== primaryKey && report.byKey[touchedKey]) {
        report.byKey[touchedKey].assistedOrders++;
      }
    }

    for (const row of offers.rows) {
      const entry = report.byKey[String(row.automation_key ?? "")];
      if (!entry) continue;
      entry.offersIssued++;
      if (row.redeemed_at) entry.offersRedeemed++;
      else if (row.revoke_reason === "cycle_closed") entry.offersClosed++;
    }

    for (const key of AUTOMATION_KEYS) {
      const entry = report.byKey[key];
      entry.revenue = Math.round(entry.revenue * 100) / 100;
      entry.conversionRate = entry.sends > 0 ? entry.orders / entry.sends : null;
      entry.revenuePerRecipient = entry.sends > 0 ? Math.round((entry.revenue / entry.sends) * 100) / 100 : null;
      entry.redemptionRate = entry.offersIssued > 0 ? entry.offersRedeemed / entry.offersIssued : null;
    }

    report.ok = true;
    return report;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("[automations] stats unavailable", message);
    return emptyAutomationStatsReport(range, `Automation statistics could not be loaded: ${message}`);
  }
}

/**
 * Which of these message ids the provider told us it delivered.
 *
 * Chunked because this goes into a PostgREST `in.(…)` filter, which becomes a
 * URL — a store with tens of thousands of automation sends would otherwise
 * build a query string no proxy will forward.
 */
async function loadDeliveredMessageIds(messageIds: string[]): Promise<Set<string>> {
  const delivered = new Set<string>();
  const CHUNK = 200;
  const unique = [...new Set(messageIds)];
  for (let i = 0; i < unique.length; i += CHUNK) {
    const slice = unique.slice(i, i + CHUNK);
    const { data, error } = await supabaseAdmin
      .from("email_delivery_events")
      .select("provider_message_id")
      .eq("kind", "delivered")
      .in("provider_message_id", slice);
    if (error) {
      // A missing delivery-event table (an un-migrated database) must show as
      // "no delivery data", not as a broken automations panel.
      console.error("[automations] delivery-event read failed", error.message);
      return delivered;
    }
    for (const row of data ?? []) {
      const id = String((row as { provider_message_id?: string }).provider_message_id ?? "");
      if (id) delivered.add(id);
    }
  }
  return delivered;
}
