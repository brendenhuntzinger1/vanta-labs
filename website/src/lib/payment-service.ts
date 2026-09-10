import { createHash } from "node:crypto";
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
import { CustomerFacingError } from "@/lib/safe-error";
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
 // ONE PLACE THAT RESUMES AN ORDER THAT ALREADY EXISTS.
 //
 // Two paths reach "this submit already has an order": the lookup below, before
 // the insert, and returnExistingByIdempotency after a unique-index collision.
 // They used to answer differently — the first minted a fresh processor session
 // and returned a working card URL, the second returned `hostedCheckoutUrl: ""`
 // — so which one a shopper hit decided whether they could pay. An empty URL is
 // read by the checkout page as "we couldn't reach the payment provider", so
 // the second path was a dead end wearing a success response.
 //
 // Both call this now, so a resumed order always comes back with a session the
 // shopper can actually use.
 type ExistingOrderRow = {
   order_id: unknown;
   order_number: unknown;
   payment_id: unknown;
   payment_method: unknown;
   amount_paid: unknown;
   card_processing_fee: unknown;
   card_processing_fee_percent: unknown;
   payment_status: unknown;
 };
 const resumeExistingOrder = async (existing: ExistingOrderRow) => {
   const existingIsManual = isManualPaymentMethod(getPaymentMethodById(paymentMethods, String(existing.payment_method ?? "")));
   let existingHostedUrl = "";
   let existingPaymentId = existing.payment_id ? String(existing.payment_id) : "";
   // AN ALREADY-PAID ORDER MUST NEVER BE HANDED A FRESH CARD FORM.
   //
   // The lookup below excluded only canceled/cancelled/payment_failed, so a
   // PAID order matching this idempotency key reached here — and this block then
   // minted a brand-new, chargeable processor session for it and returned
   // status "pending_payment" with a live hosted URL. The shopper is sent to a
   // card form for an order that is already settled; paying it charges them a
   // second time for one purchase. The `.neq("payment_status","paid")` below
   // protects the stored pointer but not the minting, which is the part that
   // takes the money.
   //
   // The honest answer is the receipt. Returning no URL is not an option: the
   // checkout page reads an empty url as "we couldn't reach the payment
   // provider, so your card was not charged" — false, and it invites a retry.
   const CAPTURED = new Set(["paid", "partially_refunded", "refunded"]);
   const existingStatus = String(existing.payment_status ?? "").toLowerCase();
   if (CAPTURED.has(existingStatus)) {
     return {
       orderId: String(existing.order_id),
       orderNumber: String(existing.order_number),
       status: "paid" as const,
       alreadyPaid: true,
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
   }

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
       // This mints a NEW processor session so the shopper gets a working card
       // iframe. Keeping only its URL left the order row pointing at the
       // ABANDONED session from the first attempt, and with a stale id
       // reconcileVeyraPendingPayments polls the wrong session: the old one
       // reports `expired`, a member of DEAD_SESSION_STATUSES, so a genuinely
       // paid order would be marked payment_failed and its stock released —
       // worse than the stranded order the reconciler exists to rescue.
       if (resumed.paymentId && resumed.paymentId !== existingPaymentId) {
         existingPaymentId = resumed.paymentId;
         const { error: resumeIdError } = await supabaseAdmin
           .from("orders")
           .update({ payment_id: resumed.paymentId, updated_at: new Date().toISOString() })
           // Never move the pointer on an order that has already settled: its
           // payment_id is the session that actually paid.
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
     status: "pending_payment" as const,
     total: Number(existing.amount_paid ?? finalTotal),
     subtotal,
     shipping,
     discountAmount,
     paymentMethod: String(existing.payment_method ?? selectedMethod.id),
     isManualPayment: existingIsManual,
     cardProcessingFee: Number(existing.card_processing_fee ?? 0),
     cardProcessingFeePercent: Number(existing.card_processing_fee_percent ?? 0),
     // The resumed session when one was minted above, otherwise whatever the
     // order already carried. Returning the superseded id would report a session
     // the shopper is not being sent to.
     paymentId: existingPaymentId || String(existing.order_id),
     hostedCheckoutUrl: existingHostedUrl,
   };
 };

 if (idempotencyKey) {
   try {
     const { data: existing } = await supabaseAdmin
       .from("orders")
       .select("order_id, order_number, payment_id, payment_method, amount_paid, card_processing_fee, card_processing_fee_percent, payment_status")
       .eq("idempotency_key", idempotencyKey)
       .not("payment_status", "in", "(canceled,cancelled,payment_failed)")
       .maybeSingle();
     if (existing) {
       return await resumeExistingOrder(existing);
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
   // Internal only — insertOrderRow turns this into the owner's
   // below-floor notice and never writes it to a column.
   profitFloor: quote.profitFloor,
 });

 // A unique-index violation on idempotency_key means a truly-simultaneous
 // duplicate submit beat us to the insert — return that order rather than
 // erroring, so the user's retry lands on their real (single) order.
 // THE SAME FILTER THE PRE-INSERT LOOKUP USES, AND IT HAS TO BE THE SAME.
 //
 // This read had no status filter while the one at the top of the function
 // deliberately skips canceled/failed orders, and the two disagreeing is the
 // whole bug. The unique index on idempotency_key covers EVERY row, dead ones
 // included, so a retry after a cancelled first attempt found nothing at the
 // top, proceeded, and collided on the insert — landing here, which handed the
 // DEAD order back as `status: "pending_payment"` with `hostedCheckoutUrl: ""`.
 //
 // Reproduced against the harness: first attempt creates an order; the order is
 // cancelled (exactly what payment-service does when the provider throws); the
 // retry answers 200 success:true with the same order id and an empty URL. The
 // checkout page reads an empty URL as "we couldn't reach the payment
 // provider… please try again", KEEPING the same key on purpose so a retry can
 // resume — so every further click reproduces it identically and the shopper
 // cannot reach a card form again without a full page reload.
 //
 // Resurrecting a dead order is never the right answer, so this now looks only
 // for a LIVE one. When the key is held solely by a dead row the caller retries
 // under a derived key instead — see the duplicate branch below.
 const DEAD_ORDER_STATUSES = "(canceled,cancelled,payment_failed)";
 const returnExistingByIdempotency = async (key: string | null = idempotencyKey) => {
   if (!key) return null;
   const { data: existing } = await supabaseAdmin
     .from("orders")
     .select("order_id, order_number, payment_id, payment_method, amount_paid, card_processing_fee, card_processing_fee_percent, payment_status")
     .eq("idempotency_key", key)
     .not("payment_status", "in", DEAD_ORDER_STATUSES)
     .maybeSingle();
   if (!existing) return null;
   // Resumed through the shared helper, so this path hands back a card session
   // the shopper can use instead of an empty URL the page reads as an outage.
   return resumeExistingOrder(existing);
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

 let insertOutcome = await insertOrderRow(orderRow);
 if (insertOutcome.status === "duplicate") {
   const dup = await returnExistingByIdempotency();
   if (dup) {
     // A LIVE order already holds this key, so this really is a duplicate
     // submit and that order is the answer. Hand back what THIS attempt
     // claimed under its own (now phantom) order id first — the live order
     // holds its own claims, and leaving these held would spend a limited
     // promotion slot and a one-time gift on an order that will never exist.
     // Best-effort: both age out on their own, and neither may delay the
     // shopper's answer.
     if (quote.appliedPromotionId && quote.appliedPromotionLimits) {
       await releasePromotionRedemption(orderId).catch(() => {});
     }
     if (quote.appliedOffer) {
       await releaseCustomerOffer(orderId).catch(() => {});
     }
     return dup;
   }

   // THE KEY IS HELD ONLY BY A DEAD ORDER. GIVE THE SHOPPER A NEW ONE.
   //
   // This is the case the pre-insert lookup was reaching for when it skipped
   // canceled and failed rows: a first attempt that died deserves a real second
   // attempt. The unique index does not share that view, so the retry has to
   // arrive under a different key.
   //
   // Derived from the DEAD order's id rather than randomly, so it is stable:
   // a shopper double-clicking the retry produces the same derived key twice,
   // the second collides, and by then the row holding it is LIVE — so the
   // filtered read above returns it and the second click is idempotent, exactly
   // as the first submit is. Hashed so the column never sees an unbounded
   // concatenation.
   //
   // AND IT CHAINS, because one dead attempt is not the only number there is.
   //
   // Derived from the FIRST dead order alone the derived key was a CONSTANT:
   // once a second attempt also died, that key was held by a dead row too, the
   // live-only read above filtered it out, and there was no third key. Every
   // click after that threw "Unable to create order record" — and the checkout
   // page keeps the same idempotency key across failures on purpose, so only a
   // full page reload escaped it. Two dead attempts is an ordinary evening: two
   // thin stock lines removed one at a time, a tender shortfall then a fixed
   // basket, or a two-minute processor outage spanning two clicks. So the
   // derivation walks — each dead row in the chain derives the next key from
   // itself — and attempt N lands on a key nothing holds.
   const MAX_DEAD_ATTEMPT_HOPS = 12;
   let chainKey: string | null = idempotencyKey;
   for (let hop = 0; hop < MAX_DEAD_ATTEMPT_HOPS && chainKey; hop += 1) {
     const holder: { order_id?: unknown } | null = (await supabaseAdmin
       .from("orders")
       .select("order_id")
       .eq("idempotency_key", chainKey)
       .maybeSingle()).data;
     // Nothing holds it any more — the row was deleted between the collision
     // and this read. Retrying the plain insert is the whole answer.
     if (!holder?.order_id) break;

     const derivedKey = `r_${createHash("sha256")
       .update(`${chainKey}|${String(holder.order_id)}`)
       .digest("hex")
       .slice(0, 48)}`;
     orderRow.full.idempotency_key = derivedKey;
     insertOutcome = await insertOrderRow(orderRow);
     if (insertOutcome.status !== "duplicate") break;

     // The retry itself is being repeated — the shopper clicked twice, or the
     // first retry's response was lost. The derived key is stable, so the row
     // holding it may be the LIVE order the previous retry created, and handing
     // that back is precisely the idempotent answer. Release what this attempt
     // claimed under its own phantom order id first, as above.
     const retried = await returnExistingByIdempotency(derivedKey);
     if (retried) {
       if (quote.appliedPromotionId && quote.appliedPromotionLimits) {
         await releasePromotionRedemption(orderId).catch(() => {});
       }
       if (quote.appliedOffer) {
         await releaseCustomerOffer(orderId).catch(() => {});
       }
       return retried;
     }

     // Held by a DEAD row as well, so this attempt is no better off than the
     // last. Hop: the next key derives from the row that just refused us.
     chainKey = derivedKey;
   }

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
   // A DEAD END DESERVES A WAY OUT. This string reaches the shopper verbatim
   // (safe-error.ts passes it: no vendor token, no technical pattern, short),
   // and "Unable to create order record" told them nothing they could act on
   // while the page held the same idempotency key across every further click.
   throw new Error(
     insertOutcome.status === "duplicate"
       ? "We could not start a new payment for this basket. Please refresh this page and place your order again."
       : "Unable to create order record",
   );
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
   //
   // THROWN AS A CustomerFacingError, NOT A PLAIN Error, and that is not
   // decoration. safe-error.ts rejects any message over 200 characters as a
   // probable stack dump, and the held-stock wording — which has to name the
   // item AND explain that the shopper's own unfinished payment is holding it —
   // runs past that. A plain Error was therefore replaced, silently, by "We
   // couldn't start checkout just now", which is the generic message this whole
   // line exists to avoid. Reproduced against the harness: the fix landed, the
   // shopper still saw the fallback. The class is the documented way to say
   // "this text was written for the person reading it".
   throw new CustomerFacingError(describeUnavailable(reservation.unavailable));
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
