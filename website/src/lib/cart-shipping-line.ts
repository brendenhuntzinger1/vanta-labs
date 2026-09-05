// ---------------------------------------------------------------------------
// WHAT THE CART DRAWER'S SHIPPING ROW SAYS.
//
// Three surfaces show shipping for the same basket — the drawer, /cart and
// /checkout — and they disagreed the moment the basket crossed the free-shipping
// threshold: /cart said $0.00, /checkout said Free, and the drawer said
// "Calculated at payment", directly under a banner saying free shipping was
// unlocked. The drawer rendered that placeholder for ANY zero, because zero was
// also its "not priced yet" value.
//
// Pure and import-free so it can be tested without rendering the drawer, and so
// the rule is written once.
// ---------------------------------------------------------------------------

export function cartShippingLineLabel(input: {
  /** The shipping figure the drawer is about to show, in dollars. */
  shipping: number;
  /** The server has priced this basket (an offer quote came back). */
  serverQuoted: boolean;
  /** The subtotal has crossed the free-shipping threshold. */
  freeShippingUnlocked: boolean;
  format: (amount: number) => string;
}): string {
  if (input.shipping > 0) return input.format(input.shipping);
  // Zero is "Free" when something has actually decided it is free — the server,
  // or the same threshold rule the banner above the row is rendered from.
  // Otherwise it is honestly unknown until payment.
  if (input.serverQuoted || input.freeShippingUnlocked) return "Free";
  return "Calculated at payment";
}
