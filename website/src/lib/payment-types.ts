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
  city: string;
  postalCode: string;
}

export interface PromotionInput {
  code: string;
  discountPercent: number;
  expiresAt: string;
  status: "Active" | "Inactive";
  maxUses: number;
  uses: number;
}
