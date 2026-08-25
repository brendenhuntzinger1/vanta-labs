/**
 * The receipt lines shown on the order confirmation page.
 *
 * THE RULE: the lines must always add up to what the card was actually charged.
 * `amount_paid` is the settled figure and is never recomputed here — a receipt
 * that disagrees with the customer's card statement is worse than no receipt.
 *
 * SHIPPING PROTECTION IS NOW RECORDED, SO IT IS NAMED, NOT INFERRED.
 *
 * It used to have no column: it was folded into `amount_paid`, so listing only
 * the four known columns left real money unexplained (a $54.99 item settling at
 * $76.04 showed a $21.05 hole). The remainder was surfaced as a line LABELLED
 * "Shipping protection" — a guess that happened to be right most of the time.
 *
 * orders.shipping_protection_fee now holds the real figure, so it is passed in
 * and rendered as itself. That matters when BOTH a protection fee and a genuine
 * adjustment exist: the old residual netted them into one line and could show
 * neither correctly, or hide an adjustment behind a plausible-looking
 * protection charge.
 *
 * The residual line stays, for two reasons. Orders written before the column
 * existed have a 0 in it and still need their remainder explained, and any
 * future unmodelled amount must surface rather than silently break the sum. It
 * is only labelled "Shipping protection" when no recorded fee was supplied —
 * otherwise an unexplained remainder is exactly that, an adjustment.
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
  /**
   * `orders.shipping_protection_fee`. Optional and defaulting to 0 so a caller
   * reading a row from before the column existed behaves exactly as it did —
   * that order's fee still surfaces through the residual instead.
   */
  shippingProtection?: number;
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

  // The RECORDED fee, when there is one. Named rather than inferred.
  const protection = clean(amounts.shippingProtection);
  if (protection > CENT) {
    lines.push({ key: "protection", label: "Shipping protection", amount: round2(protection), tone: "muted" });
  }

  const accounted = subtotal - discount + shipping + handling + tax + protection;
  const residual = round2(total - accounted);

  if (residual > CENT) {
    // With a recorded fee already listed, a further remainder is NOT protection
    // — calling it that would invent a second protection charge. Only an order
    // predating the column gets the old label.
    lines.push(
      protection > CENT
        ? { key: "adjustment", label: "Adjustment", amount: residual, tone: "muted" }
        : { key: "protection", label: "Shipping protection", amount: residual, tone: "muted" },
    );
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
