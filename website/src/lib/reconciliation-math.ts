// Pure reconciliation math — no "server-only" so it is unit-testable. Used by
// admin-reconciliation.ts to decide whether an order's recorded amount_paid
// matches what the order's components imply.

function round2(v: number) {
  return Math.round(v * 100) / 100;
}

// LEGACY ALLOWANCE. Protection used to be folded into amount_paid and stored in
// no column, so a fully-reconciled order could sit up to its protection fee
// above the component-derived total and there was no way to tell that overage
// from a real one. orders.shipping_protection_fee now records it, so a row that
// has the fee is checked EXACTLY (callers pass an allowance of 0) and this
// remains only for rows predating the column — where a wide band is still
// better than a false alarm on every protected order.
import { calculateShippingProtectionFee } from "@/lib/shipping-protection";

export function maxShippingProtectionFee(subtotal: number): number {
  return calculateShippingProtectionFee(subtotal);
}

export interface ExpectedTotalComponents {
  subtotal: number;
  shipping: number;
  tax: number;
  cardFee: number;
  discount: number;
  storeCredit: number; // dollars
  pointsDollars: number; // dollars
  /**
   * `orders.handling_fee`. Every writer sets it to 0 today (quote-order,
   * membership-billing, admin-replacements), but the column exists, is
   * `not null default 0`, and the customer invoice renders a Handling line from
   * it. Left out of this sum, the first order that ever carries one is accused
   * of overpaying by exactly the handling fee. Optional and defaulting to 0, so
   * a caller that does not read the column behaves exactly as before.
   */
  handlingFee?: number;
  /**
   * The recorded Shipping Protection fee, in dollars. Optional and defaulting
   * to 0 so a caller reading a row from before the column existed behaves
   * exactly as it did before — those callers pass a non-zero allowance to
   * isTotalMismatch instead.
   */
  shippingProtection?: number;
}

// Mirrors quote-order's amount_paid formula: merchandise − discount + tax +
// card fee, less store credit and points, PLUS the shipping-protection fee.
// Protection is the only term added after the rest, which is why an order
// missing it was always short by exactly that amount.
//
// NOT BIT-IDENTICAL, DELIBERATELY. quote-order rounds to the cent at four
// intermediate steps (totalBeforePoints, totalAfterCredit, expectedTotal,
// finalTotal); this rounds once, at the end. On a minority of baskets those two
// orders of operations land a cent apart — measured, not assumed: a 600-basket
// differential sweep in reconciliation-drift.test.ts drives the real quoteOrder
// into the real buildOrderRow and into this function, and finds gaps of exactly
// one cent and never more. isTotalMismatch's ±$0.01 band is what absorbs that,
// which is the SECOND reason that band exists and the reason it may not be
// tightened to zero. See the note there.
export function expectedOrderTotal(c: ExpectedTotalComponents): number {
  return round2(
    c.subtotal + c.tax + c.cardFee + c.shipping + (c.handlingFee ?? 0)
      - c.discount - c.storeCredit - c.pointsDollars
      + (c.shippingProtection ?? 0),
  );
}

// A TRUE mismatch is either underpayment, or an overage beyond the allowance.
//
// THE ±$0.01 IS LOAD-BEARING. It reads like ordinary float slop; it is not.
// expectedOrderTotal rounds once where quote-order rounds four times, and those
// two orders of operations genuinely differ by a cent on some baskets (see the
// note above expectedOrderTotal, and the measured sweep in
// reconciliation-drift.test.ts). Tightening this to an exact comparison would
// start flagging correctly-priced orders on the one screen an operator opens
// when they already suspect something is wrong.
//
// Pass 0 for maxProtectionFee when the order's protection fee is recorded and
// already folded into expectedTotal — that is the normal case now, and it makes
// the check exact to the cent. Pass maxShippingProtectionFee(order.subtotal)
// only for a row that predates orders.shipping_protection_fee, where the fee is
// genuinely unknown.
export function isTotalMismatch(
  amountPaid: number,
  expectedTotal: number,
  maxProtectionFee: number,
): boolean {
  return amountPaid < expectedTotal - 0.01 || amountPaid > expectedTotal + maxProtectionFee + 0.01;
}
