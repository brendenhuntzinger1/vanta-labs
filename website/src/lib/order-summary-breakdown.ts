/**
 * The receipt lines shown on the order confirmation page.
 *
 * THE RULE: the lines must always add up to what the card was actually charged.
 * `amount_paid` is the settled figure and is never recomputed here — a receipt
 * that disagrees with the customer's card statement is worse than no receipt.
 *
 * Shipping protection has no dedicated column on `orders`; it is folded into
 * `amount_paid`. Listing only the four known columns therefore left real money
 * unexplained (a $54.99 item settling at $76.04 showed a $21.05 hole). So the
 * unaccounted remainder is surfaced as its own line rather than silently
 * dropped, and if the remainder is NEGATIVE — an adjustment or partial refund
 * applied after the fact — it is shown as a credit. Either way the column sums.
 */

export type OrderAmounts = {
  /** `orders.amount_paid` — the settled charge. Authoritative. */
  total: number;
  subtotal: number;
  shipping: number;
  handling: number;
  tax: number;
  discount: number;
  /** Sum of the order's line totals, used only when `subtotal` wasn't recorded. */
  itemsTotal: number;
};

export type SummaryLine = {
  key: "subtotal" | "discount" | "shipping" | "handling" | "protection" | "adjustment" | "tax";
  label: string;
  /** Signed dollars. Credits are negative. */
  amount: number;
  tone: "muted" | "credit";
};

/** Cents-accurate rounding — floats drift, and this feeds a money column. */
function round2(value: number) {
  return Math.round(value * 100) / 100;
}

function clean(value: number | null | undefined) {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/** Half a cent — below this a residual is float noise, not money. */
const CENT = 0.005;

export function buildOrderSummaryLines(amounts: OrderAmounts): SummaryLine[] {
  const total = clean(amounts.total);
  const shipping = clean(amounts.shipping);
  const handling = clean(amounts.handling);
  const tax = clean(amounts.tax);
  const discount = clean(amounts.discount);

  // Older orders were written without a subtotal. Falling back to the item
  // lines keeps the receipt honest instead of reporting "Subtotal $0.00" and
  // dumping the entire order value into the residual line.
  const recorded = clean(amounts.subtotal);
  const subtotal = recorded > 0 ? recorded : clean(amounts.itemsTotal);

  const lines: SummaryLine[] = [{ key: "subtotal", label: "Subtotal", amount: round2(subtotal), tone: "muted" }];

  if (discount > CENT) {
    lines.push({ key: "discount", label: "Discount", amount: round2(-discount), tone: "credit" });
  }

  lines.push({ key: "shipping", label: "Shipping", amount: round2(shipping), tone: "muted" });

  if (handling > CENT) {
    lines.push({ key: "handling", label: "Handling", amount: round2(handling), tone: "muted" });
  }

  const accounted = subtotal - discount + shipping + handling + tax;
  const residual = round2(total - accounted);

  if (residual > CENT) {
    lines.push({ key: "protection", label: "Shipping protection", amount: residual, tone: "muted" });
  } else if (residual < -CENT) {
    lines.push({ key: "adjustment", label: "Adjustment", amount: residual, tone: "credit" });
  }

  if (tax > CENT) {
    lines.push({ key: "tax", label: "Sales tax", amount: round2(tax), tone: "muted" });
  }

  return lines;
}

/** Sum of the rendered lines. Equals the settled charge, by construction. */
export function sumSummaryLines(lines: SummaryLine[]): number {
  return round2(lines.reduce((running, line) => running + line.amount, 0));
}
