// -------------------------------------------------------------------------
// Canonical per-order profit math, computed from what an order ACTUALLY
// recorded — never from today's live product cost. The unit cost is the value
// snapshotted onto each order line at checkout (order_items.unit_cost_cents),
// so a later cost change never rewrites a historical order's profit.
//
// True net profit =
//     net merchandise revenue (subtotal − discounts, ex-tax)
//   + shipping revenue collected (what the customer paid for shipping; 0 when
//     the order shipped free)
//   − COGS (snapshotted unit cost × qty)
//   − ambassador commission
//   − card processing fee
//   − shipping cost the store actually pays to ship the order
//   − refunds issued
//
// Sales tax is intentionally NOT counted as profit: tax collected is remitted
// to the state, so it's a pass-through, not earnings.
// -------------------------------------------------------------------------

export interface OrderProfitLine {
  /** Cost per unit at checkout time, in cents (order_items.unit_cost_cents). */
  unitCostCents: number | null;
  quantity: number;
}

export interface OrderProfitInput {
  /** Merchandise subtotal collected, ex-tax, ex-shipping, after discounts. */
  netMerchandiseRevenue: number;
  /** Shipping the customer paid (0 for free-shipping orders). */
  shippingRevenue: number;
  /** Shipping cost the store pays to ship this order (e.g. $10 default). */
  shippingCost: number;
  /** COGS lines (snapshotted unit cost × qty). */
  lines: OrderProfitLine[];
  /** Ambassador commission paid on this order (0 if none). */
  commission: number;
  /** Card processing fee the store paid (0 for fee-free / manual methods). */
  processingFee: number;
  /** Amount refunded to the customer (reduces net revenue). */
  refund: number;
  /** Worst-case unit cost (cents) used only when a line has no snapshot. */
  fallbackUnitCostCents?: number;
}

export interface OrderProfitResult {
  /** Net revenue kept = merchandise + shipping − refund. */
  revenue: number;
  merchandiseRevenue: number;
  shippingRevenue: number;
  cogs: number;
  commission: number;
  processingFee: number;
  shippingCost: number;
  refund: number;
  profit: number;
  /** Net margin as a percent of revenue (0 when revenue ≤ 0). */
  marginPercent: number;
  /** True when any line was missing a cost snapshot (profit is an estimate). */
  hasEstimatedCost: boolean;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

export function computeOrderProfit(input: OrderProfitInput): OrderProfitResult {
  const fallback = Math.max(0, input.fallbackUnitCostCents ?? 0);
  let cogsCents = 0;
  let hasEstimatedCost = false;

  for (const line of input.lines) {
    const qty = Math.max(0, Math.round(line.quantity));
    if (line.unitCostCents == null) {
      hasEstimatedCost = true;
      cogsCents += fallback * qty;
    } else {
      cogsCents += Math.max(0, Math.round(line.unitCostCents)) * qty;
    }
  }

  const cogs = round(cogsCents / 100);
  const merchandiseRevenue = round(Math.max(0, input.netMerchandiseRevenue));
  const shippingRevenue = round(Math.max(0, input.shippingRevenue));
  const commission = round(Math.max(0, input.commission));
  const processingFee = round(Math.max(0, input.processingFee));
  const shippingCost = round(Math.max(0, input.shippingCost));
  const refund = round(Math.max(0, input.refund));

  const revenue = round(merchandiseRevenue + shippingRevenue - refund);
  const profit = round(revenue - cogs - commission - processingFee - shippingCost);
  const marginPercent = revenue > 0 ? round((profit / revenue) * 100) : 0;

  return {
    revenue,
    merchandiseRevenue,
    shippingRevenue,
    cogs,
    commission,
    processingFee,
    shippingCost,
    refund,
    profit,
    marginPercent,
    hasEstimatedCost,
  };
}
