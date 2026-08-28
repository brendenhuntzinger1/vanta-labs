import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { isRevenueOrderStatus, isSaleOrder, netOrderRevenue } from "@/lib/ledger";

// ---------------------------------------------------------------------------
// PHASE 11, BUCKET 2 — the partner surfaces, held to the same two rules the
// rest of the reporting code is already held to:
//
//   1. Revenue is `netOrderRevenue` over REVENUE_ORDER_STATUSES with
//      replacements excluded (ledger.ts). partner-portal.ts had two paths that
//      still filtered on `payment_status === "paid"` and summed gross
//      `amount_paid`, so the ambassador's own "Sales generated" tile and the
//      admin's revenue column for the SAME partner disagreed with each other
//      and with the deployed admin_partner_rollups RPC.
//
//   2. A read with no `.range()` is not unbounded — PostgREST caps every
//      response at its `db-max-rows` (Supabase ships 1,000) and says nothing
//      when it does. The mock below therefore CAPS EVERY RESPONSE, exactly as
//      the server does. A caller that pages reads the whole table; a caller
//      that does not gets a plausible, silently short answer. That is the only
//      way a unit test can see this class of bug at all.
// ---------------------------------------------------------------------------

/**
 * What PostgREST will return in one response, however many rows match —
 * Supabase's shipped `db-max-rows`. It is deliberately LARGER than the URL id
 * limit below, as it is in production: that ordering is why a read that is
 * paged to exhaustion then needs its writes sliced.
 */
const PAGE_CAP = 1000;

/**
 * How many ids may go in one `in.(...)` filter before the request URL is too
 * long. PostgREST puts that filter in the URL, so a write built from a paged
 * read has to be sliced or it is a 414 rather than a write.
 */
const URL_ID_LIMIT = 150;

const tables: Record<string, Array<Record<string, unknown>>> = {};

type OrderKey = { column: string; ascending: boolean };

function sortRows(rows: Array<Record<string, unknown>>, keys: OrderKey[]) {
  if (keys.length === 0) return rows;
  return [...rows].sort((a, b) => {
    for (const key of keys) {
      const left = String(a[key.column] ?? "");
      const right = String(b[key.column] ?? "");
      if (left === right) continue;
      return (left < right ? -1 : 1) * (key.ascending ? 1 : -1);
    }
    return 0;
  });
}

function selectBuilder(rows: Array<Record<string, unknown>>, options?: { head?: boolean; count?: string }) {
  let working = [...rows];
  const keys: OrderKey[] = [];

  const settle = (data: Array<Record<string, unknown>> | null) => ({
    data,
    error: null,
    count: working.length,
  });

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
    gte(column: string, value: unknown) {
      working = working.filter((row) => row[column] != null && String(row[column]) >= String(value));
      return b;
    },
    lte: () => b,
    not: () => b,
    is: () => b,
    or: () => b,
    limit: () => b,
    order(column: string, opts?: { ascending?: boolean }) {
      keys.push({ column, ascending: opts?.ascending !== false });
      return b;
    },
    single: async () => ({ data: sortRows(working, keys)[0] ?? null, error: null }),
    maybeSingle: async () => ({ data: sortRows(working, keys)[0] ?? null, error: null }),
    range: async (from: number, to: number) =>
      settle(sortRows(working, keys).slice(from, to + 1).slice(0, PAGE_CAP)),
    then: (resolve: (value: unknown) => unknown) =>
      Promise.resolve(
        options?.head ? settle(null) : settle(sortRows(working, keys).slice(0, PAGE_CAP)),
      ).then(resolve),
  };
  return b;
}

function updateBuilder(table: string, patch: Record<string, unknown>) {
  const filters: Array<(row: Record<string, unknown>) => boolean> = [];
  let uriTooLong = false;

  const apply = (withSelect: boolean) => {
    if (uriTooLong) {
      return { data: null, error: { message: "414 Request-URI Too Large" } };
    }
    const matched = (tables[table] ?? []).filter((row) => filters.every((f) => f(row)));
    for (const row of matched) Object.assign(row, patch);
    return { data: withSelect ? matched.map((row) => ({ ...row })) : null, error: null };
  };

  const b: Record<string, unknown> = {
    eq(column: string, value: unknown) {
      filters.push((row) => String(row[column]) === String(value));
      return b;
    },
    in(column: string, values: unknown[]) {
      if (values.length > URL_ID_LIMIT) uriTooLong = true;
      const wanted = new Set(values.map(String));
      filters.push((row) => wanted.has(String(row[column])));
      return b;
    },
    select: async () => apply(true),
    then: (resolve: (value: unknown) => unknown) => Promise.resolve(apply(false)).then(resolve),
  };
  return b;
}

vi.mock("server-only", () => ({}));

vi.mock("@/lib/supabase-server", () => ({
  supabaseAdmin: {
    from: (table: string) => ({
      select: (_columns?: string, options?: { head?: boolean; count?: string }) =>
        selectBuilder(tables[table] ?? [], options),
      update: (patch: Record<string, unknown>) => updateBuilder(table, patch),
      insert: async (row: Record<string, unknown>) => {
        (tables[table] ??= []).push({ ...row });
        return { data: null, error: null };
      },
      delete: () => selectBuilder([]),
    }),
    // Force the JS fallback on every rollup RPC. The SQL bodies are guarded
    // textually by ledger-sql-parity.test.ts and executed against a real
    // Postgres by sql/bulk-savings-rollup-executed.test.ts; the point here is
    // the TypeScript twin that serves an un-migrated database.
    rpc: async () => ({ data: null, error: { message: "not migrated" } }),
  },
}));

vi.mock("@/lib/supabase-page", async (importOriginal) => await importOriginal());

vi.mock("@/lib/ambassador-settings", () => ({
  getAmbassadorProgramSettings: async () => ({ minimumPayoutThreshold: 25, commissionHoldDays: 14 }),
  getAmbassadorMarketingResources: async () => [],
}));

vi.mock("@/lib/admin-control", () => ({
  DEFAULT_REFERRAL_DISCOUNT_PERCENT: 10,
  getBusinessSettings: async () => ({}),
  getReferralProgramConfig: async () => ({ discountPercent: 10, personalDiscountPercent: 0 }),
}));

vi.mock("@/lib/env", () => ({ getSiteUrl: () => "https://example.test" }));

vi.mock("@/lib/email/send", () => ({ sendEmail: async () => ({ ok: true }) }));

const PARTNER_ID = "11111111-1111-1111-1111-111111111111";

/**
 * One order of every shape that has ever made two revenue surfaces disagree,
 * small enough to fit inside a single PostgREST page so this basket tests the
 * DEFINITION and nothing else.
 */
const BASKET = [
  { order_id: "o-paid", payment_status: "paid", order_type: "product", amount_paid: 200, refund_amount: 0 },
  { order_id: "o-partial", payment_status: "partially_refunded", order_type: "product", amount_paid: 200, refund_amount: 50 },
  { order_id: "o-refunded", payment_status: "refunded", order_type: "product", amount_paid: 200, refund_amount: 200 },
  // A reship the store paid for: `paid`, $0, under the original buyer's email.
  { order_id: "o-replacement", payment_status: "paid", order_type: "replacement", amount_paid: 0, refund_amount: 0 },
  { order_id: "o-pending", payment_status: "pending_payment", order_type: "product", amount_paid: 200, refund_amount: 0 },
].map((row) => ({
  ...row,
  id: row.order_id,
  ambassador_id: PARTNER_ID,
  customer_email: "buyer@example.test",
  created_at: "2026-08-26T00:00:00.000Z",
}));

const LEDGER_REVENUE = BASKET
  .filter((row) => isRevenueOrderStatus(row.payment_status) && isSaleOrder(row.order_type))
  .reduce((total, row) => total + netOrderRevenue(row), 0);

const LEDGER_SALES = BASKET
  .filter((row) => isRevenueOrderStatus(row.payment_status) && isSaleOrder(row.order_type)).length;

beforeEach(() => {
  for (const key of Object.keys(tables)) delete tables[key];
  tables.partners = [{
    id: PARTNER_ID,
    name: "Alex",
    email: "alex@example.test",
    referral_code: "ALEX-123456",
    status: "approved",
    commission_percent: 15,
    customer_discount_percent: null,
    payout_method: "paypal",
    payout_handle: "alex@example.test",
    updated_at: "2026-08-26T00:00:00.000Z",
  }];
  tables.ambassadors = [{
    id: PARTNER_ID,
    status: "approved",
    customer_discount_percent: 10,
    commission_percent: 15,
    commission_percent_locked: false,
  }];
  tables.orders = [];
  tables.referral_orders = [];
  tables.partner_clicks = [];
  tables.partner_payouts = [];
  tables.partner_program_stats = [];
  tables.commissions = [];
  tables.payouts = [];
  tables.admin_audit_logs = [];
  tables.products = [];
  tables.order_shipments = [];
  tables.coupons = [];
  tables.notification_queue = [];
});

describe("the basket the ledger describes", () => {
  it("is worth $350.00 across 2 sales", () => {
    // Anchors the derivation so the expectations below move deliberately.
    expect(LEDGER_REVENUE).toBeCloseTo(350, 2);
    expect(LEDGER_SALES).toBe(2);
  });
});

describe("M-06 — the partner revenue figures use the ledger's definition", () => {
  it("getPartnerSummary nets refunds and drops replacements", async () => {
    tables.orders = BASKET.map((row) => ({ ...row }));

    const { getPartnerSummary } = await import("@/lib/partner-portal");
    const summary = await getPartnerSummary(PARTNER_ID, "https://example.test");

    // Was $200 across 2 orders: the partially refunded order's surviving $150
    // was dropped entirely (its status is not "paid") while the $0 replacement
    // reship counted as one of the ambassador's orders.
    expect(summary.totalRevenue).toBeCloseTo(LEDGER_REVENUE, 2);
    expect(summary.totalOrders).toBe(LEDGER_SALES);
    expect(summary.averageOrderValue).toBeCloseTo(LEDGER_REVENUE / LEDGER_SALES, 2);

    // The chart under the tile has to total to the tile.
    const seriesTotal = summary.monthlyRevenueSeries.reduce((sum, point) => sum + point.value, 0);
    expect(seriesTotal).toBeCloseTo(LEDGER_REVENUE, 2);
  });

  it("getAdminPartnerRows' JS fallback reaches the same number as the RPC it replaces", async () => {
    tables.orders = BASKET.map((row) => ({ ...row }));

    const { getAdminPartnerRows } = await import("@/lib/partner-portal");
    const rows = await getAdminPartnerRows();
    const row = rows.find((candidate) => candidate.id === PARTNER_ID);

    // admin-partner-rollups.sql already nets refunds over REVENUE_ORDER_STATUSES
    // with replacements excluded, so before this the partner's revenue column
    // changed depending on whether that migration had been applied.
    expect(row?.totalRevenue).toBeCloseTo(LEDGER_REVENUE, 2);
    expect(row?.totalOrders).toBe(LEDGER_SALES);
  });
});

describe("DUP-09 — a replacement reship is not a repeat customer", () => {
  it("getAdminOperationsSummary's JS twin excludes replacements from the customer counts", async () => {
    tables.orders = [
      { id: "o-1", order_id: "o-1", payment_status: "paid", order_type: "product", amount_paid: 200, refund_amount: 0, customer_email: "buyer@example.test", created_at: "2026-08-26T00:00:00.000Z" },
      { id: "o-2", order_id: "o-2", payment_status: "paid", order_type: "replacement", amount_paid: 0, refund_amount: 0, customer_email: "buyer@example.test", created_at: "2026-08-26T00:00:00.000Z" },
    ];

    const { getAdminOperationsSummary } = await import("@/lib/partner-portal");
    const summary = await getAdminOperationsSummary();

    // One buyer, one purchase, one warranty reship. Counting the reship made
    // the store's repeat-purchase tile improve the more reships it sent.
    expect(summary.newCustomers).toBe(1);
    expect(summary.returningCustomers).toBe(0);
    expect(summary.returningCustomerRate).toBe(0);
  });

  it("admin_ops_summary's per_customer CTE carries the same exclusion", () => {
    // The SQL twin cannot be reached from a unit test, so its body is asserted
    // textually — the same technique handoff-invariants.test.ts uses. Without
    // this, fixing only the TypeScript side leaves a migrated database still
    // counting reships as repeat business.
    const sql = readFileSync(path.resolve(__dirname, "sql", "admin-dashboard-rollups.sql"), "utf8");
    const body = sql.slice(sql.indexOf("create or replace function public.admin_ops_summary"));
    const perCustomer = body.slice(body.indexOf("with per_customer as"), body.indexOf("group by customer_email"));

    expect(perCustomer).toContain("coalesce(order_type, 'product') <> 'replacement'");
  });
});

describe("a read with no .range() is not unbounded — PostgREST caps it silently", () => {
  it("getPartnerSummary reads every commission and every order, not the first page", async () => {
    // Both reads are DESCENDING, so a capped page drops the OLDEST rows first:
    // the long-unpaid pending and approved_for_payout commissions are exactly
    // the ones an ambassador is chasing.
    const orderCount = PAGE_CAP + 207;
    tables.orders = Array.from({ length: orderCount }, (_, index) => ({
      id: `ord-${String(index).padStart(4, "0")}`,
      order_id: `ord-${String(index).padStart(4, "0")}`,
      ambassador_id: PARTNER_ID,
      customer_email: `buyer-${index}@example.test`,
      payment_status: "paid",
      order_type: "product",
      amount_paid: 10,
      refund_amount: 0,
      created_at: `2026-08-${String((index % 27) + 1).padStart(2, "0")}T00:00:00.000Z`,
    }));
    tables.referral_orders = tables.orders.map((row, index) => ({
      id: `ref-${String(index).padStart(4, "0")}`,
      order_id: row.order_id,
      ambassador_id: PARTNER_ID,
      commission_amount: 1,
      payment_status: "approved_for_payout",
      created_at: row.created_at,
    }));
    tables.partner_clicks = Array.from({ length: PAGE_CAP + 500 }, (_, index) => ({
      id: `click-${index}`,
      ambassador_id: PARTNER_ID,
      created_at: "2026-08-26T00:00:00.000Z",
    }));

    const { getPartnerSummary } = await import("@/lib/partner-portal");
    const summary = await getPartnerSummary(PARTNER_ID, "https://example.test");

    expect(summary.totalOrders).toBe(orderCount);
    expect(summary.totalRevenue).toBeCloseTo(orderCount * 10, 2);
    expect(summary.totalEarnings).toBeCloseTo(orderCount * 1, 2);
    expect(summary.approvedCommissions).toBeCloseTo(orderCount * 1, 2);
    // The click count is the conversion-rate denominator; a capped read
    // inflated the rate by pretending the ambassador had fewer clicks.
    expect(summary.totalClicks).toBe(PAGE_CAP + 500);
  });

  it("getPartnerProgramStats totals every payout and every commission", async () => {
    const payoutCount = PAGE_CAP + 205;
    tables.partner_payouts = Array.from({ length: payoutCount }, (_, index) => ({
      id: `pay-${String(index).padStart(4, "0")}`,
      ambassador_id: PARTNER_ID,
      amount: 2,
    }));
    const commissionCount = PAGE_CAP + 100;
    tables.referral_orders = Array.from({ length: commissionCount }, (_, index) => ({
      id: `ref-${String(index).padStart(4, "0")}`,
      ambassador_id: PARTNER_ID,
      commission_amount: 3,
      payment_status: "paid",
    }));

    const { getPartnerProgramStats } = await import("@/lib/partner-portal");
    const stats = await getPartnerProgramStats();

    // This is served by the UNAUTHENTICATED /api/partner/program-stats, so a
    // capped read is a public number that silently stops growing.
    expect(stats.totalCommissionsPaid).toBeCloseTo(payoutCount * 2, 2);
    expect(stats.topPartnerPayout).toBeCloseTo(commissionCount * 3, 2);
    expect(stats.averagePartnerEarnings).toBeCloseTo(commissionCount * 3, 2);
  });

  it("markCommissionsPaid claims a whole page of commissions in URL-safe slices", async () => {
    // One PostgREST page of approved commissions is ~1,000 ids, and PostgREST
    // puts an `in.(...)` filter in the REQUEST URL — so the claim, the payout
    // link and the mirror flip were all a 414 rather than a write well before
    // the read itself ran short. The mock rejects an over-long filter the way
    // the server does.
    const commissionCount = URL_ID_LIMIT * 2 + 40;
    tables.referral_orders = Array.from({ length: commissionCount }, (_, index) => ({
      id: `ref-${String(index).padStart(4, "0")}`,
      order_id: `ord-${String(index).padStart(4, "0")}`,
      ambassador_id: PARTNER_ID,
      commission_amount: 1,
      payment_status: "approved_for_payout",
    }));
    tables.commissions = tables.referral_orders.map((row) => ({
      order_id: row.order_id,
      partner_id: PARTNER_ID,
      status: "approved_for_payout",
    }));

    const { markCommissionsPaid } = await import("@/lib/partner-portal");
    const result = await markCommissionsPaid({
      partnerId: PARTNER_ID,
      amount: 0,
      confirmedTransferred: true,
    });

    expect(result.orderCount).toBe(commissionCount);
    expect(result.amount).toBeCloseTo(commissionCount, 2);
    expect(tables.referral_orders.every((row) => row.payment_status === "paid")).toBe(true);
    // One payout row for the whole balance, not one per slice.
    expect(tables.partner_payouts).toHaveLength(1);
    expect(Number(tables.partner_payouts[0].amount)).toBeCloseTo(commissionCount, 2);
    // Every claimed commission is linked to it, so the payout stays reversible,
    // and the display mirror is flipped for every one of them.
    expect(tables.referral_orders.every((row) => row.payout_id === tables.partner_payouts[0].id)).toBe(true);
    expect(tables.commissions.every((row) => row.status === "paid")).toBe(true);
  });
});
