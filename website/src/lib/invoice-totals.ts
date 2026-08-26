// The line items on a customer's invoice, and the one property that matters
// about them: THEY ADD UP TO WHAT THE CUSTOMER PAID.
//
// This is the document a customer forwards to their accounting department. The
// invoice route used to render Subtotal, Discount, Shipping, Handling, Tax and
// then "Total paid" — never reading `card_processing_fee` or
// `shipping_protection_fee`, both of which are part of what was charged. On
// every card order, and on every order with the protection box ticked, the
// visible lines came up short of the total by exactly those amounts, with
// nothing on the page to explain the difference.
//
// Three real production orders had that gap on 2026-08-26: $0.08, $0.15 and
// $2.20 (VL-37C1E4B0, VL-8D132452, VL-E8F4D52F). No card orders exist yet, so
// the 3% surcharge half of it has not been seen by a customer — but the
// protection half has.
//
// Kept apart from the route so the arithmetic can be tested without rendering
// HTML, and so there is exactly one place that decides what an invoice says.

export interface InvoiceLine {
  label: string;
  /** Signed dollars: negative for anything deducted from what was owed. */
  amount: number;
}

export interface InvoiceTotals {
  lines: InvoiceLine[];
  /** `orders.amount_paid` — the figure the lines must reconcile to. */
  totalPaid: number;
  /** Money returned since, shown below the total rather than inside it. */
  refunded: number;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export interface InvoiceOrderFields {
  subtotal: number;
  discountAmount: number;
  shippingAmount: number;
  handlingFee: number;
  taxAmount: number;
  cardProcessingFee: number;
  shippingProtectionFee: number;
  storeCreditRedeemedCents: number;
  pointsRedeemed: number;
  amountPaid: number;
  refundAmount: number;
}

/** 100 points = $1 — points-math.POINTS_PER_DOLLAR_REDEMPTION. */
const POINTS_PER_DOLLAR = 100;

export function buildInvoiceTotals(order: InvoiceOrderFields): InvoiceTotals {
  const lines: InvoiceLine[] = [];
  const push = (label: string, amount: number) => {
    if (round2(amount) !== 0) lines.push({ label, amount: round2(amount) });
  };

  // Subtotal always shows, including a $0 one, so the reader can see the
  // merchandise line exists rather than wondering whether it was omitted.
  lines.push({ label: "Subtotal", amount: round2(order.subtotal) });
  push("Discount", -order.discountAmount);
  lines.push({ label: "Shipping", amount: round2(order.shippingAmount) });
  push("Handling", order.handlingFee);
  push("Shipping Protection", order.shippingProtectionFee);
  // Matches the wallet sheet and the emailed receipt, which both label the card
  // surcharge this way (quote-order's displayLineItems default).
  push("Service Fee", order.cardProcessingFee);
  push("Tax", order.taxAmount);
  push("Store credit", -(order.storeCreditRedeemedCents / 100));
  push("Points redeemed", -(order.pointsRedeemed / POINTS_PER_DOLLAR));

  const totalPaid = round2(order.amountPaid);

  // WHATEVER IS LEFT OVER GETS A LINE. An order written before a column existed
  // can carry a charge none of the fields above explains. Showing the residual
  // as "Other charges" keeps the invoice arithmetically honest, which is the
  // whole reason a customer's accountant opens it; silently swallowing it is
  // the defect this module exists to prevent, and it must not come back through
  // a different door.
  const residual = round2(totalPaid - lines.reduce((sum, line) => sum + line.amount, 0));
  if (residual !== 0) {
    lines.push({ label: residual > 0 ? "Other charges" : "Other adjustments", amount: residual });
  }

  return { lines, totalPaid, refunded: round2(order.refundAmount) };
}

/**
 * True when the rendered lines sum to what the customer paid. The residual line
 * above makes this hold by construction — this exists so a test can assert it
 * rather than trusting that it does.
 */
export function invoiceReconciles(totals: InvoiceTotals): boolean {
  const sum = round2(totals.lines.reduce((acc, line) => acc + line.amount, 0));
  return Math.abs(sum - totals.totalPaid) < 0.005;
}
