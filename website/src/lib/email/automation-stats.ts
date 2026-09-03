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
 *   sends      email_send_log rows for `automation:<key>` that reached 'sent'.
 *              Rows still at 'sending' are excluded — a crashed sweep leaves
 *              one behind and it is not evidence a message went out.
 *   failed     Rows the provider refused. Left eligible for the next sweep, so
 *              a high number here means a delivery problem, not a lost customer.
 *   delivered  Joined EXACTLY, through provider_message_id, to what the
 *              delivery webhook reported. Zero when the provider returns no
 *              message id (SMTP) or no webhook is configured — which is why it
 *              is reported alongside sends rather than as a percentage of them.
 *   opened     First-open stamps. Inflated by Apple Mail Privacy Protection's
 *              pre-fetch and missing wherever images are blocked; directional
 *              across sends of the SAME automation and meaningless between
 *              audiences.
 *   clicks     Every click, including a customer who clicked four times.
 *   unique     Distinct SENDS that were clicked at least once. This is the
 *              number that belongs next to `sends`; `clicks` does not.
 *   orders     Orders whose attribution cookie named this automation, counted
 *              only when they are real sales — free replacement reships are
 *              excluded so they cannot pad the denominator of revenue-per-order.
 *   revenue    NET of refunds, matching every other revenue figure in the
 *              admin. Gross would flatter exactly the automation you would most
 *              want to notice.
 */

export type AutomationStats = {
  key: AutomationKey;
  sends: number;
  failed: number;
  delivered: number;
  opened: number;
  clicks: number;
  uniqueClicks: number;
  orders: number;
  revenue: number;
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
  revenue: 0,
});

/** `automation:winback_30` → `winback_30`, or null for any other send. */
function keyFromCampaignType(campaignType: string): AutomationKey | null {
  if (!campaignType.startsWith("automation:")) return null;
  const key = campaignType.slice("automation:".length);
  return (AUTOMATION_KEYS as readonly string[]).includes(key) ? (key as AutomationKey) : null;
}

/**
 * Roll every automation up in one pass.
 *
 * Reads are bounded rather than unbounded, and a short read misstates a rate
 * rather than mailing anyone — the same trade the campaign dashboard makes.
 * This never throws: the automations panel must still render its editing
 * controls when reporting is unavailable, because an operator locked out of
 * changing the copy because a stats query failed is a worse outcome than an
 * operator looking at zeroes.
 */
export async function loadAutomationStats(): Promise<Record<string, AutomationStats>> {
  const stats: Record<string, AutomationStats> = {};
  for (const key of AUTOMATION_KEYS) stats[key] = EMPTY(key);

  try {
    const [sendRows, clickRows, orderRows] = await Promise.all([
      readAllRowsBounded<{
        campaign_type: string;
        status: string | null;
        opened_at: string | null;
        clicked_at: string | null;
        provider_message_id: string | null;
      }>(
        (from, to) => supabaseAdmin
          .from("email_send_log")
          .select("campaign_type, status, opened_at, clicked_at, provider_message_id")
          .like("campaign_type", "automation:%")
          .order("campaign_type", { ascending: true })
          .range(from, to),
        { maxRows: 500_000, label: "automation send-log read" },
      ).then((r) => r.rows),
      readAllRowsBounded<{ automation_key: string }>(
        (from, to) => supabaseAdmin
          .from("email_automation_clicks")
          .select("automation_key")
          .order("automation_key", { ascending: true })
          .range(from, to),
        { maxRows: 500_000, label: "automation click read" },
      ).then((r) => r.rows),
      readAllRowsBounded<{
        attributed_automation_key: string;
        payment_status: string;
        order_type: string | null;
        amount_paid: number | null;
        refund_amount: number | null;
      }>(
        (from, to) => supabaseAdmin
          .from("orders")
          .select("attributed_automation_key, payment_status, order_type, amount_paid, refund_amount")
          .not("attributed_automation_key", "is", null)
          .order("attributed_automation_key", { ascending: true })
          .range(from, to),
        { maxRows: 500_000, label: "automation attribution read" },
      ).then((r) => r.rows),
    ]);

    // The message ids worth asking the delivery log about — only sends that
    // actually carry one, so a store on SMTP does not issue a pointless query.
    const messageIds = sendRows
      .map((row) => row.provider_message_id)
      .filter((id): id is string => Boolean(id));

    const deliveredIds = messageIds.length > 0 ? await loadDeliveredMessageIds(messageIds) : new Set<string>();

    for (const row of sendRows) {
      const key = keyFromCampaignType(String(row.campaign_type ?? ""));
      if (!key) continue;
      const entry = stats[key];
      const status = String(row.status ?? "");
      if (status === "sent") entry.sends++;
      else if (status === "failed") entry.failed++;
      // 'sending' is in flight or orphaned by a crashed sweep. Neither is a
      // send, and neither is a failure.
      if (row.opened_at) entry.opened++;
      if (row.clicked_at) entry.uniqueClicks++;
      if (row.provider_message_id && deliveredIds.has(row.provider_message_id)) entry.delivered++;
    }

    for (const row of clickRows) {
      const key = String(row.automation_key ?? "");
      if (stats[key]) stats[key].clicks++;
    }

    for (const row of orderRows) {
      if (!isRevenueOrderStatus(row.payment_status as string | null)) continue;
      if (!isSaleOrder(row.order_type)) continue;
      const key = String(row.attributed_automation_key ?? "");
      const entry = stats[key];
      if (!entry) continue;
      entry.orders++;
      entry.revenue += netOrderRevenue(row);
    }
  } catch (error) {
    console.error("[automations] stats unavailable", error);
  }

  return stats;
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
