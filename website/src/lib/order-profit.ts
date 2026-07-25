// -------------------------------------------------------------------------
// Canonical per-order profit math, computed from what an order ACTUALLY
// recorded — never from today's live product cost. The unit cost is the value
// snapshotted onto each order line at checkout (order_items.unit_cost_cents),
// so a later cost change never rewrites a historical order's profit.
//
// Profit = net merchandise revenue
//          − COGS (snapshotted cost × qty)
//          − ambassador commission
//          − card processing fee
//          − shipping cost the store actually absorbed (e.g. free shipping)
//
// Sales tax is intentionally NOT counted as profit: tax collected is remitted
// to the state, so it's a pass-through, not earnings. (Revenue here is
// ex-tax.) Refunds reduce net revenue.
// -------------------------------------------------------------------------

export interface OrderProfitLine {
  /** Cost per unit at checkout time, in cents (order_items.unit_cost_cents). */
  unitCostCents: number | null;
  quantity: number;
}

export interface OrderProfitInput {
  /** Merchandise subtotal collected, ex-tax, ex-shipping, after discounts. */
  netMerchandiseRevenue: number;
  /** COGS lines (snapshotted unit cost × qty). */
  lines: OrderProfitLine[];
  /** Ambassador commission paid on this order (0 if none). */
  commission: number;
  /** Card processing fee the store paid (0 for fee-free / manual methods). */
  processingFee: number;
  /** Shipping cost the store absorbed (e.g. free-shipping orders). */
  shippingCost: number;
  /** Amount refunded to the customer (reduces net revenue). */
  refund: number;
  /** Worst-case unit cost (cents) used only when a line has no snapshot. */
  fallbackUnitCostCents?: number;
}

export interface OrderProfitResult {
  revenue: number;
  cogs: number;
  commission: number;
  processingFee: number;
  shippingCost: number;
  refund: number;
  profit: number;
  /** Gross margin as a percent of revenue (0 when revenue ≤ 0). */
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
  const revenue = round(Math.max(0, input.netMerchandiseRevenue) - Math.max(0, input.refund));
  const commission = round(Math.max(0, input.commission));
  const processingFee = round(Math.max(0, input.processingFee));
  const shippingCost = round(Math.max(0, input.shippingCost));

  const profit = round(revenue - cogs - commission - processingFee - shippingCost);
  const marginPercent = revenue > 0 ? round((profit / revenue) * 100) : 0;

  return {
    revenue,
    cogs,
    commission,
    processingFee,
    shippingCost,
    refund: round(Math.max(0, input.refund)),
    profit,
    marginPercent,
    hasEstimatedCost,
  };
}
