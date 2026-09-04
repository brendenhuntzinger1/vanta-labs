import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// THE AUTOMATIONS PANEL COUNTS ONE CHANNEL PER ORDER, AND NEVER LIES WITH ZEROES.
//
//   * an order is this automation's ORDER (and revenue) only when the primary
//     marketing source names it; a click on its link that was credited
//     elsewhere is ASSISTED, shown but never summed;
//   * gifts issued / redeemed / closed come from the rows the sweep minted;
//   * the rates have honest denominators (null until there is one);
//   * a failed read is ok:false with a reason, not a row of zeroes.
// ---------------------------------------------------------------------------

vi.mock("server-only", () => ({}));

type Row = Record<string, unknown>;
const db = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  failTable: null as string | null,
  gteCalls: [] as Array<{ table: string; column: string; value: string }>,
}));

vi.mock("@/lib/supabase-server", () => {
  const from = (table: string) => {
    const filters: Array<(row: Row) => boolean> = [];
    let range: [number, number] = [0, 999];
    const builder: Record<string, unknown> = {
      select: () => builder,
      like: (col: string, pattern: string) => { const prefix = pattern.replace(/%$/, ""); filters.push((r) => String(r[col] ?? "").startsWith(prefix)); return builder; },
      eq: (col: string, value: unknown) => { filters.push((r) => r[col] === value); return builder; },
      in: (col: string, values: unknown[]) => { filters.push((r) => values.includes(r[col])); return builder; },
      not: (col: string, _op: string, value: unknown) => { filters.push((r) => r[col] !== value && r[col] !== undefined); return builder; },
      or: (clauses: string) => {
        filters.push((r) => clauses.split(",").some((clause) => {
          const [col, op, ...rest] = clause.split(".");
          const v = rest.join(".");
          if (op === "eq") return String(r[col]) === v;
          if (op === "not" && v === "is.null") return r[col] !== null && r[col] !== undefined;
          return false;
        }));
        return builder;
      },
      gte: (col: string, value: string) => { db.gteCalls.push({ table, column: col, value }); filters.push((r) => String(r[col] ?? "") >= value); return builder; },
      order: () => builder,
      range: (lo: number, hi: number) => { range = [lo, hi]; return builder; },
      then: (resolve: (v: unknown) => unknown) => {
        if (db.failTable === table) return Promise.resolve({ data: null, error: { message: `${table} exploded` } }).then(resolve);
        const rows = (db.tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
        return Promise.resolve({ data: rows.slice(range[0], range[1] + 1), error: null }).then(resolve);
      },
    };
    return builder;
  };
  return { supabaseAdmin: { from } };
});

import { loadAutomationStats, parseStatsRange } from "@/lib/email/automation-stats";

beforeEach(() => {
  db.failTable = null;
  db.gteCalls = [];
  db.tables = {
    email_send_log: [
      { campaign_type: "automation:winback_30", status: "sent", opened_at: "x", clicked_at: "x", provider_message_id: "m1", sent_at: "2026-09-01T00:00:00.000Z" },
      { campaign_type: "automation:winback_30", status: "sent", opened_at: null, clicked_at: null, provider_message_id: "m2", sent_at: "2026-09-02T00:00:00.000Z" },
      { campaign_type: "automation:winback_30", status: "failed", opened_at: null, clicked_at: null, provider_message_id: null, sent_at: "2026-09-02T00:00:00.000Z" },
      { campaign_type: "automation:winback_30", status: "sending", opened_at: null, clicked_at: null, provider_message_id: null, sent_at: "2026-09-02T00:00:00.000Z" },
      { campaign_type: "automation:welcome_no_purchase", status: "sent", opened_at: null, clicked_at: "x", provider_message_id: null, sent_at: "2026-06-01T00:00:00.000Z" },
    ],
    email_delivery_events: [{ provider_message_id: "m1", kind: "delivered" }],
    email_automation_clicks: [
      { automation_key: "winback_30", clicked_at: "2026-09-01T01:00:00.000Z" },
      { automation_key: "winback_30", clicked_at: "2026-09-01T02:00:00.000Z" },
      { automation_key: "welcome_no_purchase", clicked_at: "2026-06-02T00:00:00.000Z" },
    ],
    orders: [
      // Credited to winback_30 by a redeemed gift: counts.
      { order_id: "o1", attributed_automation_key: "winback_30", marketing_source_kind: "automation", marketing_source_ref: "winback_30", payment_status: "paid", order_type: "product", amount_paid: 100, refund_amount: 0, created_at: "2026-09-02T00:00:00.000Z" },
      // Clicked winback_30 but credited to a campaign: ASSISTED only.
      { order_id: "o2", attributed_automation_key: "winback_30", marketing_source_kind: "campaign", marketing_source_ref: "camp-1", payment_status: "paid", order_type: "product", amount_paid: 80, refund_amount: 0, created_at: "2026-09-02T00:00:00.000Z" },
      // Credited to winback_30 but never paid: no revenue, no order.
      { order_id: "o3", attributed_automation_key: "winback_30", marketing_source_kind: "automation", marketing_source_ref: "winback_30", payment_status: "pending_payment", order_type: "product", amount_paid: 50, refund_amount: 0, created_at: "2026-09-02T00:00:00.000Z" },
      // Credited to winback_30, partially refunded: net counts.
      { order_id: "o4", attributed_automation_key: null, marketing_source_kind: "automation", marketing_source_ref: "winback_30", payment_status: "partially_refunded", order_type: "product", amount_paid: 60, refund_amount: 10, created_at: "2026-09-03T00:00:00.000Z" },
      // A replacement reship: never a sale.
      { order_id: "o5", attributed_automation_key: null, marketing_source_kind: "automation", marketing_source_ref: "winback_30", payment_status: "paid", order_type: "replacement", amount_paid: 0, refund_amount: 0, created_at: "2026-09-03T00:00:00.000Z" },
    ],
    customer_offers: [
      { automation_key: "winback_30", redeemed_at: "x", revoke_reason: null, issued_at: "2026-09-01T00:00:00.000Z" },
      { automation_key: "winback_30", redeemed_at: null, revoke_reason: "cycle_closed", issued_at: "2026-09-01T00:00:00.000Z" },
      { automation_key: "winback_30", redeemed_at: null, revoke_reason: null, issued_at: "2026-09-02T00:00:00.000Z" },
      { automation_key: "winback_30", redeemed_at: null, revoke_reason: "reissued", issued_at: "2026-09-02T00:00:00.000Z" },
      { automation_key: "welcome_no_purchase", redeemed_at: null, revoke_reason: null, issued_at: "2026-06-01T00:00:00.000Z" },
    ],
  };
});

describe("loadAutomationStats", () => {
  it("counts sends, delivery, opens, clicks and unique clicks per automation", async () => {
    const report = await loadAutomationStats(parseStatsRange("all"));
    expect(report.ok).toBe(true);
    const w = report.byKey.winback_30;
    expect(w.sends).toBe(2);
    expect(w.failed).toBe(1);
    expect(w.delivered).toBe(1);
    expect(w.opened).toBe(1);
    expect(w.uniqueClicks).toBe(1);
    expect(w.clicks).toBe(2);
  });

  it("credits ORDERS and REVENUE by the primary source only, and shows the rest as assisted", async () => {
    const report = await loadAutomationStats(parseStatsRange("all"));
    const w = report.byKey.winback_30;
    expect(w.orders).toBe(2);          // o1 + o4 (o3 unpaid, o5 a reship)
    expect(w.revenue).toBe(150);       // 100 + (60 - 10)
    expect(w.assistedOrders).toBe(1);  // o2
    expect(report.byKey.welcome_no_purchase.orders).toBe(0);
  });

  it("reports gifts issued, redeemed and closed by a purchase", async () => {
    const report = await loadAutomationStats(parseStatsRange("all"));
    const w = report.byKey.winback_30;
    expect(w.offersIssued).toBe(4);
    expect(w.offersRedeemed).toBe(1);
    expect(w.offersClosed).toBe(1);
  });

  it("computes rates with honest denominators", async () => {
    const report = await loadAutomationStats(parseStatsRange("all"));
    const w = report.byKey.winback_30;
    expect(w.conversionRate).toBe(1);            // 2 orders / 2 sends
    expect(w.revenuePerRecipient).toBe(75);      // 150 / 2
    expect(w.redemptionRate).toBe(0.25);         // 1 / 4
    expect(report.byKey.post_purchase.conversionRate).toBeNull();
    expect(report.byKey.post_purchase.redemptionRate).toBeNull();
  });

  it("applies the same window to sends, clicks, orders and gifts", async () => {
    const range = parseStatsRange("30d", Date.parse("2026-09-04T12:00:00.000Z"));
    const report = await loadAutomationStats(range);
    expect(report.range.key).toBe("30d");
    expect(report.range.from).toBe("2026-08-05T12:00:00.000Z");
    // The June welcome send, click and gift fall outside the window.
    expect(report.byKey.welcome_no_purchase.sends).toBe(0);
    expect(report.byKey.welcome_no_purchase.clicks).toBe(0);
    expect(report.byKey.welcome_no_purchase.offersIssued).toBe(0);
    expect(report.byKey.winback_30.sends).toBe(2);
    // readAllRowsBounded pages, so the same filter is applied once per page.
    const columns = [...new Set(db.gteCalls.map((c) => `${c.table}.${c.column}`))].sort();
    expect(columns).toEqual(["customer_offers.issued_at", "email_automation_clicks.clicked_at", "email_send_log.sent_at", "orders.created_at"]);
  });

  it("a failed read is an ERROR, not a row of zeroes", async () => {
    db.failTable = "orders";
    const report = await loadAutomationStats(parseStatsRange("all"));
    expect(report.ok).toBe(false);
    expect(report.error).toContain("orders exploded");
    expect(report.byKey.winback_30.sends).toBe(0);
  });

  it("parses the range from the query string and defaults to all time", () => {
    expect(parseStatsRange(undefined).key).toBe("all");
    expect(parseStatsRange("nonsense").key).toBe("all");
    expect(parseStatsRange("7d").label).toBe("Last 7 days");
    expect(parseStatsRange("90d").label).toBe("Last 90 days");
  });
});
