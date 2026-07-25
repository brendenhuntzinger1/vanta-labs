import "server-only";

import { supabaseAdmin } from "@/lib/supabase-server";
import { getProfitSettings, type ProfitSettingsConfig } from "@/lib/admin-control";
import { computeOrderProfit, type OrderProfitLine, type OrderProfitResult } from "@/lib/order-profit";
import { isPaidOrderStatus } from "@/lib/ledger";

// The order fields profit needs. Everything is stored on the order at checkout,
// so profit is computed from the record — not from today's live product cost.
const ORDER_FIELDS =
  "order_id, order_number, subtotal, discount_amount, shipping_amount, refund_amount, amount_paid, payment_method, payment_status, paid_at, created_at";

type OrderRecord = {
  order_id: string;
  order_number?: string | null;
  subtotal: number | null;
  discount_amount: number | null;
  shipping_amount: number | null;
  refund_amount: number | null;
  amount_paid: number | null;
  payment_method: string | null;
  payment_status: string | null;
  paid_at: string | null;
  created_at: string | null;
};

export interface OrderProfit extends OrderProfitResult {
  orderId: string;
  orderNumber: string | null;
  paidAt: string | null;
  createdAt: string | null;
}

// Peer-to-peer / off-platform methods settle with no card-processor fee. The
// live catalog only offers card today, but this keeps the math correct if a
// manual method is ever enabled.
const MANUAL_HINTS = ["cash", "zelle", "venmo", "paypal", "manual", "wire", "ach", "bank"];
function isManualMethod(method: string | null): boolean {
  const m = (method ?? "").toLowerCase();
  return MANUAL_HINTS.some((hint) => m.includes(hint));
}

function processingFeeFor(order: OrderRecord, processingFeePercent: number): number {
  if (isManualMethod(order.payment_method)) return 0;
  const charged = Number(order.amount_paid ?? 0);
  if (!Number.isFinite(charged) || charged <= 0) return 0;
  return Math.max(0, charged * (processingFeePercent / 100));
}

function profitForOrder(
  order: OrderRecord,
  lines: OrderProfitLine[],
  commission: number,
  config: ProfitSettingsConfig,
): OrderProfitResult {
  const merch = Math.max(0, Number(order.subtotal ?? 0) - Number(order.discount_amount ?? 0));
  return computeOrderProfit({
    netMerchandiseRevenue: merch,
    // What the customer paid for shipping (0 on free-shipping orders).
    shippingRevenue: Math.max(0, Number(order.shipping_amount ?? 0)),
    // What the store pays to ship the order (configured default, e.g. $10).
    shippingCost: Math.max(0, config.shippingCostPerOrder),
    lines,
    commission,
    processingFee: processingFeeFor(order, config.processingFeePercent),
    refund: Math.max(0, Number(order.refund_amount ?? 0)),
    fallbackUnitCostCents: Math.round(config.worstCaseUnitCost * 100),
  });
}

// ---- Batch helpers: fetch COGS lines + commissions for a set of orders ----

async function costLinesByOrderId(orderIds: string[]): Promise<Map<string, OrderProfitLine[]>> {
  const byOrder = new Map<string, OrderProfitLine[]>();
  if (orderIds.length === 0) return byOrder;

  const { data } = await supabaseAdmin
    .from("order_items")
    .select("order_id, quantity, unit_cost_cents")
    .in("order_id", orderIds);

  for (const raw of (data ?? []) as Array<{ order_id: string; quantity: number | null; unit_cost_cents: number | null }>) {
    const list = byOrder.get(raw.order_id) ?? [];
    list.push({
      unitCostCents: raw.unit_cost_cents == null ? null : Number(raw.unit_cost_cents),
      quantity: Number(raw.quantity ?? 0),
    });
    byOrder.set(raw.order_id, list);
  }
  return byOrder;
}

async function commissionByOrderId(orderIds: string[]): Promise<Map<string, number>> {
  const byOrder = new Map<string, number>();
  if (orderIds.length === 0) return byOrder;

  const { data } = await supabaseAdmin
    .from("commissions")
    .select("order_id, commission_amount")
    .in("order_id", orderIds);

  for (const raw of (data ?? []) as Array<{ order_id: string; commission_amount: number | null }>) {
    byOrder.set(raw.order_id, (byOrder.get(raw.order_id) ?? 0) + Math.max(0, Number(raw.commission_amount ?? 0)));
  }
  return byOrder;
}

function toOrderProfit(order: OrderRecord, result: OrderProfitResult): OrderProfit {
  return {
    ...result,
    orderId: order.order_id,
    orderNumber: order.order_number ?? null,
    paidAt: order.paid_at ?? null,
    createdAt: order.created_at ?? null,
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
  const [lines, commissions] = await Promise.all([
    costLinesByOrderId([orderId]),
    commissionByOrderId([orderId]),
  ]);

  const result = profitForOrder(record, lines.get(orderId) ?? [], commissions.get(orderId) ?? 0, config);
  return toOrderProfit(record, result);
}

// ---- Many orders, computed once (used by dashboard + analytics) ----

async function profitForPaidOrdersInRange(fromIso: string, toIso: string): Promise<OrderProfit[]> {
  const [{ data: orders }, config] = await Promise.all([
    supabaseAdmin
      .from("orders")
      .select(ORDER_FIELDS)
      .gte("created_at", fromIso)
      .lte("created_at", toIso),
    getProfitSettings(),
  ]);

  // Include paid orders AND partially-refunded ones (they still netted
  // revenue; the refund is subtracted per-order in computeOrderProfit).
  // Fully "refunded" orders netted ~nothing and are excluded, matching the
  // revenue reports.
  const paid = ((orders ?? []) as OrderRecord[]).filter(
    (o) => isPaidOrderStatus(o.payment_status) || String(o.payment_status ?? "").toLowerCase() === "partially_refunded",
  );
  const orderIds = paid.map((o) => o.order_id).filter(Boolean);

  const [lines, commissions] = await Promise.all([
    costLinesByOrderId(orderIds),
    commissionByOrderId(orderIds),
  ]);

  return paid.map((order) =>
    toOrderProfit(order, profitForOrder(order, lines.get(order.order_id) ?? [], commissions.get(order.order_id) ?? 0, config)),
  );
}

export interface ProfitWindowMetrics {
  today: number;
  last7Days: number;
  last30Days: number;
  ordersLast30Days: number;
  hasEstimatedCost: boolean;
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

  const rows = await profitForPaidOrdersInRange(fromIso, toIso);

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
      ordersLast30Days += 1;
      if (row.hasEstimatedCost) hasEstimatedCost = true;
    }
    if (eventTime >= weekStart) last7Days += row.profit;
    if (eventTime >= dayStart) today += row.profit;
  }

  const round = (v: number) => Math.round(v * 100) / 100;
  return { today: round(today), last7Days: round(last7Days), last30Days: round(last30Days), ordersLast30Days, hasEstimatedCost };
}

export interface ProfitTrendPoint {
  date: string;
  profit: number;
}

// Per-day net profit across a date range (Analytics profit trend).
export async function getProfitTrend(fromIso: string, toIso: string): Promise<ProfitTrendPoint[]> {
  const rows = await profitForPaidOrdersInRange(fromIso, toIso);
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
