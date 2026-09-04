import { beforeEach, describe, expect, it, vi } from "vitest";
import { isRevenueOrderStatus, isSaleOrder, netOrderRevenue } from "@/lib/ledger";

// ---------------------------------------------------------------------------
// REVIEW FINDING 4 (P1) — THE SINGLE SOURCE OF TRUTH HAD ZERO CALL SITES.
//
// ledger.ts opens by declaring itself "the single source of truth every report,
// dashboard, and aggregation MUST use so no two surfaces ever disagree on what
// 'paid', 'earned commission', or 'revenue' means".
//
// `isRevenueOrderStatus` was exported, asserted on by ledger-sql-parity, and
// called by NOTHING. Actual adoption of the revenue rule was:
//
//   admin-revenue.ts    REVENUE_ORDER_STATUSES + NON_SALE_ORDER_TYPES   correct
//   admin-profit.ts     an inline RE-IMPLEMENTATION of the same rule    correct, twice written
//   admin-analytics.ts  isPaidOrderStatus                               WRONG
//   admin-email.ts      isPaidOrderStatus                               WRONG
//   best-sellers.ts     isPaidOrderStatus                               WRONG
//
// So a $200 order refunded by $50 was $150 on the revenue page and $0 on
// analytics and the campaign report, and replacements — free reships with
// amount_paid 0 — were excluded from two dashboards and counted by three.
//
// This file feeds ONE canonical basket to every surface and asserts they land on
// the same number. Testing each surface against its own hand-written expectation
// is what let five of them disagree in the first place: each was individually
// "correct" against its own belief.
// ---------------------------------------------------------------------------

/**
 * The basket. Every case that has ever made two surfaces disagree, once each.
 *
 * Revenue truth, derived from the ledger rather than restated:
 *   paid            200.00  counts in full
 *   partial refund  200.00 − 50.00 = 150.00   counts NET
 *   full refund       0.00  excluded (status), and netOrderRevenue would be 0 anyway
 *   replacement       0.00  excluded (order_type) — a reship the store paid for
 *   pending           0.00  excluded (status) — no money has moved
 */
const BASKET = [
  { order_id: "o-paid", payment_status: "paid", order_type: "product", amount_paid: 200, refund_amount: 0 },
  { order_id: "o-partial", payment_status: "partially_refunded", order_type: "product", amount_paid: 200, refund_amount: 50 },
  { order_id: "o-refunded", payment_status: "refunded", order_type: "product", amount_paid: 200, refund_amount: 200 },
  { order_id: "o-replacement", payment_status: "paid", order_type: "replacement", amount_paid: 0, refund_amount: 0 },
  // A replacement CARRYING MONEY — a reship where the customer covered postage.
  //
  // admin-replacements.ts hardcodes amount_paid: 0 today, so this row does not
  // occur yet, and it is here deliberately rather than speculatively: without it
  // the `amount <= 0` guard in admin-analytics masks the order_type filter
  // entirely, and removing that filter is a mutation no test can catch. Since
  // admin-revenue excludes replacements STRUCTURALLY (a server-side .neq), the
  // day a reship starts carrying postage is the day those two surfaces silently
  // disagree again. This row is what keeps the exclusion honest in the meantime.
  { order_id: "o-replacement-paid", payment_status: "paid", order_type: "replacement", amount_paid: 15, refund_amount: 0 },
  { order_id: "o-pending", payment_status: "pending_payment", order_type: "product", amount_paid: 200, refund_amount: 0 },
  // AN OVER-REFUNDED ORDER: more handed back than was ever collected, so its
  // net revenue is NEGATIVE. netOrderRevenue used to floor it at 0 while the
  // profit engine reported the loss, and admin-analytics dropped it outright
  // with an `amount <= 0` guard. It is in the basket so all four surfaces have
  // to reach the same signed number rather than three of them agreeing on a
  // zero that is not true.
  { order_id: "o-over", payment_status: "partially_refunded", order_type: "product", amount_paid: 100, refund_amount: 150 },
].map((row) => ({
  ...row,
  // Never-paid orders carry no paid_at. getRevenueWindowMetrics unions a
  // paid_at-window query with an `is(paid_at, null)` one, and the two are
  // disjoint only if this is modelled.
  bulk_discount_tier: "5_percent",
  paid_at: row.payment_status === "pending_payment" ? null : "2026-08-26T00:00:00.000Z",
  created_at: "2026-08-26T00:00:00.000Z",
  attributed_campaign_id: "campaign-1",
  // The campaign report now reads the PRIMARY source (marketing-source.ts),
  // which the migration backfills from attributed_campaign_id for orders
  // stamped before it existed — so this fixture carries both, as production does.
  marketing_source_kind: "campaign",
  marketing_source_ref: "campaign-1",
  marketing_source_basis: "click",
}));

/** What the ledger says the basket is worth. Not a hand-typed constant. */
const LEDGER_REVENUE = BASKET
  .filter((row) => isRevenueOrderStatus(row.payment_status) && isSaleOrder(row.order_type))
  .reduce((total, row) => total + netOrderRevenue(row), 0);

/** What the ledger says counts as a SALE in the basket. */
const LEDGER_SALES = BASKET
  .filter((row) => isRevenueOrderStatus(row.payment_status) && isSaleOrder(row.order_type)).length;

vi.mock("server-only", () => ({}));

/**
 * Enough PostgREST to page. `.range(from, to)` MUST slice — a builder that
 * returns the same rows for every page turns readAllRowsBounded into a loop that
 * re-counts the basket until it hits its own cap, which is how the first run of
 * this file reported campaign revenue of $20,000,000.
 *
 * `.neq(column, value)` is honoured because that is how a caller excludes
 * replacements server-side; a double that ignores it would let a surface claim
 * an exclusion it never made.
 */
function selectBuilder(rows: Array<Record<string, unknown>>) {
  let working = [...rows];
  const b: Record<string, unknown> = {
    eq(column: string, value: unknown) {
      working = working.filter((row) => String(row[column]) === String(value));
      return b;
    },
    neq(column: string, value: unknown) {
      working = working.filter((row) => String(row[column]) !== String(value));
      return b;
    },
    in(column: string, values: unknown[]) {
      const wanted = new Set(values.map(String));
      working = working.filter((row) => wanted.has(String(row[column])));
      return b;
    },
    not: () => b,
    is(column: string, value: unknown) {
      if (value === null) working = working.filter((row) => row[column] === null || row[column] === undefined);
      return b;
    },
    gte(column: string, value: unknown) {
      working = working.filter((row) => row[column] != null && String(row[column]) >= String(value));
      return b;
    },
    lte: () => b,
    gt: () => b,
    lt: () => b,
    order: () => b,
    limit: () => b,
    range: async (from: number, to: number) => ({
      data: working.slice(from, to + 1),
      error: null,
      count: working.length,
    }),
    then: (resolve: (v: unknown) => unknown) =>
      Promise.resolve({ data: working, error: null, count: working.length }).then(resolve),
  };
  return b;
}

const tables: Record<string, unknown[]> = {};

vi.mock("@/lib/supabase-server", () => ({
  supabaseAdmin: {
    from: (table: string) => ({
      select: () => selectBuilder((tables[table] ?? []) as Array<Record<string, unknown>>),
    }),
    // Force the JS fallback path everywhere: the RPCs are covered separately by
    // ledger-sql-parity, and the point here is the TypeScript definition.
    rpc: async () => ({ data: null, error: { message: "not migrated" } }),
  },
}));

vi.mock("@/lib/supabase-page", async (importOriginal) => await importOriginal());

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of Object.keys(tables)) delete tables[key];
  tables.orders = BASKET;
  tables.order_items = [
    { order_id: "o-paid", product_id: "bpc-157", quantity: 1 },
    { order_id: "o-partial", product_id: "bpc-157", quantity: 1 },
    { order_id: "o-replacement", product_id: "tb-500", quantity: 5 },
  ];
  // audience_kind is NOT NULL DEFAULT 'customer' in the schema, so a real row
  // always carries it — and getEmailDashboard filters on it to keep affiliate
  // broadcasts out of the customer campaign report. The fixture models the
  // column rather than relying on its absence.
  tables.email_campaigns = [{ id: "campaign-1", name: "C", status: "sent", subject: "s", audience_kind: "customer" }];
  tables.email_sends = [];
});

describe("the basket the ledger describes", () => {
  it("is worth $300.00 — paid in full, what a partial refund left, less an over-refund", () => {
    // Anchors the derivation. If this changes, every expectation below moves
    // with it deliberately rather than silently.
    //
    // 200 (paid) + 150 (200 less a 50 refund) - 50 (100 collected, 150 handed
    // back). The last term is the one that used to be floored at zero, and the
    // surfaces below now have to carry it too rather than each rounding the
    // loss away in its own way.
    expect(LEDGER_REVENUE).toBeCloseTo(300, 2);
    expect(LEDGER_SALES).toBe(3);
  });

  it("counts a replacement as neither revenue nor a sale", () => {
    expect(isSaleOrder("replacement")).toBe(false);
    // ...but a membership IS a sale. Nothing here may be used to drop it.
    expect(isSaleOrder("membership")).toBe(true);
  });
});

describe("every revenue surface agrees with the ledger", () => {
  it("admin-analytics revenue windows", async () => {
    const { getRevenueWindowMetrics } = await import("@/lib/admin-analytics");
    const metrics = await getRevenueWindowMetrics();

    // Was $200: the partial refund's surviving $150 was dropped entirely
    // because `partially_refunded` is not in PAID_ORDER_STATUSES.
    expect(metrics.last30Days).toBeCloseTo(LEDGER_REVENUE, 2);
  });

  it("admin-analytics revenue trend", async () => {
    const { getRevenueTrend } = await import("@/lib/admin-analytics");
    const trend = await getRevenueTrend({
      fromIso: "2026-08-20T00:00:00.000Z",
      toIso: "2026-08-27T00:00:00.000Z",
    } as never);
    const total = trend.reduce((sum: number, point: { amount: number }) => sum + point.amount, 0);

    expect(total).toBeCloseTo(LEDGER_REVENUE, 2);
  });

  it("admin-email campaign revenue", async () => {
    const { getEmailDashboard } = await import("@/lib/admin-email");
    const dashboard = await getEmailDashboard();
    const campaign = dashboard.campaigns.find((c) => c.id === "campaign-1");

    expect(campaign?.revenue).toBeCloseTo(LEDGER_REVENUE, 2);
    // The order COUNT matters too: a replacement has amount_paid 0, so it adds
    // nothing to revenue but silently inflates the denominator of any
    // revenue-per-order figure derived from it.
    expect(campaign?.orders).toBe(LEDGER_SALES);
  });

  it("bulk-savings tier stats, on the JS fallback production actually runs", async () => {
    // The RPC is mocked as unmigrated above, which is production's real state —
    // so this is the path that serves the dashboard today. It summed GROSS
    // amount_paid over EVERY status, and the RPC did the same, so the two
    // "agreed" while both reported roughly three times the truth.
    const { getBulkSavingsStats } = await import("@/lib/admin-membership");
    const stats = await getBulkSavingsStats();

    expect(stats.tier5PercentRevenueCents).toBe(Math.round(LEDGER_REVENUE * 100));
    expect(stats.tier5PercentOrders).toBe(LEDGER_SALES);
  });

  it("best-sellers counts units from sales only", async () => {
    const { getBestSellerSlugs } = await import("@/lib/best-sellers");
    const slugs = await getBestSellerSlugs(10);

    // bpc-157 sold on the paid order AND on the partially-refunded one — those
    // units really were sold. tb-500 moved only as a free replacement, which is
    // an outbound reship the store paid for, not a sale; ranking it as a best
    // seller promotes the product that generated a problem.
    expect(slugs.has("bpc-157")).toBe(true);
    expect(slugs.has("tb-500")).toBe(false);
  });
});
