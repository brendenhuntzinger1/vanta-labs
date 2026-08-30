export type OrderStatus =
  | "pending_payment"
  | "paid"
  | "payment_failed"
  | "awaiting_fulfillment"
  | "sent_to_fulfillment"
  | "fulfilled"
  | "shipped"
  | "delivered"
  | "canceled"
  | "refunded"
  | "partially_refunded";

export interface CartItemInput {
  id: string;
  quantity: number;
}

export interface CustomerInput {
  email: string;
  fullName: string;
  address: string;
  /** Apartment / suite / unit. Optional — most addresses genuinely have none. */
  address2?: string;
  city: string;
  postalCode: string;
  country: string;
  state?: string;
  phone?: string;
}

export interface PromotionInput {
  code: string;
  discountPercent: number;
  expiresAt: string;
  status: "Active" | "Inactive";
  maxUses: number;
  uses: number;
}

/**
 * Statuses an order does not come back from.
 *
 * The money has been returned or the order was cancelled outright, so any later
 * event claiming to advance it is describing a different order than the one the
 * database holds. payment_failed is deliberately NOT here: a manual payment that
 * was rejected is meant to be resubmittable, and /api/checkout/submit-payment
 * clears the rejection reason precisely so it can be.
 *
 * Shared rather than repeated, because it was already spelled out twice — once
 * in processPaymentWebhook and once, by omission, in submit-payment, which
 * guarded only against "paid" and would happily move a refunded order back into
 * the admin's approval queue.
 */
export const FULLY_TERMINAL_ORDER_STATES: ReadonlySet<string> = new Set(["refunded", "canceled"]);
