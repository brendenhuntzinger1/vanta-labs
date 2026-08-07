import { randomUUID } from "crypto";
import { getPaymentProvider } from "@/lib/payment-provider";
import { reserveInventoryForOrder, describeUnavailable, DEFAULT_RESERVATION_MINUTES, MANUAL_RESERVATION_MINUTES } from "@/lib/inventory-reservation";
import { getPaymentMethodById, isManualPaymentMethod } from "@/lib/payment-methods";
import {
  buildOrderRow,
  insertOrderItems,
  insertOrderRow,
  quoteOrder,
  sanitizeText,
  type ServerProduct,
} from "@/lib/quote-order";
import { supabaseAdmin } from "@/lib/supabase-server";

import type {
 CartItemInput,
 CustomerInput,
 OrderStatus,
} from "@/lib/payment-types";

export type { ServerProduct };

export interface PendingOrder {
 orderId: string;
 orderNumber: string;
 status: OrderStatus;
 total: number;
 subtotal: number;
 shipping: number;
 discountAmount: number;
 paymentMethod: string;
 isManualPayment: boolean;
 cardProcessingFee: number;
 cardProcessingFeePercent: number;
 paymentId: string;
 hostedCheckoutUrl: string;
}

export interface CreateCheckoutPayload {
 items: CartItemInput[];
 customer: CustomerInput;
 referralCode?: string;
 couponCode?: string;
 currency?: string;
 expectedTotal?: number;
 customerUserId?: string;
 pointsToRedeem?: number;
 shippingProtection?: boolean;
 paymentMethod?: string;
 /** Client-generated UUID, stable across retries of the SAME checkout submit.
  *  Dedupes order creation so a lost response + user retry can't double-order. */
 idempotencyKey?: string;
 /** Billing address (persisted for the card processor's AVS). Optional. */
 billing?: {
   fullName?: string;
   address?: string;
   city?: string;
   postalCode?: string;
 };
}

// Short, human-friendly order number a customer can copy into a Cash App /
// Zelle / PayPal note. The internal order_id (a UUID) is unchanged and stays
// the primary key everything else references.
export function generateOrderNumber() {
 return `VL-${randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`;
}

// True when the CUSTOMER checking out is themselves an approved ambassador —
// used to grant the personal ambassador discount on their own purchase. See
// isApprovedAmbassadorCustomer in src/lib/ambassador-status.ts (shared with the
// account endpoint that drives the checkout preview).

export async function createCheckoutSession(
 payload: CreateCheckoutPayload,
): Promise<PendingOrder> {
 // Every price, discount, tax, profit-floor and stock decision lives in
 // quoteOrder (src/lib/quote-order.ts) so the express wallet lane runs the
 // identical math rather than a second copy of it.
 const quote = await quoteOrder({
   items: payload.items,
   customer: payload.customer,
   referralCode: payload.referralCode,
   couponCode: payload.couponCode,
   customerUserId: payload.customerUserId,
   pointsToRedeem: payload.pointsToRedeem,
   shippingProtection: payload.shippingProtection,
   paymentMethod: payload.paymentMethod,
   expectedTotal: payload.expectedTotal,
   mode: "full",
 });

 const {
   lineItems,
   subtotal,
   shipping,
   discountAmount,
   bulkDiscountTier,
   isPriorityOrder,
   taxQuote,
   taxAmount,
   referral,
   couponCode,
   isBuy3Get1Active,
   storeCreditRedeemedCents,
   pointsRedeemed,
   pointsDiscountAmount,
   paymentMethods,
   selectedMethod,
   isManualPayment: isManual,
   cardFee,
   finalTotal,
   unitCostCentsForLine,
 } = quote;

 const orderId = `order-${randomUUID()}`;
 const orderNumber = generateOrderNumber();
 const provider = getPaymentProvider();

 // Idempotency: if this exact submit was already turned into an order (a lost
 // response then a user/network retry re-POSTs the same key), return that
 // existing order instead of creating a second one with its own inventory
 // hold. Best-effort — silently skipped if the column/migration isn't present.
 const idempotencyKey = typeof payload.idempotencyKey === "string" && payload.idempotencyKey.trim()
   ? payload.idempotencyKey.trim().slice(0, 64)
   : null;
 if (idempotencyKey) {
   try {
     const { data: existing } = await supabaseAdmin
       .from("orders")
       .select("order_id, order_number, payment_id, payment_method, amount_paid, card_processing_fee, card_processing_fee_percent, payment_status")
       .eq("idempotency_key", idempotencyKey)
       .not("payment_status", "in", "(canceled,cancelled,payment_failed)")
       .maybeSingle();
     if (existing) {
       const existingIsManual = isManualPaymentMethod(getPaymentMethodById(paymentMethods, String(existing.payment_method ?? "")));
       let existingHostedUrl = "";
       if (!existingIsManual) {
         try {
           const resumed = await provider.createCheckoutSession({
             orderId: String(existing.order_id),
             customerEmail: payload.customer.email,
             amount: Math.round(Number(existing.amount_paid ?? 0) * 100),
             currency: payload.currency ?? "USD",
             metadata: { orderId: String(existing.order_id), orderNumber: String(existing.order_number) },
           });
           existingHostedUrl = resumed.hostedCheckoutUrl ?? "";
         } catch {
           existingHostedUrl = "";
         }
       }
       return {
         orderId: String(existing.order_id),
         orderNumber: String(existing.order_number),
         status: "pending_payment",
         total: Number(existing.amount_paid ?? finalTotal),
         subtotal,
         shipping,
         discountAmount,
         paymentMethod: String(existing.payment_method ?? selectedMethod.id),
         isManualPayment: existingIsManual,
         cardProcessingFee: Number(existing.card_processing_fee ?? 0),
         cardProcessingFeePercent: Number(existing.card_processing_fee_percent ?? 0),
         paymentId: String(existing.payment_id ?? existing.order_id),
         hostedCheckoutUrl: existingHostedUrl,
       };
     }
   } catch {
     // Column missing or lookup failed — proceed to create normally.
   }
 }

 const orderRow = buildOrderRow({
   orderId,
   orderNumber,
   idempotencyKey,
   paymentId: null,
   paymentMethod: selectedMethod.id,
   cardProcessingFee: cardFee.amount,
   cardProcessingFeePercent: cardFee.percentage,
   customer: payload.customer,
   billing: payload.billing,
   currency: payload.currency ?? "USD",
   subtotal,
   shippingAmount: shipping,
   taxAmount,
   discountAmount,
   bulkDiscountTier,
   priority: isPriorityOrder,
   amountPaid: finalTotal,
   referralCode: referral?.code ?? null,
   ambassadorId: referral?.ambassadorId ?? null,
   couponCode,
   customerUserId: payload.customerUserId ?? null,
   pointsRedeemed,
   storeCreditRedeemedCents,
   taxRatePercent: taxQuote.collected ? taxQuote.ratePercent : 0,
   taxState: taxQuote.collected ? taxQuote.state : null,
 });

 // A unique-index violation on idempotency_key means a truly-simultaneous
 // duplicate submit beat us to the insert — return that order rather than
 // erroring, so the user's retry lands on their real (single) order.
 const returnExistingByIdempotency = async () => {
   if (!idempotencyKey) return null;
   const { data: existing } = await supabaseAdmin
     .from("orders")
     .select("order_id, order_number, payment_id, payment_method, amount_paid, card_processing_fee, card_processing_fee_percent, payment_status")
     .eq("idempotency_key", idempotencyKey)
     .maybeSingle();
   if (!existing) return null;
   const existingIsManual = isManualPaymentMethod(getPaymentMethodById(paymentMethods, String(existing.payment_method ?? "")));
   return {
     orderId: String(existing.order_id),
     orderNumber: String(existing.order_number),
     status: "pending_payment" as const,
     total: Number(existing.amount_paid ?? finalTotal),
     subtotal,
     shipping,
     discountAmount,
     paymentMethod: String(existing.payment_method ?? selectedMethod.id),
     isManualPayment: existingIsManual,
     cardProcessingFee: Number(existing.card_processing_fee ?? 0),
     cardProcessingFeePercent: Number(existing.card_processing_fee_percent ?? 0),
     paymentId: String(existing.payment_id ?? existing.order_id),
     hostedCheckoutUrl: "",
   };
 };

 const insertOutcome = await insertOrderRow(orderRow);
 if (insertOutcome.status === "duplicate") {
   const dup = await returnExistingByIdempotency();
   if (dup) return dup;
 }
 if (insertOutcome.status !== "inserted") {
   console.error("Unable to create order record", insertOutcome.status === "error" ? insertOutcome.error : "duplicate");
   throw new Error("Unable to create order record");
 }

 const { payload: orderItemsPayload, error: itemInsertError } = await insertOrderItems(
   orderId,
   lineItems,
   unitCostCentsForLine,
 );
 if (itemInsertError) {
   console.error("Unable to create order items", itemInsertError);
   throw new Error("Unable to create order items");
 }

 // Reserve stock ATOMICALLY now that the order + items exist (checkout has
 // begun — never at add-to-cart). Card/instant orders hold for 15 minutes;
 // manual (off-platform) orders hold longer since an admin verifies them later.
 // If any tracked line is short, cancel this order and stop — the customer is
 // never charged for stock we can't fulfil. The hold is finalized (permanently
 // deducted) only on a verified paid webhook, released on failure/cancel, and
 // auto-expired by the sweep. Fails open (never blocks) if the layer is down.
 const reservation = await reserveInventoryForOrder(
   orderId,
   orderItemsPayload.map((i) => ({ productId: i.product_id, quantity: i.quantity })),
   { expiresInMinutes: isManual ? MANUAL_RESERVATION_MINUTES : DEFAULT_RESERVATION_MINUTES },
 );
 if (!reservation.ok) {
   await supabaseAdmin
     .from("orders")
     .update({ payment_status: "canceled", updated_at: new Date().toISOString() })
     .eq("order_id", orderId);
   // Name the item and the number left. "Something sold out" makes the customer
   // guess which line and by how much, which is how a fixable cart becomes an
   // abandoned one.
   throw new Error(describeUnavailable(reservation.unavailable));
 }

 // Manual methods (settled off-platform) have no hosted processor session: the
 // customer follows on-page instructions and submits a transaction id. Only the
 // card method uses the payment provider (its existing hosted-checkout flow,
 // unchanged).
 let paymentId = orderId;
 let hostedCheckoutUrl = "";

 if (!isManual) {
   const checkout = await provider.createCheckoutSession({
   orderId,
   customerEmail: payload.customer.email,
   // Minor units (cents) — the standard for card processors (Stripe/Square).
   // Avoids the whole-dollar rounding that silently dropped cents before.
   amount: Math.round(finalTotal * 100),
   currency: payload.currency ?? "USD",

   metadata: {
   orderId,
   orderNumber,
   paymentMethod: selectedMethod.id,
   cardProcessingFee: cardFee.amount.toFixed(2),
   ambassadorId: referral?.ambassadorId ?? "",
   referralCode: referral?.code ?? "",
   couponCode: couponCode ?? "",
   promotionApplied: bulkDiscountTier
     ? "BULK_SAVINGS"
     : isBuy3Get1Active
       ? "BUY_3_GET_1"
       : referral
         ? "REFERRAL"
         : couponCode
           ? "COUPON"
           : "NONE",
   originalSubtotal: subtotal.toFixed(2),
   customerDiscount: discountAmount.toFixed(2),
   pointsRedeemed: String(pointsRedeemed),
   amountPaid: finalTotal.toFixed(2),
   customerEmail: payload.customer.email,
   customerUserId: payload.customerUserId ?? "",
   },
   });
   paymentId = checkout.paymentId;
   hostedCheckoutUrl = checkout.hostedCheckoutUrl;
 }

 return {
 orderId,
 orderNumber,
 status: "pending_payment",
 total: finalTotal,
 subtotal,
 shipping,
 discountAmount: Math.round((discountAmount + pointsDiscountAmount) * 100) / 100,
 paymentMethod: selectedMethod.id,
 isManualPayment: isManual,
 cardProcessingFee: cardFee.amount,
 cardProcessingFeePercent: cardFee.amount > 0 ? cardFee.percentage : 0,
 paymentId,
 hostedCheckoutUrl,
 };
}

export function sanitizeCustomerInput(customer: CustomerInput) {
 return {
 email: sanitizeText(customer.email).toLowerCase(),
 fullName: sanitizeText(customer.fullName),
 address: sanitizeText(customer.address),
 city: sanitizeText(customer.city),
 state: sanitizeText(customer.state ?? ""),
 postalCode: sanitizeText(customer.postalCode),
 country: sanitizeText(customer.country ?? ""),
 phone: sanitizeText(customer.phone ?? ""),
 };
}
