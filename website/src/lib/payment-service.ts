import { randomUUID } from "crypto";
import { getPaymentProvider } from "@/lib/payment-provider";
import { reserveInventoryForOrder, releaseInventoryForOrder, describeUnavailable, DEFAULT_RESERVATION_MINUTES, MANUAL_RESERVATION_MINUTES } from "@/lib/inventory-reservation";
import { describeTenderShortfall, releaseOrderTender, reserveOrderTender } from "@/lib/tender-reservation";
import { getPaymentMethodById, isManualPaymentMethod } from "@/lib/payment-methods";
import {
  buildOrderRow,
  insertOrderItems,
  insertOrderRow,
  quoteOrder,
  sanitizeText,
  type ServerProduct,
} from "@/lib/quote-order";
import { releaseCustomerOffer, reserveCustomerOffer } from "@/lib/offers/customer-offers";
import {
  CLAIM_HOLD_SECONDS,
  MANUAL_CLAIM_HOLD_SECONDS,
  claimPromotionRedemption,
  releasePromotionRedemption,
} from "@/lib/bxgy-promotions";
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
 /**
  * The one-time offer token from the link in a win-back email.
  *
  * Opaque all the way through: nothing between the browser and
  * customer_offers interprets it, and nothing the client sends can name the
  * free product, its quantity or its price. See quoteOrder.
  */
 offerToken?: string;
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

/**
 * Hand a dead checkout's promotion slot and gift token straight back.
 *
 * Both holds would age out on their own, but the shopper is being told "no
 * order was placed" right now and may retry at once — a slot or token still
 * held by the order that just died is what makes that retry fail. Best effort
 * on both counts: each release refuses to touch an already-redeemed claim.
 */
async function releaseAbandonedCheckoutClaims(
  orderId: string,
  quote: { appliedPromotionId?: string | null; appliedPromotionLimits?: unknown; appliedOffer?: unknown },
) {
  if (quote.appliedPromotionId && quote.appliedPromotionLimits) {
    await releasePromotionRedemption(orderId).catch((error: unknown) => {
      console.error("Unable to release promotion claim for an abandoned checkout", orderId, error);
    });
  }
  if (quote.appliedOffer) {
    await releaseCustomerOffer(orderId).catch((error: unknown) => {
      console.error("Unable to release customer offer for an abandoned checkout", orderId, error);
    });
  }
}

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
   offerToken: payload.offerToken,
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
   appliedPromotionName,
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
       let existingPaymentId = existing.payment_id ? String(existing.payment_id) : "";
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

           // THE RESUMED SESSION IS THE ONE THAT WILL BE PAID — record it.
           //
           // This branch mints a NEW processor session so the shopper gets a
           // working card iframe, but only its URL was kept: the order row went
           // on pointing at the ABANDONED session from the first attempt.
           //
           // With a stale id on the row, reconcileVeyraPendingPayments polls the
           // wrong session. The old one reports `expired`, which is a member of
           // DEAD_SESSION_STATUSES, so a genuinely paid order would be marked
           // payment_failed and its stock released — worse than the stranded
           // order the reconciler exists to rescue. Reachable whenever the first
           // response is lost in transit after the server committed, which is
           // precisely what the idempotency key is for.
           if (resumed.paymentId && resumed.paymentId !== existingPaymentId) {
             existingPaymentId = resumed.paymentId;
             const { error: resumeIdError } = await supabaseAdmin
               .from("orders")
               .update({ payment_id: resumed.paymentId, updated_at: new Date().toISOString() })
               // Never move the pointer on an order that has already settled:
               // its payment_id is the session that actually paid.
               .eq("order_id", String(existing.order_id))
               .neq("payment_status", "paid");
             if (resumeIdError) {
               console.error("Unable to persist resumed payment session id for order", existing.order_id, resumeIdError);
             }
           }
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
         // The resumed session when one was minted above, otherwise whatever the
         // order already carried. Returning the superseded id here would report a
         // session the shopper is not being sent to.
         paymentId: existingPaymentId || String(existing.order_id),
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
   // Straight from the quote that produced `finalTotal`, so the stored fee and
   // the charged total can never disagree.
   shippingProtectionFee: quote.shippingProtectionFee,
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
   // The Buy X Get Y promotion this order redeemed, if any. Usage limits are
   // counted from it, so it has to be written on the order that used it.
   promotionId: quote.appliedPromotionId,
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

 // CLAIM THE REDEMPTION BEFORE THE ORDER EXISTS.
 //
 // Counting redemptions and then writing the order is a race — two shoppers
 // reaching the last one together both read "one left". bxgy_claim_redemption
 // does the count and the reservation under one lock, so the second is refused.
 // It runs BEFORE the insert so a refusal costs no order row and no orphan.
 //
 // Only promotions that carry a limit are claimed; an unlimited one needs no
 // slot and never touches this path.
 if (quote.appliedPromotionId && quote.appliedPromotionLimits) {
   const claimed = await claimPromotionRedemption({
     promotionId: quote.appliedPromotionId,
     orderId,
     customerEmail: payload.customer.email,
     maxRedemptions: quote.appliedPromotionLimits.maxRedemptions,
     perCustomerLimit: quote.appliedPromotionLimits.perCustomerLimit,
     // The promotion slot is held exactly as long as the stock for the same
     // order, so the two can never expire out of step.
     holdSeconds: isManual ? MANUAL_CLAIM_HOLD_SECONDS : CLAIM_HOLD_SECONDS,
   });
   if (!claimed) {
     // The same sentence the altered-total guard uses, because it is the same
     // situation from the shopper's side: the price they were quoted is no
     // longer available and the page needs to re-price.
     throw new Error(
       "A discount on your order is no longer available, so your total has been updated. "
       + "Please refresh this page to see the current total, then place your order.",
     );
   }
 }

 // RESERVE THE ONE-TIME OFFER BEFORE THE ORDER EXISTS, for exactly the
 // reason the promotion claim above does — and with one difference that
 // matters more here.
 //
 // quoteOrder has already put a $0 line in this order. It did that from an
 // ADVISORY read that took no lock, so two checkouts holding the same token
 // can both have been priced a free vial. This is the only place that can be
 // resolved, and a failure here must REFUSE THE ORDER: letting it through
 // would ship a free unit without consuming the offer, and the customer could
 // do it again tomorrow.
 //
 // The reserve also re-checks expiry, revocation, prior redemption and the
 // email binding under its lock, so a token that went stale between the quote
 // and the order is caught here rather than honoured.
 if (quote.appliedOffer) {
   const reserved = await reserveCustomerOffer({
     token: quote.appliedOffer.token,
     orderId,
     email: payload.customer.email,
     // Held exactly as long as the stock and the promotion slot for this
     // order, so a pending manual payment cannot lose its gift to a second
     // checkout by the same customer.
     holdSeconds: isManual ? MANUAL_CLAIM_HOLD_SECONDS : CLAIM_HOLD_SECONDS,
   });
   if (!reserved) {
     // PRICE-03. The promotion slot claimed a few lines up belongs to an order
     // that will now never exist. Left held, bxgy_count_redemptions counts it
     // as live for the hold window — 15 minutes on card, 24 hours on a manual
     // method — so the retry this message tells the shopper to make finds the
     // promotion "exhausted" for them. Hand it straight back, as the
     // insert-failure branch below already does. Best effort: the hold would
     // release on its own anyway.
     if (quote.appliedPromotionId && quote.appliedPromotionLimits) {
       await releasePromotionRedemption(orderId);
     }
     throw new Error(
       "Your free gift is no longer available, so your total has been updated. "
       + "Please refresh this page to see the current total, then place your order.",
     );
   }
 }

 const insertOutcome = await insertOrderRow(orderRow);
 if (insertOutcome.status === "duplicate") {
   const dup = await returnExistingByIdempotency();
   if (dup) return dup;
 }
 if (insertOutcome.status !== "inserted") {
   console.error("Unable to create order record", insertOutcome.status === "error" ? insertOutcome.error : "duplicate");
   // Hand the redemption straight back rather than leaving it held until the
   // hold expires. Best effort — the hold would release on its own anyway.
   if (quote.appliedPromotionId && quote.appliedPromotionLimits) {
     await releasePromotionRedemption(orderId);
   }
   // Same courtesy for the offer: the hold would age out on its own, but an
   // order that was never written should not cost the customer half an hour
   // of their gift. Refuses to touch an offer that is already redeemed.
   if (quote.appliedOffer) {
     await releaseCustomerOffer(orderId);
   }
   throw new Error("Unable to create order record");
 }

 const { payload: orderItemsPayload, error: itemInsertError } = await insertOrderItems(
   orderId,
   lineItems,
   unitCostCentsForLine,
 );
 if (itemInsertError) {
   console.error("Unable to create order items", itemInsertError);
   // The order row exists but nothing else does, and the customer is about to
   // be told no order was placed. Cancel it and hand back the promotion slot
   // and the gift, exactly as the branches below do — a pending order with no
   // items was visible in admin, and a held BXGY slot / offer token stayed
   // unavailable to the shopper's retry for the rest of the hold window.
   await releaseAbandonedCheckoutClaims(orderId, quote);
   await supabaseAdmin
     .from("orders")
     .update({ payment_status: "canceled", updated_at: new Date().toISOString() })
     .eq("order_id", orderId);
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
   await releaseAbandonedCheckoutClaims(orderId, quote);
   await supabaseAdmin
     .from("orders")
     .update({ payment_status: "canceled", updated_at: new Date().toISOString() })
     .eq("order_id", orderId);
   // Name the item and the number left. "Something sold out" makes the customer
   // guess which line and by how much, which is how a fixable cart becomes an
   // abandoned one.
   throw new Error(describeUnavailable(reservation.unavailable));
 }

 // Hold the non-cash tender the same way, and for the same reason. The quote
 // above READ the store-credit and points balances; nothing claimed them, so
 // until this call the same $50 of credit could fund every checkout the shopper
 // could open at once — each order written with $50 off, each card charged the
 // reduced amount, and the ledger debiting it once at settlement because
 // redeemStoreCredit clamps to the live balance. The balance never went
 // negative; the store just gave the discount away as many times as it was
 // asked (VL-11).
 //
 // Unlike stock this does NOT fail open: a hold that could not be taken means
 // the balance is not there, and charging a total priced with money the shopper
 // does not have is the exact loss being prevented. Cancel and let them refresh.
 //
 // A FAILED hold is treated exactly like a refused one, for the reason G-03
 // exists (checkout-session-failure-cleanup.test.ts): whatever ends this
 // checkout, the customer is told no order was placed, so no order — and no
 // stock hold — may be left behind to contradict that.
 const abandonUnpaidOrder = async () => {
   await releaseInventoryForOrder(orderId).catch((releaseError: unknown) => {
     console.error("Unable to release inventory after a refused tender hold", orderId, releaseError);
   });
   await releaseOrderTender(orderId).catch((releaseError: unknown) => {
     console.error("Unable to release held tender after a refused tender hold", orderId, releaseError);
   });
   const { error: cancelError } = await supabaseAdmin
     .from("orders")
     .update({ payment_status: "canceled", updated_at: new Date().toISOString() })
     .eq("order_id", orderId);
   if (cancelError) {
     console.error("Unable to cancel order after a refused tender hold", orderId, cancelError);
   }
 };

 let tender: Awaited<ReturnType<typeof reserveOrderTender>>;
 try {
   tender = await reserveOrderTender({
     orderId,
     userId: payload.customerUserId ?? null,
     storeCreditCents: storeCreditRedeemedCents,
     pointsRedeemed,
   });
 } catch (holdError) {
   await abandonUnpaidOrder();
   throw holdError;
 }
 if (!tender.ok) {
   await abandonUnpaidOrder();
   throw new Error(describeTenderShortfall(tender.shortOf));
 }

 // Manual methods (settled off-platform) have no hosted processor session: the
 // customer follows on-page instructions and submits a transaction id. Only the
 // card method uses the payment provider (its existing hosted-checkout flow,
 // unchanged).
 let paymentId = orderId;
 let hostedCheckoutUrl = "";

 if (!isManual) {
   // The order row, its items and a live stock hold all exist by now. If the
   // processor call fails, every one of them has to be undone — otherwise the
   // customer is told "no order was placed" (route.ts's catch) while a
   // pending_payment row sits in the table holding their units for the full
   // reservation window. Worse, that route invites them to "try again in a
   // moment", and each retry takes another hold: a processor outage then drains
   // sellable stock at exactly the rate customers retry it.
   //
   // Same treatment the reservation-shortfall branch above already gives:
   // cancel the order, release the hold, then rethrow so the customer still
   // sees a failed checkout. Cleanup never swallows the original error — the
   // processor's failure is the one worth diagnosing.
   let checkout: { paymentId: string; hostedCheckoutUrl: string };
   try {
     checkout = await provider.createCheckoutSession({
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
       ? (appliedPromotionName ?? "PROMOTION")
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
   } catch (error) {
     await releaseInventoryForOrder(orderId).catch((releaseError: unknown) => {
       console.error("Unable to release inventory for failed checkout session", orderId, releaseError);
     });
     // The credit and points held moments ago belong to a checkout that will
     // never be paid. Hand them straight back rather than leaving the shopper
     // unable to spend their own balance until the sweep notices.
     await releaseOrderTender(orderId).catch((releaseError: unknown) => {
       console.error("Unable to release held tender for failed checkout session", orderId, releaseError);
     });
     const { error: cancelError } = await supabaseAdmin
       .from("orders")
       .update({ payment_status: "canceled", updated_at: new Date().toISOString() })
       .eq("order_id", orderId);
     if (cancelError) {
       console.error("Unable to cancel order after failed checkout session", orderId, cancelError);
     }
     throw error;
   }

   paymentId = checkout.paymentId;
   hostedCheckoutUrl = checkout.hostedCheckoutUrl;

   // PERSIST THE SESSION ID ON THE ORDER, not just in the response.
   //
   // Until now this id lived only in the returned object: the order row was
   // inserted with payment_id null and nothing wrote it back, so 639 of 991
   // card orders in the fixture carry a null payment_id. That leaves a card
   // order with no way to be recovered if its webhook never arrives —
   // reconcileVeyraPendingPayments (express-reconcile.ts) selects
   // `.not("payment_id", "is", null)`, so those rows are invisible to it. Its
   // own header names the consequence it exists to prevent: "money moved,
   // order reads unpaid, stock released at reservation expiry" — and the card
   // lane was outside its reach.
   //
   // Writing the id here also gives the webhook its documented fallback route
   // to the order (findOrderIdByPaymentId, "if we wrote one") when provider
   // metadata is missing.
   //
   // Best-effort by design: the customer is about to be sent to the processor
   // and a bookkeeping write must never block, or undo, a checkout that has
   // already succeeded. A failure here leaves exactly today's behaviour.
   const { error: paymentIdError } = await supabaseAdmin
     .from("orders")
     .update({ payment_id: paymentId, updated_at: new Date().toISOString() })
     .eq("order_id", orderId);
   if (paymentIdError) {
     console.error("Unable to persist payment session id for order", orderId, paymentIdError);
   }
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
 address2: sanitizeText(customer.address2 ?? ""),
 city: sanitizeText(customer.city),
 state: sanitizeText(customer.state ?? ""),
 postalCode: sanitizeText(customer.postalCode),
 country: sanitizeText(customer.country ?? ""),
 phone: sanitizeText(customer.phone ?? ""),
 };
}
