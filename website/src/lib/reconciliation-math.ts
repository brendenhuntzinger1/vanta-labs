// Pure reconciliation math — no "server-only" so it is unit-testable. Used by
// admin-reconciliation.ts to decide whether an order's recorded amount_paid
// matches what the order's components imply.

function round2(v: number) {
  return Math.round(v * 100) / 100;
}

// Protection is folded into amount_paid but not stored as its own column, so a
// fully-reconciled order can legitimately be up to the protection fee above the
// component-derived expected total. The fee is a percentage of the merchandise
// subtotal (see shipping-protection.ts), so the allowance is computed per order
// from its subtotal rather than a flat cap.
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
}

// Mirrors payment-service's amount_paid formula (merchandise − discount + tax +
// card fee, less store credit and points), EXCLUDING the shipping-protection
// fee which isn't stored separately.
export function expectedOrderTotal(c: ExpectedTotalComponents): number {
  return round2(c.subtotal + c.tax + c.cardFee + c.shipping - c.discount - c.storeCredit - c.pointsDollars);
}

// A TRUE mismatch is either underpayment, or an overage beyond the order's max
// protection fee. An order that paid between expectedTotal and expectedTotal +
// maxProtectionFee is reconciled (the difference is the protection fee).
// Callers pass maxShippingProtectionFee(order.subtotal).
export function isTotalMismatch(
  amountPaid: number,
  expectedTotal: number,
  maxProtectionFee: number,
): boolean {
  return amountPaid < expectedTotal - 0.01 || amountPaid > expectedTotal + maxProtectionFee + 0.01;
}
