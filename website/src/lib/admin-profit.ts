import "server-only";

import { supabaseAdmin } from "@/lib/supabase-server";
import { getProfitSettings, type ProfitSettingsConfig } from "@/lib/admin-control";
import { computeOrderProfit, type OrderProfitLine, type OrderProfitResult } from "@/lib/order-profit";
import { isEarnedCommission, isRevenueOrderStatus, isSaleOrder } from "@/lib/ledger";
import { readAllRowsBounded } from "@/lib/supabase-page";

// The order fields profit needs. Everything is stored on the order at checkout,
// so profit is computed from the record — not from today's live product cost.
// tax_amount is carried for display (never profit); the actual/estimated
// shipping columns drive the estimate→exact reconciliation.
const ORDER_FIELDS =
  "order_id, order_number, order_type, subtotal, discount_amount, shipping_amount, tax_amount, refund_amount, amount_paid, payment_method, payment_status, paid_at, created_at, shipping_protection_fee, card_processing_fee, store_credit_redeemed_cents, points_redeemed";

type OrderRecord = {
  order_id: string;
  order_number?: string | null;
  order_type?: string | null;
  subtotal: number | null;
  discount_amount: number | null;
  shipping_amount: number | null;
  tax_amount: number | null;
  refund_amount: number | null;
  amount_paid: number | null;
  shipping_protection_fee?: number | null;
  card_processing_fee?: number | null;
  store_credit_redeemed_cents?: number | null;
  points_redeemed?: number | null;
  payment_method: string | null;
  payment_status: string | null;
  paid_at: string | null;
  created_at: string | null;
};

// Per-order overlay of the exact shipping cost once it's reconciled in. Read
// separately (and tolerantly) so the whole profit report still works before the
// order-profit-shipping-reconciliation.sql migration has been run — until then
// every order simply uses the estimated shipping cost.
type ShippingOverlay = {
  actualShippingCostCents: number | null;
  source: string | null;
  finalized: boolean;
};

export interface OrderProfit extends OrderProfitResult {
  /**
   * `product`, `membership`, or `replacement`.
   *
   * A REPLACEMENT is a real shipment with real cost and NO revenue. Its costs
   * belong in every total; the order itself is not a sale and must never be
   * counted as one, or 100 sales plus 3 reships reports 103 orders and drags
   * average order value down with three $0 denominators.
   */
  orderType: string | null;
  orderId: string;
  orderNumber: string | null;
  paidAt: string | null;
  createdAt: string | null;
  /** Where the exact shipping cost came from (null while still estimated). */
  shippingCostSource: string | null;
}

// Peer-to-peer / off-platform methods settle with no card-processor fee. The
// live catalog only offers card today, but this keeps the math correct if a
// manual method is ever enabled.
const MANUAL_HINTS = ["cash", "zelle", "venmo", "paypal", "manual", "wire", "ach", "bank"];
function isManualMethod(method: string | null): boolean {
  const m = (method ?? "").toLowerCase();
  return MANUAL_HINTS.some((hint) => m.includes(hint));
}

function processingFeeFor(order: OrderRecord, config: ProfitSettingsConfig): number {
  if (isManualMethod(order.payment_method)) return 0;
  const charged = Number(order.amount_paid ?? 0);
  if (!Number.isFinite(charged) || charged <= 0) return 0;
  // The processor charges on the full transaction by default; config can
  // exclude collected sales tax from the fee base.
  const base = config.processingFeeIncludesTax
    ? charged
    : Math.max(0, charged - Number(order.tax_amount ?? 0));
  return Math.max(0, base * (config.processingFeePercent / 100));
}

// The tax that came back with a refund. Nothing records it, so it is derived
// from the two figures that exist: what the customer paid (tax included) and
// what was returned. A full refund gives a ratio of exactly 1. Mirrors
// admin-tax-report.refundedTaxFor so the profit report and the filing report
// cannot disagree about the same refund.
function refundedTaxPortion(amountPaid: number, taxCollected: number, refund: number): number {
  if (taxCollected <= 0 || refund <= 0) return 0;
  if (amountPaid <= 0) return taxCollected;
  return Math.round(Math.min(taxCollected, taxCollected * Math.min(1, refund / amountPaid)) * 100) / 100;
}

function profitForOrder(
  order: OrderRecord,
  lines: OrderProfitLine[],
  commission: number,
  config: ProfitSettingsConfig,
  overlay: ShippingOverlay | undefined,
): OrderProfitResult {
  const merch = Math.max(0, Number(order.subtotal ?? 0) - Number(order.discount_amount ?? 0));
  const shippingRevenue = Math.max(0, Number(order.shipping_amount ?? 0));
  const taxCollected = Math.max(0, Number(order.tax_amount ?? 0));
  const amountPaid = Math.max(0, Number(order.amount_paid ?? 0));
  // Other customer-paid revenue beyond merchandise + shipping + tax — the
  // shipping-protection add-on and any card surcharge. Derived as the residual
  // of what the customer actually paid (bounded ≥ 0; store-credit / points
  // redemption simply make it 0).
  //
  // PREFER THE RECORDED FEE. The residual is what the customer paid beyond
  // merchandise, shipping and tax, which expands to
  //     cardFee + protection − storeCredit − points
  // so on an order with no redemption it already equals protection + cardFee
  // exactly. Reading the recorded columns instead of subtracting makes that
  // robust rather than incidental, and lets the breakdown name the two parts.
  //
  // On an order that DID redeem store credit or points the residual is smaller
  // by the redemption and the clamp can drive it to zero, losing real
  // protection revenue. Whether a redemption should reduce revenue or be an
  // expense line is an accounting policy this codebase has never stated, so the
  // residual is kept verbatim there — this change must not silently pick a
  // side. (No order in the system has redeemed either today.)
  const redeemed =
    Number(order.store_credit_redeemed_cents ?? 0) > 0 || Number(order.points_redeemed ?? 0) > 0;
  const recordedProtection = Math.max(0, Number(order.shipping_protection_fee ?? 0));
  const cardSurcharge = Math.max(0, Number(order.card_processing_fee ?? 0));
  const residualAdditional = Math.max(0, amountPaid - merch - shippingRevenue - taxCollected);
  const additionalRevenue = redeemed ? residualAdditional : Math.round((recordedProtection + cardSurcharge) * 100) / 100;

  // Memberships are pure revenue: they have no product cost and never ship, so
  // they must not carry COGS (the worst-case fallback) or a shipping cost.
  const isMembership = String(order.order_type ?? "").toLowerCase() === "membership";

  const hasActual = overlay?.actualShippingCostCents != null;
  const shippingCost = isMembership
    ? 0
    : hasActual
      ? Math.max(0, (overlay!.actualShippingCostCents as number) / 100)
      : Math.max(0, config.shippingCostPerOrder);
  return computeOrderProfit({
    netMerchandiseRevenue: merch,
    // What the customer paid for shipping (0 on free-shipping orders).
    shippingRevenue,
    // Shipping protection + any card surcharge the customer paid.
    additionalRevenue,
    // Exact label cost once reconciled; the configured estimate until then.
    // Memberships never ship, so their cost is a hard 0 (already finalized).
    shippingCost,
    shippingCostIsEstimate: isMembership ? false : !hasActual,
    taxCollected,
    countTaxAsProfit: config.countSalesTaxAsProfit,
    // No COGS lines for a membership — it's not a physical product.
    lines: isMembership ? [] : lines,
    commission,
    processingFee: processingFeeFor(order, config),
    // ALWAYS an estimate: processingFeeFor() models the fee from
    // config.processingFeePercent. Veyra reports no per-transaction fee back to
    // this application, so there is no settled figure to use instead. Stated
    // explicitly rather than left to the default so the reason is on the record.
    processingFeeIsEstimate: true,
    refund: Math.max(0, Number(order.refund_amount ?? 0)),
    // The tax handed back with the refund, derived the same way the sales-tax
    // report derives it: nothing records the tax portion of a refund, so it is
    // the refunded share of what was paid, capped at the tax charged. Only used
    // when collected tax is configured as a pass-through — see
    // OrderProfitInput.refundedTax.
    refundedTax: refundedTaxPortion(amountPaid, taxCollected, Math.max(0, Number(order.refund_amount ?? 0))),
    fallbackUnitCostCents: Math.round(config.worstCaseUnitCost * 100),
  });
}

// ---- Batch helpers: fetch COGS lines + commissions + overlay for orders ----

const IN_CHUNK = 150; // keep each `.in(...)` well under the URL length limit

// ---- Reading orders without silently losing some -------------------------
//
// Two different things can cut an orders read short, and neither announces
// itself:
//
//   1. A `.limit()` in this file. `profitForPaidOrdersInRange` had none at all,
//      which is worse, not better: it meant the figure depended entirely on (2).
//   2. PostgREST's `db-max-rows`, a Supabase project setting this application
//      cannot read, which caps EVERY response. Supabase's own default for it is
//      1,000.
//
// Reproduced with 1,500 generated orders and a 1,000-row cap: the 30-day profit
// tile reported 1,000 orders and a third less profit, with no error and no
// warning. Under-reporting money is the worst direction to be wrong in, so the
// number of rows actually read is compared against a COUNT — which is one round
// trip and is not subject to the cap — and the shortfall is reported rather than
// absorbed.
// Two implementations of this paging arrived from two sessions. The shared
// `readAllRowsBounded` is the one kept: it advances by the batch length actually
// returned, so a server cap smaller than the page size cannot end the read
// early, and it probes one row past the ceiling so `truncated` is observed
// rather than inferred. The local variant stopped on any short page — safe only
// while `db-max-rows` is exactly 1000 — and discarded query errors.

async function costLinesByOrderId(orderIds: string[]): Promise<Map<string, OrderProfitLine[]>> {
  const byOrder = new Map<string, OrderProfitLine[]>();
  if (orderIds.length === 0) return byOrder;

  for (let i = 0; i < orderIds.length; i += IN_CHUNK) {
    const chunk = orderIds.slice(i, i + IN_CHUNK);
    // PAGED, unlike the other two batch reads, because this is the only one
    // that returns MORE than one row per order. 150 orders averaging seven line
    // items is over a thousand rows in one response, and a row source that caps
    // responses would drop the overflow — silently removing product cost, which
    // makes profit look BETTER than it is. The commission and overlay reads
    // below are one row per order and cannot exceed the chunk size.
    const { rows } = await readAllRowsBounded<{ order_id: string; quantity: number | null; unit_cost_cents: number | null }>(
      (from, to) =>
        supabaseAdmin
          .from("order_items")
          .select("order_id, quantity, unit_cost_cents")
          .in("order_id", chunk)
          .order("id", { ascending: true })
          .range(from, to) as unknown as PromiseLike<{ data: Array<{ order_id: string; quantity: number | null; unit_cost_cents: number | null }> | null; error: { message?: string } | null }>,
      { maxRows: MAX_PROFIT_ORDERS, label: "order items read" },
    );

    for (const raw of rows) {
      const list = byOrder.get(raw.order_id) ?? [];
      list.push({
        unitCostCents: raw.unit_cost_cents == null ? null : Number(raw.unit_cost_cents),
        quantity: Number(raw.quantity ?? 0),
      });
      byOrder.set(raw.order_id, list);
    }
  }
  return byOrder;
}

async function commissionByOrderId(orderIds: string[]): Promise<Map<string, number>> {
  const byOrder = new Map<string, number>();
  if (orderIds.length === 0) return byOrder;

  for (let i = 0; i < orderIds.length; i += IN_CHUNK) {
    const chunk = orderIds.slice(i, i + IN_CHUNK);
    // `status`, NOT `payment_status`. The column is `status` on `commissions`
    // and `payment_status` on `referral_orders`, and this read had the two
    // crossed: PostgREST answered 42703 with `data: null`, the error was never
    // destructured, and `data ?? []` turned a failed query into "this order
    // owed no commission". Profit was therefore overstated by the FULL
    // commission on every referred order. Guarded by
    // supabase-schema-parity.test.ts, and by the behavioural cover in
    // admin-profit-commission.test.ts.
    const { data, error } = await supabaseAdmin
      .from("commissions")
      .select("order_id, commission_amount, status")
      .in("order_id", chunk);

    // A FAILED READ MUST NOT LOOK LIKE "NO COMMISSION WAS PAID".
    //
    // Those two produced the identical answer, and $0.00 of commission is the
    // most flattering number available: profit came out overstated on the
    // dashboard, in the CSV export and in the operator's push notification,
    // with nothing to notice. The shipping overlay a few lines down degrades on
    // error deliberately — it can only make profit look WORSE, and the
    // migration may genuinely not have run. This one moves the figure the other
    // way, so it fails loudly.
    if (error) {
      console.error("Unable to read commissions for profit; profit would overstate by the commission owed", error);
      // WRAPPED, not rethrown raw. A PostgREST error is a plain object, so
      // `throw error` produces a rejection with no stack and no indication of
      // which read failed. Same shape as readAllRowsBounded's
      // "<label> failed: <message>" for the cost lines, which is what a reader
      // of the logs will already recognise.
      const message = (error as { message?: string })?.message ?? String(error);
      throw new Error(`commission read failed: ${message}`);
    }

    for (const raw of (data ?? []) as Array<{ order_id: string; commission_amount: number | null; status: string | null }>) {
      // Only subtract commission the owner actually pays out. A reversed /
      // voided / manual-review commission was clawed back (e.g. refunded order),
      // so it must NOT reduce profit — otherwise the owner is charged for a
      // commission that was never paid. The recorded amount is already at the
      // ambassador's effective (tiered) rate, so this is their exact payout.
      if (!isEarnedCommission(raw.status)) continue;
      byOrder.set(raw.order_id, (byOrder.get(raw.order_id) ?? 0) + Math.max(0, Number(raw.commission_amount ?? 0)));
    }
  }
  return byOrder;
}

async function shippingOverlayByOrderId(orderIds: string[]): Promise<Map<string, ShippingOverlay>> {
  const byOrder = new Map<string, ShippingOverlay>();
  if (orderIds.length === 0) return byOrder;

  for (let i = 0; i < orderIds.length; i += IN_CHUNK) {
    const chunk = orderIds.slice(i, i + IN_CHUNK);
    const { data, error } = await supabaseAdmin
      .from("orders")
      .select("order_id, actual_shipping_cost_cents, shipping_cost_source, profit_finalized")
      .in("order_id", chunk);
    // Migration not run yet → no overlay; every order uses the estimate.
    if (error || !data) return byOrder;
    for (const raw of data as Array<{ order_id: string; actual_shipping_cost_cents: number | null; shipping_cost_source: string | null; profit_finalized: boolean | null }>) {
      byOrder.set(raw.order_id, {
        actualShippingCostCents: raw.actual_shipping_cost_cents == null ? null : Number(raw.actual_shipping_cost_cents),
        source: raw.shipping_cost_source ?? null,
        finalized: raw.profit_finalized === true,
      });
    }
  }
  return byOrder;
}

function toOrderProfit(order: OrderRecord, result: OrderProfitResult, overlay: ShippingOverlay | undefined): OrderProfit {
  return {
    ...result,
    orderId: order.order_id,
    orderNumber: order.order_number ?? null,
    paidAt: order.paid_at ?? null,
    createdAt: order.created_at ?? null,
    orderType: order.order_type ?? null,
    shippingCostSource: overlay?.source ?? null,
  };
}

// ---- Single order (Order Details page) ----

export async function getOrderProfit(orderId: string): Promise<OrderProfit | null> {
  const [{ data: order }, config] = await Promise.all([
    supabaseAdmin.from("orders").select(ORDER_FIELDS).eq("order_id", orderId).maybeSingle(),
    getProfitSettings(),
  ]);
  if (!order) return null;

  const record = order as OrderRecord;
  const [lines, commissions, overlays] = await Promise.all([
    costLinesByOrderId([orderId]),
    commissionByOrderId([orderId]),
    shippingOverlayByOrderId([orderId]),
  ]);

  const overlay = overlays.get(orderId);
  const result = profitForOrder(record, lines.get(orderId) ?? [], commissions.get(orderId) ?? 0, config, overlay);
  return toOrderProfit(record, result, overlay);
}

// ---- Many orders, computed once (used by dashboard + analytics) ----

function paidAndPartiallyRefunded(orders: OrderRecord[]): OrderRecord[] {
  // Include paid orders AND partially-refunded ones (they still netted
  // revenue; the refund is subtracted per-order). Fully "refunded" orders
  // netted ~nothing and are excluded, matching the revenue reports.
  //
  // This was a SECOND, hand-written implementation of isRevenueOrderStatus
  // (review finding 4). It happened to agree, which is exactly why it was
  // dangerous: widening the ledger's definition would have moved four surfaces
  // and silently left this one behind. One rule, one place.
  return orders.filter((o) => isRevenueOrderStatus(o.payment_status));
}

async function computeProfitForOrders(orders: OrderRecord[]): Promise<OrderProfit[]> {
  const config = await getProfitSettings();
  const paid = paidAndPartiallyRefunded(orders);
  const orderIds = paid.map((o) => o.order_id).filter(Boolean);

  const [lines, commissions, overlays] = await Promise.all([
    costLinesByOrderId(orderIds),
    commissionByOrderId(orderIds),
    shippingOverlayByOrderId(orderIds),
  ]);

  return paid.map((order) => {
    const overlay = overlays.get(order.order_id);
    return toOrderProfit(order, profitForOrder(order, lines.get(order.order_id) ?? [], commissions.get(order.order_id) ?? 0, config, overlay), overlay);
  });
}

// Profit for an explicit set of order ids (any status), keyed by order id.
// Used by the CSV export so it reports the SAME net profit as every other
// surface — the engine stays the single source of truth.
export async function getOrderProfitMap(orderIds: string[]): Promise<Map<string, OrderProfit>> {
  const map = new Map<string, OrderProfit>();
  const ids = orderIds.filter(Boolean);
  if (ids.length === 0) return map;

  const config = await getProfitSettings();

  const records: OrderRecord[] = [];
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const chunk = ids.slice(i, i + IN_CHUNK);
    const { data } = await supabaseAdmin.from("orders").select(ORDER_FIELDS).in("order_id", chunk);
    for (const row of (data ?? []) as OrderRecord[]) records.push(row);
  }

  const [lines, commissions, overlays] = await Promise.all([
    costLinesByOrderId(ids),
    commissionByOrderId(ids),
    shippingOverlayByOrderId(ids),
  ]);

  for (const record of records) {
    const overlay = overlays.get(record.order_id);
    map.set(
      record.order_id,
      toOrderProfit(record, profitForOrder(record, lines.get(record.order_id) ?? [], commissions.get(record.order_id) ?? 0, config, overlay), overlay),
    );
  }
  return map;
}

// Ceilings on one report, not definitions of the answer — see `truncated` on
// ProfitDashboard. Every read below pages to exhaustion.
const MAX_PROFIT_ORDERS = 200_000;

async function profitForPaidOrdersInRange(
  fromIso: string,
  toIso: string,
): Promise<{ rows: OrderProfit[]; truncated: boolean }> {
  // This select carried no `.limit()` and no `.range()` at all, which is not
  // the same as being unbounded: PostgREST caps every response at its
  // `db-max-rows` (Supabase exposes it as "Max rows"), and a capped read came
  // back looking exactly like a small store. Paging to exhaustion removes the
  // dependency on that setting entirely, and `truncated` says so when the
  // ceiling — not the data — ended the read.
  const { rows, truncated } = await readAllRowsBounded<OrderRecord>(
    (from, to) =>
      supabaseAdmin
        .from("orders")
        .select(ORDER_FIELDS)
        .gte("created_at", fromIso)
        .lte("created_at", toIso)
        // created_at is not unique; order_id breaks the ties so paging can
        // neither repeat nor skip a row.
        .order("created_at", { ascending: false })
        .order("order_id", { ascending: true })
        .range(from, to) as unknown as PromiseLike<{ data: OrderRecord[] | null; error: { message?: string } | null }>,
    { maxRows: MAX_PROFIT_ORDERS, label: "profit range read" },
  );
  return { rows: await computeProfitForOrders(rows), truncated };
}

export interface ProfitWindowMetrics {
  today: number;
  last7Days: number;
  last30Days: number;
  ordersLast30Days: number;
  hasEstimatedCost: boolean;
  /**
   * True when the orders read came back short of what the table holds, so these
   * figures are a floor rather than the total. Never let a smaller number be
   * presented as the whole story.
   */
  truncated: boolean;
}

// True net profit for the dashboard, over today / 7d / 30d windows. Uses the
// order's own paid/created time so historical orders keep their profit.
export async function getProfitWindowMetrics(nowMs: number = Date.now()): Promise<ProfitWindowMetrics> {
  const oneDay = 24 * 60 * 60 * 1000;
  const fromIso = new Date(nowMs - 30 * oneDay).toISOString();
  const toIso = new Date(nowMs).toISOString();
  const dayStart = new Date(new Date(nowMs).toISOString().slice(0, 10) + "T00:00:00.000Z").getTime();
  const weekStart = nowMs - 7 * oneDay;
  const monthStart = nowMs - 30 * oneDay;

  const { rows, truncated } = await profitForPaidOrdersInRange(fromIso, toIso);

  let today = 0;
  let last7Days = 0;
  let last30Days = 0;
  let ordersLast30Days = 0;
  let hasEstimatedCost = false;

  for (const row of rows) {
    const eventTime = Date.parse(row.paidAt ?? row.createdAt ?? "");
    if (!Number.isFinite(eventTime)) continue;
    if (eventTime >= monthStart) {
      last30Days += row.profit;
      // SALES, not outbound shipments. A reship's COST belongs in the profit
      // above, but the reship has no buyer, so counting it inflates the order
      // count and drags average order value down with a $0 denominator. This
      // line used to increment unconditionally, so the 30-day tile and the
      // lifetime tile on the same page reported different order counts for the
      // same store. isSaleOrder is the one predicate both tiles now use.
      if (isSaleOrder(row.orderType)) ordersLast30Days += 1;
      if (row.profitStatus === "estimated") hasEstimatedCost = true;
    }
    if (eventTime >= weekStart) last7Days += row.profit;
    if (eventTime >= dayStart) today += row.profit;
  }

  const round = (v: number) => Math.round(v * 100) / 100;
  return { today: round(today), last7Days: round(last7Days), last30Days: round(last30Days), ordersLast30Days, hasEstimatedCost, truncated };
}

export interface ProfitTrendPoint {
  date: string;
  profit: number;
}

// Per-day net profit across a date range (Analytics profit trend).
export async function getProfitTrend(fromIso: string, toIso: string): Promise<ProfitTrendPoint[]> {
  const { rows } = await profitForPaidOrdersInRange(fromIso, toIso);
  const byDay = new Map<string, number>();

  for (const row of rows) {
    const eventTime = Date.parse(row.paidAt ?? row.createdAt ?? "");
    if (!Number.isFinite(eventTime)) continue;
    const day = new Date(eventTime).toISOString().slice(0, 10);
    byDay.set(day, (byDay.get(day) ?? 0) + row.profit);
  }

  return Array.from(byDay.entries())
    .map(([date, profit]) => ({ date, profit: Math.round(profit * 100) / 100 }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

// -------------------------------------------------------------------------
// Full profit dashboard — net profit across calendar windows plus lifetime
// aggregates. This is the analytics surface described in the profit spec.
// -------------------------------------------------------------------------
export interface ProfitDashboard {
  profit: {
    today: number;
    yesterday: number;
    thisWeek: number;
    thisMonth: number;
    thisYear: number;
    lifetime: number;
  };
  lifetime: {
    grossRevenue: number;
    netProfit: number;
    grossMarginPercent: number;
    netMarginPercent: number;
    averageOrderValue: number;
    averageProfitPerOrder: number;
    orderCount: number;
    /** Outbound reshipments — real cost, zero revenue, never counted as sales. */
    replacementCount: number;
    totalProductCosts: number;
    totalProcessorFees: number;
    totalShippingRevenue: number;
    totalShippingExpense: number;
    totalShippingProfit: number;
  };
  /**
   * Sales tax collected across the same orders, as a LIABILITY — money held on
   * behalf of a state, never part of revenue or profit.
   *
   * Surfaced here because the owner's decision was not merely "stop counting
   * tax as profit" but "track it separately as a tax liability". Excluding a
   * number from profit without showing it anywhere just makes it invisible.
   * `taxCountedAsProfit` on each order says which side of the line it fell on.
   */
  salesTaxCollected: number;
  /** True if any order in the window was configured to count tax as profit. */
  salesTaxCountedAsProfit: boolean;
  /** Orders whose profit is still estimated (exact shipping cost pending). */
  estimatedOrderCount: number;
  hasEstimatedProfit: boolean;
  /**
   * True when MAX_PROFIT_ORDERS stopped the read before the whole order history
   * had been seen — see ProfitWindowMetrics.truncated. Every figure above is
   * then a floor, not a total.
   */
  truncated: boolean;
}

export async function getProfitDashboard(nowMs: number = Date.now()): Promise<ProfitDashboard> {
  // Was a single `.limit(20000)`. Past twenty thousand orders it returned the
  // newest twenty thousand and every lifetime figure on /admin — gross revenue,
  // net profit, margin, AOV, order count — was computed from that slice and
  // presented as the store's whole history, with nothing on the screen to say
  // so.
  const { rows: orders, truncated } = await readAllRowsBounded<OrderRecord>(
    (from, to) =>
      supabaseAdmin
        .from("orders")
        .select(ORDER_FIELDS)
        .order("created_at", { ascending: false })
        .order("order_id", { ascending: true })
        .range(from, to) as unknown as PromiseLike<{ data: OrderRecord[] | null; error: { message?: string } | null }>,
    { maxRows: MAX_PROFIT_ORDERS, label: "profit dashboard read" },
  );

  const rows = await computeProfitForOrders(orders);

  const now = new Date(nowMs);
  const startOfToday = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const startOfYesterday = startOfToday - 24 * 60 * 60 * 1000;
  // Week starts Monday (ISO). getUTCDay(): 0=Sun … 6=Sat → days since Monday.
  const daysSinceMonday = (now.getUTCDay() + 6) % 7;
  const startOfWeek = startOfToday - daysSinceMonday * 24 * 60 * 60 * 1000;
  const startOfMonth = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const startOfYear = Date.UTC(now.getUTCFullYear(), 0, 1);

  const profit = { today: 0, yesterday: 0, thisWeek: 0, thisMonth: 0, thisYear: 0, lifetime: 0 };
  let grossRevenue = 0;
  let netProfit = 0;
  let totalProductCosts = 0;
  let totalProcessorFees = 0;
  let totalShippingRevenue = 0;
  let totalShippingExpense = 0;
  // SALES, not outbound shipments. See OrderProfit.orderType.
  let orderCount = 0;
  let replacementCount = 0;
  let estimatedOrderCount = 0;
  let salesTaxCollected = 0;
  let salesTaxCountedAsProfit = false;

  for (const row of rows) {
    const eventTime = Date.parse(row.paidAt ?? row.createdAt ?? "");
    if (!Number.isFinite(eventTime)) continue;

    // A replacement's COSTS are counted below exactly like any other order's —
    // the merchandise and the postage were really spent. Only the sale count
    // excludes it, because no customer bought anything.
    if (isSaleOrder(row.orderType)) {
      orderCount += 1;
    } else {
      replacementCount += 1;
    }
    profit.lifetime += row.profit;
    grossRevenue += row.grossRevenue;
    netProfit += row.profit;
    totalProductCosts += row.cogs;
    totalProcessorFees += row.processingFee;
    totalShippingRevenue += row.shippingCharged;
    totalShippingExpense += row.shippingCost;
    if (row.profitStatus === "estimated") estimatedOrderCount += 1;
    salesTaxCollected += row.taxCollected;
    if (row.taxCountedAsProfit) salesTaxCountedAsProfit = true;

    if (eventTime >= startOfToday) profit.today += row.profit;
    if (eventTime >= startOfYesterday && eventTime < startOfToday) profit.yesterday += row.profit;
    if (eventTime >= startOfWeek) profit.thisWeek += row.profit;
    if (eventTime >= startOfMonth) profit.thisMonth += row.profit;
    if (eventTime >= startOfYear) profit.thisYear += row.profit;
  }

  const round = (v: number) => Math.round(v * 100) / 100;
  const totalShippingProfit = totalShippingRevenue - totalShippingExpense;

  return {
    profit: {
      today: round(profit.today),
      yesterday: round(profit.yesterday),
      thisWeek: round(profit.thisWeek),
      thisMonth: round(profit.thisMonth),
      thisYear: round(profit.thisYear),
      lifetime: round(profit.lifetime),
    },
    lifetime: {
      grossRevenue: round(grossRevenue),
      netProfit: round(netProfit),
      grossMarginPercent: grossRevenue > 0 ? round(((grossRevenue - totalProductCosts) / grossRevenue) * 100) : 0,
      netMarginPercent: grossRevenue > 0 ? round((netProfit / grossRevenue) * 100) : 0,
      averageOrderValue: orderCount > 0 ? round(grossRevenue / orderCount) : 0,
      averageProfitPerOrder: orderCount > 0 ? round(netProfit / orderCount) : 0,
      orderCount,
      /** Outbound reshipments — real cost, zero revenue, never a sale. */
      replacementCount,
      totalProductCosts: round(totalProductCosts),
      totalProcessorFees: round(totalProcessorFees),
      totalShippingRevenue: round(totalShippingRevenue),
      totalShippingExpense: round(totalShippingExpense),
      totalShippingProfit: round(totalShippingProfit),
    },
    salesTaxCollected: round(salesTaxCollected),
    salesTaxCountedAsProfit,
    estimatedOrderCount,
    hasEstimatedProfit: estimatedOrderCount > 0,
    truncated,
  };
}

// -------------------------------------------------------------------------
// Shipping-cost reconciliation. Called when the exact shipping-label cost
// becomes available (Shippo label purchase, or manual admin entry)
// to replace the estimate, flip the order to Finalized profit, and record an
// audit row capturing the estimate, the exact cost, and the profit before/after.
// -------------------------------------------------------------------------
export interface RecordShippingCostInput {
  orderId: string;
  /** Exact shipping-label cost, in cents. */
  amountCents: number;
  /**
   * Where the exact cost came from.
   *
   * "shippo" is a label bought in Shippo -- the only automatic source now that
   * fulfillment is in-house. "provider" and "fulfillment" are retained so
   * historical audit rows written by the former 3PL integration still describe
   * themselves accurately; nothing writes them any more.
   */
  source: "shippo" | "manual" | "provider" | "fulfillment";
  changedBy?: string | null;
}

export async function recordActualShippingCost(input: RecordShippingCostInput): Promise<{ ok: boolean; error?: string }> {
  const amountCents = Math.max(0, Math.round(input.amountCents));
  const now = new Date().toISOString();

  // Profit BEFORE reconciliation (still on the estimate) — for the audit trail.
  const before = await getOrderProfit(input.orderId).catch(() => null);
  if (!before) return { ok: false, error: "Order not found" };

  const config = await getProfitSettings();

  // Preserve the original estimate the first time we reconcile; a later manual
  // correction must not overwrite it.
  const { data: current } = await supabaseAdmin
    .from("orders")
    .select("estimated_shipping_cost_cents")
    .eq("order_id", input.orderId)
    .maybeSingle();
  const estimatedCents =
    current?.estimated_shipping_cost_cents != null
      ? Number(current.estimated_shipping_cost_cents)
      : Math.round(config.shippingCostPerOrder * 100);

  const { error: updateError } = await supabaseAdmin
    .from("orders")
    .update({
      estimated_shipping_cost_cents: estimatedCents,
      actual_shipping_cost_cents: amountCents,
      shipping_cost_source: input.source,
      shipping_cost_updated_at: now,
      profit_finalized: true,
      updated_at: now,
    })
    .eq("order_id", input.orderId);
  if (updateError) return { ok: false, error: updateError.message };

  // Profit AFTER reconciliation (now on the exact cost).
  const after = await getOrderProfit(input.orderId).catch(() => null);

  await supabaseAdmin
    .from("order_shipping_cost_audit")
    .insert({
      order_id: input.orderId,
      estimated_cost_cents: estimatedCents,
      exact_cost_cents: amountCents,
      difference_cents: amountCents - estimatedCents,
      source: input.source,
      previous_estimated_profit_cents: Math.round((before.profit ?? 0) * 100),
      finalized_net_profit_cents: after ? Math.round(after.profit * 100) : null,
      changed_by: input.changedBy ?? null,
      created_at: now,
    })
    .then(
      () => undefined,
      () => undefined, // audit is best-effort; never fail the reconciliation over it
    );

  return { ok: true };
}

export interface ShippingCostAuditEntry {
  id: string;
  estimatedCostCents: number | null;
  exactCostCents: number | null;
  differenceCents: number | null;
  source: string;
  previousEstimatedProfitCents: number | null;
  finalizedNetProfitCents: number | null;
  changedBy: string | null;
  createdAt: string;
}

export async function getShippingCostAudit(orderId: string): Promise<ShippingCostAuditEntry[]> {
  const { data, error } = await supabaseAdmin
    .from("order_shipping_cost_audit")
    .select("id, estimated_cost_cents, exact_cost_cents, difference_cents, source, previous_estimated_profit_cents, finalized_net_profit_cents, changed_by, created_at")
    .eq("order_id", orderId)
    .order("created_at", { ascending: false });
  if (error || !data) return [];
  return data.map((row) => ({
    id: String(row.id),
    estimatedCostCents: row.estimated_cost_cents == null ? null : Number(row.estimated_cost_cents),
    exactCostCents: row.exact_cost_cents == null ? null : Number(row.exact_cost_cents),
    differenceCents: row.difference_cents == null ? null : Number(row.difference_cents),
    source: String(row.source ?? "manual"),
    previousEstimatedProfitCents: row.previous_estimated_profit_cents == null ? null : Number(row.previous_estimated_profit_cents),
    finalizedNetProfitCents: row.finalized_net_profit_cents == null ? null : Number(row.finalized_net_profit_cents),
    changedBy: row.changed_by == null ? null : String(row.changed_by),
    createdAt: String(row.created_at),
  }));
}
