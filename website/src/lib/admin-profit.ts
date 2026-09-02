import "server-only";

import { supabaseAdmin } from "@/lib/supabase-server";
import { startOfBusinessDay, startOfBusinessMonth, startOfBusinessWeek, startOfBusinessYear } from "@/lib/business-day";
import { getProfitSettings, type ProfitSettingsConfig } from "@/lib/admin-control";
import { computeOrderProfit, marginPercentOf, type OrderProfitLine, type OrderProfitResult } from "@/lib/order-profit";
import { hasCapturedPayment, isEarnedCommission, isSaleOrder } from "@/lib/ledger";
import { refundedTaxFor } from "@/lib/admin-tax-report";
import { pointsToDollars } from "@/lib/points-math";
import { readAllRowsBounded } from "@/lib/supabase-page";

// The order fields profit needs. Everything is stored on the order at checkout,
// so profit is computed from the record — not from today's live product cost.
// tax_amount is carried for display (never profit); the actual/estimated
// shipping columns drive the estimate→exact reconciliation.
//
// EXPORTED so a test can pin the real select list rather than keeping a copy of
// it. shipping-cost-void-repair.test.ts held a hand-written duplicate of this
// string and started failing the moment a column was added — a stale fixture in
// miniature, and the same class of defect as the commissions column below.
export const ORDER_FIELDS =
  "order_id, order_number, order_type, subtotal, discount_amount, shipping_amount, handling_fee, tax_amount, refund_amount, amount_paid, payment_method, payment_status, paid_at, created_at, shipping_protection_fee, card_processing_fee, store_credit_redeemed_cents, points_redeemed";

type OrderRecord = {
  order_id: string;
  order_number?: string | null;
  order_type?: string | null;
  subtotal: number | null;
  discount_amount: number | null;
  shipping_amount: number | null;
  handling_fee?: number | null;
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
  // Other customer-paid revenue beyond merchandise + shipping + tax — the
  // shipping-protection add-on and any card surcharge. READ FROM THE COLUMNS
  // THAT RECORD THEM, always.
  //
  // This used to fall back to a residual (amountPaid − merch − shipping − tax,
  // clamped at ≥ 0) on any order that redeemed store credit or points, because
  // the policy question "is a redemption contra-revenue or an expense?" had
  // never been answered. The residual answered it by accident, and answered it
  // wrong: it expands to `cardFee + protection − storeCredit − points`, so on a
  // redeeming order it conflated two unrelated things — real protection revenue
  // the customer DID pay, and non-cash tender the customer did NOT — and then
  // clamped the mixture at zero. A $100 order settled with $20 of store credit
  // reported $110 of gross revenue against $97 of cash, and $2 of "shipping
  // protection & fees" on an order that collected $7 of it.
  //
  // The two are now separate terms: fees are read from their own columns, and
  // the redemption is passed to the engine as contra-revenue (see
  // OrderProfitInput.creditRedeemed). Revenue then equals cash on EVERY order.
  const recordedProtection = Math.max(0, Number(order.shipping_protection_fee ?? 0));
  const cardSurcharge = Math.max(0, Number(order.card_processing_fee ?? 0));
  // HANDLING IS PART OF WHAT THE CUSTOMER PAID, SO IT IS PART OF REVENUE.
  //
  // `orders.handling_fee` is a term of the charged total everywhere else — the
  // customer's invoice (invoice-totals), the confirmation page, the account
  // order list, and reconciliation-math.expectedOrderTotal, which is what
  // decides whether an order is accused of not adding up. It was the one term
  // missing from this read, so the first order to carry a handling fee would
  // have reported `amount_paid 105` against `grossRevenue 100` and broken the
  // revenue invariant on a $5 charge nobody could see. Latent only because
  // quote-order.ts:1007, membership-billing.ts:194,493 and
  // admin-replacements.ts:161 all write 0 today.
  const handlingFee = Math.max(0, Number(order.handling_fee ?? 0));
  const additionalRevenue = Math.round((recordedProtection + cardSurcharge + handlingFee) * 100) / 100;

  // Non-cash tender applied to this order. store_credit_redeemed_cents is
  // integer CENTS; points_redeemed is a count of POINTS, converted through the
  // one exported redemption rate rather than a local copy of "100" — the same
  // rule admin-reconciliation uses to decide what this order should have
  // charged, so the two screens cannot disagree about the same order.
  const creditRedeemed = Math.round(
    (Math.max(0, Number(order.store_credit_redeemed_cents ?? 0)) / 100
      + Math.max(0, pointsToDollars(Number(order.points_redeemed ?? 0)))) * 100,
  ) / 100;

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
    // Store credit + points redeemed — contra-revenue, so gross revenue ties
    // to orders.amount_paid on a redeeming order exactly as it does on any
    // other one.
    creditRedeemed,
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
    // The tax handed back with the refund. THE SAME FUNCTION the sales-tax
    // filing report calls, not a copy of it: this was a second implementation
    // whose comment claimed to mirror admin-tax-report.refundedTaxFor, and it
    // did not. The two disagreed on a row marked "refunded" that carries no
    // refund_amount (a legacy row written before that column existed) — the
    // filing report treats the whole tax as returned, the copy returned zero.
    // Only used when collected tax is configured as a pass-through — see
    // OrderProfitInput.refundedTax.
    refundedTax: refundedTaxFor(order),
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
    // A commission read that fails must not silently report zero commission —
    // that overstates profit on every affected order, and recordActualShippingCost
    // writes the resulting figure into an audit row as fact.
    // THE COLUMN IS `status`, AND THE NAME IS LOAD-BEARING.
    //
    // This read asked for `commissions.payment_status`, which does not exist:
    // the verified production column set is (id, partner_id, order_id,
    // referral_code, commission_percent, commission_amount, status, created_at,
    // updated_at, tier_name, ineligible_reason, fraud_flag, fraud_reason,
    // customer_discount_percent). `payment_status` is the SIBLING ledger's
    // column — referral_orders has it, commissions mirrors it as `status` — and
    // every writer of this table writes `status` (payment-webhook.ts:857,890,
    // 1049; partner-portal.ts:436,1964,2099).
    //
    // While the error above was swallowed, that read returned nothing and every
    // order silently reported ZERO commission. Now that it throws, the same
    // typo would 42703 the profit dashboard, the order panel, the CSV export,
    // the push notification and recordActualShippingCost on the first /admin
    // load after deploy. No test could tell the two names apart because every
    // Supabase double in the suite ignores the select list;
    // admin-profit-schema-contract.test.ts pins it now.
    //
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
    // with nothing to notice. The shipping overlay a few lines down tolerates
    // the ONE error that means "the migration has not run" (42703, undefined
    // column) and fails loudly on everything else — losing the overlay
    // substitutes config.shippingCostPerOrder ($6 by default,
    // admin-control.ts), so it makes profit look BETTER on every order that
    // really shipped for more than the estimate. It was described here as
    // only ever making profit look worse; that was the wrong direction.
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
      //
      // The values a writer can actually produce here are `pending`,
      // `approved_for_payout`, `paid`, `reversed` and `manual_review`
      // (payment-webhook.getCommissionStateForRefund + the two partner-portal
      // payout paths), so EXCLUDED_COMMISSION_STATUSES covers every clawed-back
      // one. isEarnedCommission treats null/undefined as earned, which is the
      // conservative direction HERE: an unreadable status subtracts the
      // commission and understates profit rather than overstating it.
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
    // MIGRATION NOT RUN IS ONE ERROR, NOT EVERY ERROR.
    //
    // 42703 (undefined column) is the only failure that really means "the
    // order-profit-shipping-reconciliation.sql columns are not there yet", and
    // falling back to the estimate is right for it. Every other failure — a
    // statement timeout, a pooler 503, a permission error — was also swallowed
    // here, and swallowing it silently replaces the exact label cost with
    // config.shippingCostPerOrder on every affected order, which OVERSTATES
    // profit whenever the real label cost was higher. Same wrapped-throw shape
    // as the commission read above.
    //
    // `return` also exited the whole chunk loop rather than this chunk, so one
    // failing chunk left earlier orders on exact costs and every later one on
    // the estimate, with nothing on the screen marking the difference.
    if (error) {
      if (String((error as { code?: string }).code) === "42703") return byOrder;
      const message = (error as { message?: string })?.message ?? String(error);
      throw new Error(`shipping overlay read failed: ${message}`);
    }
    for (const raw of (data ?? []) as Array<{ order_id: string; actual_shipping_cost_cents: number | null; shipping_cost_source: string | null; profit_finalized: boolean | null }>) {
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

/**
 * The engine's answer for one order, WHATEVER its payment status.
 *
 * Internal on purpose. The only caller that wants an unfiltered figure is the
 * shipping-cost audit, which records profit before/after a label cost is
 * reconciled in and must not start answering "Order not found" for a row that
 * plainly exists. Every reporting surface goes through `getOrderProfit`, which
 * refuses an order that never took payment (M-03).
 */
async function computeProfitForOrderId(
  orderId: string,
): Promise<{ record: OrderRecord; profit: OrderProfit } | null> {
  // NULL MEANS "NO SUCH ORDER", AND NOTHING ELSE.
  //
  // This destructured only `{ data: order }` and dropped the error, so a
  // statement timeout, a pooler 503 or a schema-cache miss — none of which
  // supabase-js throws for — came back as `null` and every caller read it as
  // "the order does not exist". recordActualShippingCost was rewritten to tell
  // the two apart ("a throw is an unreadable order, null is a missing one") but
  // the throw could never happen, so the sweep still reported "Order not found"
  // for the single most likely read to fail, on rows that plainly do exist.
  // Both callers outside this file already do `.catch(() => null)`, so a throw
  // costs a profit panel, not a page.
  const [{ data: order, error }, config] = await Promise.all([
    supabaseAdmin.from("orders").select(ORDER_FIELDS).eq("order_id", orderId).maybeSingle(),
    getProfitSettings(),
  ]);
  if (error) throw error;
  if (!order) return null;

  const record = order as OrderRecord;
  const [lines, commissions, overlays] = await Promise.all([
    costLinesByOrderId([orderId]),
    commissionByOrderId([orderId]),
    shippingOverlayByOrderId([orderId]),
  ]);

  const overlay = overlays.get(orderId);
  const result = profitForOrder(record, lines.get(orderId) ?? [], commissions.get(orderId) ?? 0, config, overlay);
  return { record, profit: toOrderProfit(record, result, overlay) };
}

/**
 * Profit for one order, for every reporting surface — the admin order-detail
 * panel, the operator push notification, and (through getOrderProfitMap) the
 * orders CSV export.
 *
 * NULL FOR AN ORDER THAT NEVER TOOK PAYMENT, AND THAT IS THE POINT (M-03).
 *
 * `amount_paid` is written at INSERT, before capture, so a `pending_payment`,
 * `awaiting_verification`, `canceled`, `payment_failed` or `payment_rejected`
 * row carries a full basket and a full total. Fed to the engine it produced a
 * complete, entirely fictional P&L: revenue nobody sent, a percentage
 * processing fee on that revenue, COGS for stock still on the shelf and postage
 * for a parcel never packed. The dashboard filtered these out; the two
 * per-order surfaces did not, so an abandoned checkout showed up in the owner's
 * spreadsheet as a sale with a margin.
 *
 * A fully refunded order is NOT in this category — it captured the money and
 * gave it back, and its costs are real (VL-24). See
 * ledger.CAPTURED_PAYMENT_STATUSES, which draws exactly that line.
 *
 * Callers already treat null as "no panel / blank cells", which is the right
 * rendering: the order is still listed, it simply has no profit to report.
 */
export async function getOrderProfit(orderId: string): Promise<OrderProfit | null> {
  const loaded = await computeProfitForOrderId(orderId);
  if (!loaded) return null;
  if (!hasCapturedPayment(loaded.record.payment_status)) return null;
  return loaded.profit;
}

// ---- Many orders, computed once (used by dashboard + analytics) ----

function ordersThatTookMoney(orders: OrderRecord[]): OrderRecord[] {
  // EVERY order that captured money, INCLUDING the fully refunded ones.
  //
  // This filtered on isRevenueOrderStatus, which excludes a fully refunded
  // order — right for a revenue report, wrong for a profit one. The refund
  // returns the revenue; it does not return the COGS, the postage or the
  // processor fee, and dropping the row dropped all three. Net profit was
  // overstated by exactly what the store lost on the refund (VL-24 / M-02 /
  // REF-05). The engine already nets a refunded order's revenue to zero, so
  // including it here adds its loss and no phantom revenue.
  //
  // Still a SINGLE shared rule, not a hand-written status list: see
  // ledger.CAPTURED_PAYMENT_STATUSES, which is also what keeps orders that
  // never took payment out of the per-order surfaces (M-03).
  return orders.filter((o) => hasCapturedPayment(o.payment_status));
}

async function computeProfitForOrders(orders: OrderRecord[]): Promise<OrderProfit[]> {
  const config = await getProfitSettings();
  const paid = ordersThatTookMoney(orders);
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

// Profit for an explicit set of order ids, keyed by order id. Used by the CSV
// export so it reports the SAME net profit as every other surface — the engine
// stays the single source of truth.
//
// An id whose order never took payment is simply ABSENT from the map (M-03).
// This used to compute one for any status at all, so the export's profit
// columns carried a full P&L for every abandoned checkout and cancelled order:
// revenue nobody sent, a fee on that revenue, COGS for stock still on the shelf.
// The export already writes an empty cell for a missing entry, which is the
// honest rendering — the order is still listed, it just has no profit to
// report. Same rule, same predicate, as the per-order getOrderProfit above.
export async function getOrderProfitMap(orderIds: string[]): Promise<Map<string, OrderProfit>> {
  const map = new Map<string, OrderProfit>();
  const ids = orderIds.filter(Boolean);
  if (ids.length === 0) return map;

  const config = await getProfitSettings();

  const records: OrderRecord[] = [];
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const chunk = ids.slice(i, i + IN_CHUNK);
    // Same rule as every other financial read on this branch: a page that could
    // not be read is not a page with no orders on it.
    const { data, error } = await supabaseAdmin.from("orders").select(ORDER_FIELDS).in("order_id", chunk);
    if (error) throw error;
    for (const row of (data ?? []) as OrderRecord[]) records.push(row);
  }

  const [lines, commissions, overlays] = await Promise.all([
    costLinesByOrderId(ids),
    commissionByOrderId(ids),
    shippingOverlayByOrderId(ids),
  ]);

  for (const record of records) {
    if (!hasCapturedPayment(record.payment_status)) continue;
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
  // The store's midnight (business-day.ts), not the UTC date slice: that slice
  // rolled "today" over at 8pm ET, emptying this tile mid-evening.
  const dayStart = startOfBusinessDay(new Date(nowMs)).getTime();
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
    /** `null` when gross revenue is <= 0 — see order-profit.marginPercentOf. */
    grossMarginPercent: number | null;
    /** `null` when gross revenue is <= 0 — see order-profit.marginPercentOf. */
    netMarginPercent: number | null;
    averageOrderValue: number;
    averageProfitPerOrder: number;
    orderCount: number;
    /**
     * Money handed back, across the same orders.
     *
     * `grossRevenue` above is what was invoiced BEFORE refunds — the convention
     * a partially refunded order has always had here — and fully refunded
     * orders now count too (their costs are real; see
     * ledger.CAPTURED_PAYMENT_STATUSES). Without this line a reader cannot tell
     * gross revenue that was kept from gross revenue that went straight back
     * out, and net profit would look inexplicably low beside it.
     */
    totalRefunds: number;
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

  // Every window cut at the store's midnight, not UTC's (business-day.ts).
  // Subtracting a flat 24h for "yesterday" was also wrong twice a year, on the
  // 23- and 25-hour days either side of a DST change; stepping the calendar
  // date is not.
  const now = new Date(nowMs);
  const startOfToday = startOfBusinessDay(now).getTime();
  const startOfYesterday = startOfBusinessDay(now, -1).getTime();
  const startOfWeek = startOfBusinessWeek(now).getTime(); // Monday (ISO weeks)
  const startOfMonth = startOfBusinessMonth(now).getTime();
  const startOfYear = startOfBusinessYear(now).getTime();

  const profit = { today: 0, yesterday: 0, thisWeek: 0, thisMonth: 0, thisYear: 0, lifetime: 0 };
  let grossRevenue = 0;
  let netProfit = 0;
  let totalProductCosts = 0;
  let totalProcessorFees = 0;
  let totalShippingRevenue = 0;
  let totalShippingExpense = 0;
  let totalRefunds = 0;
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
    totalRefunds += row.refund;
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
      // The SAME convention the per-order margin uses: `null`, never 0%, when
      // there is no revenue to take a proportion of. A store whose lifetime
      // revenue is negative must not report a 0% margin as though it had broken
      // even, and must not report the positive number two negatives divide to.
      grossMarginPercent: marginPercentOf(grossRevenue - totalProductCosts, grossRevenue),
      netMarginPercent: marginPercentOf(netProfit, grossRevenue),
      averageOrderValue: orderCount > 0 ? round(grossRevenue / orderCount) : 0,
      averageProfitPerOrder: orderCount > 0 ? round(netProfit / orderCount) : 0,
      orderCount,
      totalRefunds: round(totalRefunds),
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
   * "shippo" is a label bought in Shippo; "manual" is a cost entered by hand.
   *
   * The former "provider" and "fulfillment" values belonged to the EvoLabs
   * third-party fulfilment integration, which is gone. Zero orders ever used
   * them.
   */
  source: "shippo" | "manual";
  changedBy?: string | null;
  /**
   * A HUMAN'S DELIBERATE OVERRIDE OF THE VOIDED-LABEL REFUSAL. Only honoured
   * for source "manual" — see the refusal in recordActualShippingCost.
   */
  overrideVoidedLabel?: boolean;
}

/**
 * Whether a new order_shipping_cost_audit row should be written.
 *
 * Re-recording the SAME settled cost for an order is a no-op, not an event.
 * The repair sweep can legitimately re-run against an order whose cost is
 * already recorded; without this the audit trail fills with identical rows and
 * stops being usable as a record of what actually changed.
 *
 * COMPARE AGAINST THE MOST RECENT ROW ONLY, NOT THE WHOLE HISTORY.
 *
 * Matching ANY prior row made the audit lie about real changes: 742 -> 500 ->
 * 742 wrote two rows and then silently dropped the third, so the trail ended
 * at 500 while the order actually charged 742. A cost is only "unchanged" when
 * it equals what the order was LAST recorded at. `existing` arrives from
 * getShippingCostAudit, which orders created_at DESCENDING, so index 0 is the
 * current state — including a reversal row (exactCostCents null), which is
 * never equal to an amount and therefore correctly lets the next charge write.
 */
export function shouldWriteShippingAudit(
  existing: Array<{ exactCostCents: number | null }>,
  amountCents: number,
): boolean {
  return !(existing.length > 0 && existing[0].exactCostCents === amountCents);
}

function describeReadError(error: unknown): string {
  if (error instanceof Error) return error.message;
  const message = (error as { message?: unknown } | null)?.message;
  return message == null ? String(error) : String(message);
}

export async function recordActualShippingCost(input: RecordShippingCostInput): Promise<{ ok: boolean; error?: string }> {
  const amountCents = Math.max(0, Math.round(input.amountCents));
  const now = new Date().toISOString();

  // Profit BEFORE reconciliation (still on the estimate) — for the audit trail.
  // "Order not found" was ALSO what a transient failure of this read produced,
  // and the sweep then raised a critical alert naming a cause that was not the
  // cause. Separate the two: a throw is an unreadable order, null is a missing
  // one.
  // The UNFILTERED figure on purpose: this is the audit trail for a label cost,
  // not a report, and an order whose payment has not landed still has a real
  // postage cost to record. Going through getOrderProfit here would answer
  // "Order not found" for a row that plainly exists.
  let before: OrderProfit | null = null;
  try {
    before = (await computeProfitForOrderId(input.orderId))?.profit ?? null;
  } catch (profitError) {
    // A POSTGREST ERROR IS A PLAIN OBJECT, NOT AN Error. `String(err)` on one
    // renders "[object Object]", which tells an operator nothing at all — and
    // this is the branch that exists precisely so they are told the real cause
    // instead of "Order not found".
    return {
      ok: false,
      error: `Could not read this order's profit before recording its shipping cost: ${describeReadError(profitError)}`,
    };
  }
  if (!before) return { ok: false, error: "Order not found" };

  const config = await getProfitSettings();

  // Preserve the original estimate the first time we reconcile; a later manual
  // correction must not overwrite it.
  const { data: current, error: currentError } = await supabaseAdmin
    .from("orders")
    .select("estimated_shipping_cost_cents, label_voided_at")
    .eq("order_id", input.orderId)
    .maybeSingle();

  // A GUARD THAT CANNOT READ IS NOT A GUARD THAT FOUND NOTHING.
  //
  // PostgREST does not throw for a statement timeout (57014), a pooler 503 or a
  // schema-cache miss (PGRST204): it resolves { data: null, error }. Discarding
  // that error made `current` undefined, which is byte-identical here to "this
  // order has no voided label and no preserved estimate" — so ONE transient
  // read turned the refusal below into a no-op and let an automated
  // source:"shippo" caller charge refunded postage to profit, and overwrote the
  // preserved per-order estimate with today's flat config figure at the same
  // time. Refuse instead: the sweep counts `failed`, raises its critical alert
  // and tries again next tick, which is what an unreadable row deserves.
  if (currentError) {
    return {
      ok: false,
      error: `Could not read this order before recording its shipping cost: ${currentError.message}`,
    };
  }
  if (!current) {
    return { ok: false, error: "Order not found" };
  }

  // A VOIDED LABEL HAS NO COST TO RECORD, AND THIS FUNCTION IS WHERE THE MONEY
  // IS WRITTEN.
  //
  // voidLabelForOrder refunds the postage and then nulls
  // actual_shipping_cost_cents, but deliberately keeps label_purchased_at and
  // shippo_transaction_id — so everything the repair sweep needs to "re-record"
  // the refunded postage is still sitting on the row. The sweep now filters
  // voided orders out, but a pre-filter is a caller's promise, and this is the
  // only place that actually charges profit. Refusing here means no automated
  // caller, present or future, can re-charge a refunded label: not the sweep,
  // not a replayed Shippo webhook, not order-sync.
  //
  // A PERSON, HOWEVER, IS NOT AN AUTOMATED CALLER, AND THE REFUND CAN BE
  // DECLINED. VoidedLabel.refundPending exists because a carrier void refund
  // frequently settles later — and USPS can refuse it outright. When it is
  // refused the store really did pay that postage, and a blanket refusal here
  // left NO path to record it: not the sweep (it filters voided rows out), not
  // the webhook (this refusal), not the admin screen (which surfaces this
  // error as a 400). That contradicted the sweep's own instruction to "enter
  // the cost by hand in Admin -> Orders". So a MANUAL entry may override, and
  // only a manual one: source "shippo" can never set this flag meaningfully,
  // so no automated path can re-charge by passing it.
  const humanOverride = input.source === "manual" && input.overrideVoidedLabel === true;
  if (current.label_voided_at && !humanOverride) {
    return {
      ok: false,
      error:
        "This order's label was voided and its postage refunded, so there is no shipping cost to record. "
        + "If the carrier DECLINED the refund and the postage was really paid, re-send this entry with "
        + "overrideVoidedLabel to record it by hand.",
    };
  }

  const estimatedCents =
    current.estimated_shipping_cost_cents != null
      ? Number(current.estimated_shipping_cost_cents)
      : Math.round(config.shippingCostPerOrder * 100);

  // .select() SO A ZERO-ROW MATCH IS NOT REPORTED AS A REPAIR. An UPDATE that
  // matches nothing (the order was deleted between the read above and here)
  // returns no error, and returning { ok: true } for it made the sweep count a
  // `repaired` that wrote nothing and still insert an audit row asserting it.
  const { data: updated, error: updateError } = await supabaseAdmin
    .from("orders")
    .update({
      estimated_shipping_cost_cents: estimatedCents,
      actual_shipping_cost_cents: amountCents,
      shipping_cost_source: input.source,
      shipping_cost_updated_at: now,
      profit_finalized: true,
      updated_at: now,
    })
    .eq("order_id", input.orderId)
    .select("order_id");
  if (updateError) return { ok: false, error: updateError.message };
  if (!updated || updated.length === 0) {
    return { ok: false, error: "No order row matched this shipping-cost update." };
  }

  // Profit AFTER reconciliation (now on the exact cost).
  const after = await computeProfitForOrderId(input.orderId).then((r) => r?.profit ?? null).catch(() => null);

  const priorAudit = await getShippingCostAudit(input.orderId);
  if (shouldWriteShippingAudit(priorAudit, amountCents)) {
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
  }

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
