import { recordSystemAlert } from "@/lib/monitoring";
import { meetsFloor, type ProfitBreakdown } from "@/lib/profit-engine";

// ---------------------------------------------------------------------------
// THE PROFIT FLOOR TELLS THE OWNER. IT DOES NOT REFUSE THE CUSTOMER.
//
// quoteOrder used to throw "Promotion unavailable on this order." whenever a
// basket priced below the configured floor, and that was the wrong instrument
// twice over.
//
// It was wrong to the SHOPPER: a real order was refused over numbers they
// cannot see and cannot act on, by a message naming a promotion that was
// usually not the cause. On this store's own catalogue and its own ambassador
// rates it refused 8 of 24 ordinary baskets — a single $39.99 vial among them —
// while a $79.98 order was turned away to protect $1.32.
//
// It was wrong to the OWNER: the refusal was silent. No alert, no counter, no
// row anywhere. Sales were being lost with no record that they had been
// attempted, which is why nobody knew.
//
// So the floor keeps its settings and loses its veto. `minProfitDollars` and
// `minProfitPercent` are now an ALERTING threshold: "tell me when an order
// clears less than this", which is a genuinely useful knob and can be set above
// zero without ever costing a sale.
//
// WHAT MUST NOT LEAK. Everything here — COGS, commission, processing fee,
// margin — is internal. It is written to `system_alerts` and to nothing the
// customer can reach. quoteOrder carries the snapshot on its result for the
// server's own use; no checkout surface renders it.
// ---------------------------------------------------------------------------

/**
 * What the order cleared, and what the owner had asked to be told about.
 *
 * Built once inside quoteOrder from the figures it already computes, and
 * carried to order-insert time — which is where the alert belongs, because that
 * is where an order ID exists and where it happens exactly once. Alerting from
 * quoteOrder itself would fire on every cart preview and every re-quote, and
 * would have no order to name.
 */
export interface ProfitFloorSnapshot {
  /** Merchandise subtotal before any discount. */
  subtotal: number;
  /** The single winning customer discount, in dollars. */
  discountAmount: number;
  /** What that discount is called on the receipt, e.g. "Coupon", "15% referral". */
  discountLabel: string;
  /** Ambassador commission this order is expected to accrue. */
  commission: number;
  /** Estimated payment-processing fee at the configured rate. */
  processingFee: number;
  /** Cost of goods, per line, at real per-dose cost where known. */
  productCost: number;
  /** Shipping charged to the customer. */
  shippingCollected: number;
  /** Shipping the store expects to pay. */
  shippingCost: number;
  /** Revenue less COGS, commission, processing and shipping. */
  estimatedProfit: number;
  /** The configured dollar threshold this was measured against. */
  thresholdDollars: number;
  /** The configured percent threshold this was measured against. */
  thresholdPercent: number;
  /** True when the order clears less than the owner asked to be told about. */
  belowFloor: boolean;
}

interface FloorSettings {
  minProfitDollars: number;
  minProfitPercent: number;
}

/**
 * Read the alerting decision off the profit breakdown quoteOrder already has.
 *
 * Delegates to `meetsFloor`, the one floor predicate, so an owner who had tuned
 * the floor keeps exactly the behaviour they tuned — minus the refusal.
 */
export function buildProfitFloorSnapshot(
  profit: ProfitBreakdown,
  settings: FloorSettings,
  discountLabel: string,
  shippingCollected: number,
): ProfitFloorSnapshot {
  // THE predicate, called — not restated. It is the same comparison this floor
  // has always used; only the consequence changed, from refusing the sale to
  // telling the owner about it.
  const belowFloor = !meetsFloor(profit, settings);

  return {
    subtotal: round(profit.discountedSubtotal + profit.discount.amount),
    discountAmount: round(profit.discount.amount),
    discountLabel,
    commission: round(profit.commission),
    processingFee: round(profit.processingFee),
    productCost: round(profit.productCost),
    shippingCollected: round(shippingCollected),
    shippingCost: round(profit.shippingCost),
    estimatedProfit: round(profit.grossProfit),
    thresholdDollars: settings.minProfitDollars,
    thresholdPercent: settings.minProfitPercent,
    belowFloor,
  };
}

/**
 * Record the order and move on.
 *
 * Never throws and never blocks: it is called after the order row is already
 * in, and an alerting failure must not undo a sale that has been made. A null
 * snapshot (a lane that did not price through quoteOrder) is simply nothing to
 * report.
 *
 * NOT DEDUPED. Every below-floor order is its own fact with its own order ID;
 * collapsing them would hide exactly the pattern the owner needs to see —
 * "this happens on every GHRP-2 order with a 15% ambassador" is the finding,
 * and it is invisible if only the first one is written.
 */
export async function alertIfBelowProfitFloor(
  orderId: string,
  snapshot: ProfitFloorSnapshot | null | undefined,
): Promise<void> {
  if (!snapshot || !snapshot.belowFloor) return;

  try {
    await recordSystemAlert({
      type: "order_below_profit_floor",
      severity: "warning",
      message: `Order ${orderId} cleared ${money(snapshot.estimatedProfit)} against a ${money(snapshot.thresholdDollars)} floor`
        + ` — ${snapshot.discountLabel} ${money(snapshot.discountAmount)} off ${money(snapshot.subtotal)}.`
        + " The order was completed; this is a margin notice, not a failure.",
      context: { orderId, ...snapshot },
    });
  } catch (error) {
    // The sale is already made. A missing notice is a reporting gap, never a
    // reason to fail the order that has just been placed.
    console.error("[profit-floor] unable to record below-floor alert", orderId, error);
  }
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function money(value: number): string {
  return `${value < 0 ? "-" : ""}$${Math.abs(value).toFixed(2)}`;
}
