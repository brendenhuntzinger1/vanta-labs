import { randomUUID } from "crypto";
import { getPaymentProvider } from "@/lib/payment-provider";
import { getCatalogProductsBySlugs } from "@/lib/catalog";
import { calculateDiscountAmount } from "@/lib/referral-service";
import { validateCoupon } from "@/lib/coupons";
import { getPointsBalance, isEligibleForBulkSavings, isPriorityMember } from "@/lib/membership";
import { dollarsToPoints, pointsToDollars } from "@/lib/points-math";
import { getAmbassadorProgramSettings } from "@/lib/ambassador-settings";
import { getBundleDiscountedUnitPrice } from "@/lib/bundle-pricing";
import { calculateShipping, calculateHandlingFee, calculateTax } from "@/lib/shipping";
import { calculateBulkSavingsDiscount } from "@/lib/bulk-savings";
import { resolveBestDiscount } from "@/lib/discount-resolution";
import { getHomepageControlConfig, getBulkSavingsControlConfig, getPaymentMethodsConfig, getCardProcessingFeeConfig, getTaxRatePercent } from "@/lib/admin-control";
import { calculateCardProcessingFee, getPaymentMethodById, isManualPaymentMethod } from "@/lib/payment-methods";
import { supabaseAdmin } from "@/lib/supabase-server";

import type {
 CartItemInput,
 CustomerInput,
 OrderStatus,
} from "@/lib/payment-types";

export interface ServerProduct {
 id: string;
 name: string;
 price: number;
 stockStatus: string;
 variantId?: string;
 variantLabel?: string;
 variantSku?: string;
}

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
 paymentMethod?: string;
}

// Short, human-friendly order number a customer can copy into a Cash App /
// Zelle / PayPal note. The internal order_id (a UUID) is unchanged and stays
// the primary key everything else references.
function generateOrderNumber() {
 return `VL-${randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`;
}

interface ValidatedReferral {
 ambassadorId: string;
 code: string;
 discountPercent: number;
 commissionPercent: number;
 ambassadorName: string;
 ambassadorEmail: string | null;
 ambassadorAuthUserId: string | null;
}

function sanitizeText(value: string) {
 return value.replace(/[<>]/g, "").trim();
}

function roundMoney(value: number) {
 return Math.round(value * 100) / 100;
}

function validateCustomer(customer: CustomerInput) {
 if (!customer.email || !customer.email.includes("@")) {
 throw new Error("Invalid email address");
 }

 if (
 !customer.fullName ||
 !customer.address ||
 !customer.city ||
 !customer.postalCode ||
 !customer.country
 ) {
 throw new Error("Incomplete customer details");
 }
}

// Every 4th item (cheapest-first) is free. The caller gates this behind
// getHomepageControlConfig().promoBuy3Get1Enabled - mirrors the client-side
// calculation in cart-context.tsx exactly (including that same gate, fetched
// there via /api/catalog/promotions) so the server total this function feeds
// into always matches what the cart displayed - see the "Altered total
// detected" check below.
function calculateBuy3Get1Discount(lineItems: Array<{ product: ServerProduct; quantity: number }>) {
  const expandedPrices: number[] = [];
  for (const line of lineItems) {
    for (let i = 0; i < line.quantity; i += 1) {
      expandedPrices.push(line.product.price);
    }
  }

  const freeItemCount = Math.floor(expandedPrices.length / 4);
  if (freeItemCount <= 0) {
    return 0;
  }

  expandedPrices.sort((a, b) => a - b);
  return roundMoney(expandedPrices.slice(0, freeItemCount).reduce((sum, price) => sum + price, 0));
}

async function validateReferralCode(
 code?: string,
): Promise<ValidatedReferral | null> {
 const normalizedCode = code?.trim().toUpperCase();

 if (!normalizedCode) {
 return null;
 }

 const { data, error } = await supabaseAdmin
 .from("ambassadors")
 .select("id, name, email, auth_user_id, referral_code, commission_percent, status")
 .eq("referral_code", normalizedCode)
 .maybeSingle();

 if (error) {
 console.error("Referral lookup failed:", error);
 throw new Error("Unable to verify referral code");
 }

 if (!data) {
 throw new Error("Invalid referral code");
 }

 if (data.status !== "approved") {
 throw new Error("That referral code is not active");
 }

 return {
 ambassadorId: data.id,
 code: data.referral_code.toUpperCase(),
 discountPercent: 10,
 commissionPercent: Number(data.commission_percent ?? 15),
 ambassadorName: data.name,
 ambassadorEmail: data.email ?? null,
 ambassadorAuthUserId: data.auth_user_id ?? null,
 };
}

export async function createCheckoutSession(
 payload: CreateCheckoutPayload,
): Promise<PendingOrder> {
 validateCustomer(payload.customer);

 const sanitizedItems = payload.items.map((item) => ({
 id: sanitizeText(item.id),
 quantity: Number(item.quantity),
 }));

 if (sanitizedItems.length === 0) {
 throw new Error("Cart is empty");
 }

 if (
 sanitizedItems.some(
 (item) =>
 !item.id ||
 item.quantity < 1 ||
 !Number.isInteger(item.quantity),
 )
 ) {
 throw new Error("Invalid cart payload");
 }

 const requestedSlugs = Array.from(new Set(sanitizedItems.map((item) => item.id.split("::")[0])));
 const catalogProducts = await getCatalogProductsBySlugs(requestedSlugs);
 const productsById = new Map<string, ServerProduct>(
   catalogProducts.map((product) => [
     product.slug,
     {
       id: product.slug,
       name: product.name,
       price: Number(product.price.replace(/[^0-9.]/g, "")),
       stockStatus: product.stockStatus,
     },
   ]),
 );

 const lineItems = sanitizedItems.map((item) => {
 const [slug, variantId] = item.id.split("::");
 const baseProduct = productsById.get(slug);

 if (!baseProduct) {
 throw new Error(`Invalid product id: ${item.id}`);
 }

 const catalogProduct = catalogProducts.find((product) => product.slug === slug);
 const selectedDose = variantId
   ? catalogProduct?.doses?.find((dose) => dose.id === variantId)
   : catalogProduct?.doses?.find((dose) => dose.isDefault) ?? catalogProduct?.doses?.[0];

 const baseUnitPrice = selectedDose
   ? Number((selectedDose.salePrice ?? selectedDose.price).replace(/[^0-9.]/g, ""))
   : baseProduct.price;

 // "Bundle & Save" (2 vials = 5% off, 3+ = 8% off) is applied here, at the
 // authoritative price the server charges, so it's correct no matter what
 // the client displayed - see getBundleDiscountedUnitPrice's callers in
 // cart-context.tsx and product-detail-client.tsx for the matching client
 // preview using the exact same shared formula.
 const product: ServerProduct = {
   ...baseProduct,
   id: item.id,
   price: getBundleDiscountedUnitPrice(baseUnitPrice, item.quantity),
   stockStatus: selectedDose?.stockStatus ?? baseProduct.stockStatus,
   variantId: selectedDose?.id,
   variantLabel: selectedDose?.label,
   variantSku: selectedDose?.sku,
 };

 if (product.stockStatus === "Reserved") {
 throw new Error(`Product is unavailable: ${product.name}`);
 }

 if (product.stockStatus === "Out of Stock") {
 throw new Error(`Product is out of stock: ${product.name}`);
 }

 return {
 product,
 quantity: item.quantity,
 };
 });

 const subtotal = roundMoney(
 lineItems.reduce(
 (sum, line) => sum + line.product.price * line.quantity,
 0,
 ),
 );

 const handlingFee = calculateHandlingFee(subtotal);
 const [{ promoBuy3Get1Enabled }, bulkSavingsConfig, bulkSavingsEligible, isPriorityOrder, taxRatePercent] = await Promise.all([
   getHomepageControlConfig(),
   getBulkSavingsControlConfig(),
   payload.customerUserId ? isEligibleForBulkSavings(payload.customerUserId) : Promise.resolve(false),
   payload.customerUserId ? isPriorityMember(payload.customerUserId) : Promise.resolve(false),
   getTaxRatePercent(),
 ]);
 const bulkSavingsResult = calculateBulkSavingsDiscount(subtotal, bulkSavingsEligible, bulkSavingsConfig);
 // Free shipping is a distinct perk of reaching the bulk-savings threshold,
 // not conditioned on bulk savings winning the "greatest discount" contest
 // below - see membership-billing.sql / bulk-savings.ts.
 const shipping = bulkSavingsResult.tier
   ? 0
   : roundMoney(calculateShipping(subtotal, payload.customer.country));
 const buy3Get1Discount = promoBuy3Get1Enabled ? calculateBuy3Get1Discount(lineItems) : 0;
 const isBuy3Get1Active = buy3Get1Discount > 0;

 if (isBuy3Get1Active && payload.referralCode?.trim()) {
 throw new Error("Referral codes cannot be combined with Buy 3 Get 1 Free. Remove the referral code to continue.");
 }

 if (isBuy3Get1Active && payload.couponCode?.trim()) {
 throw new Error("Coupon codes cannot be combined with Buy 3 Get 1 Free. Remove the coupon code to continue.");
 }

 const referral = isBuy3Get1Active
   ? null
   : await validateReferralCode(payload.referralCode);

 if (referral && payload.couponCode?.trim()) {
 throw new Error("Coupon codes cannot be combined with a referral code. Remove one to continue.");
 }

 if (referral) {
 const ambassadorSettings = await getAmbassadorProgramSettings();
 if (subtotal < ambassadorSettings.minimumQualifyingOrder) {
 throw new Error(`This referral code requires a minimum merchandise subtotal of $${ambassadorSettings.minimumQualifyingOrder.toFixed(2)}. Add more items or remove the referral code to continue.`);
 }

 const customerEmail = payload.customer.email.trim().toLowerCase();
 const isSelfReferralByEmail = Boolean(referral.ambassadorEmail) && referral.ambassadorEmail!.trim().toLowerCase() === customerEmail;
 const isSelfReferralByAccount = Boolean(referral.ambassadorAuthUserId) && Boolean(payload.customerUserId) && referral.ambassadorAuthUserId === payload.customerUserId;

 if (isSelfReferralByEmail || isSelfReferralByAccount) {
 throw new Error("You can't use your own referral code on your own order.");
 }
 }

 const coupon = isBuy3Get1Active || referral
   ? null
   : await validateCoupon(payload.couponCode, subtotal, payload.customer.email);

 const preBulkDiscount = isBuy3Get1Active
   ? { type: "buy3get1" as const, amount: buy3Get1Discount }
   : referral
     ? { type: "referral" as const, amount: calculateDiscountAmount(subtotal, referral.discountPercent) }
     : { type: "coupon" as const, amount: coupon ? coupon.discountAmount : 0 };

 // "Cannot stack, greatest savings wins" - mirrors cart-context.tsx exactly
 // (same shared src/lib/discount-resolution.ts function) so the client
 // preview and this server total always agree on which discount applies.
 const bestDiscount = resolveBestDiscount([
   { type: "bulk_savings", amount: bulkSavingsResult.amount },
   preBulkDiscount,
 ]);

 const discountAmount = roundMoney(bestDiscount?.amount ?? 0);
 const bulkDiscountTier = bestDiscount?.type === "bulk_savings" ? bulkSavingsResult.tier : null;

 // Sales tax on the post-discount merchandise total (0 unless an admin sets a
 // rate). Same shared calculateTax the client preview uses, so totals agree.
 const taxAmount = calculateTax(Math.max(0, roundMoney(subtotal - discountAmount)), taxRatePercent);

 const totalBeforePoints = roundMoney(subtotal + shipping + handlingFee + taxAmount - discountAmount);

 // Points redemption stacks with a coupon or Buy 3 Get 1 Free (it behaves
 // like store credit, not a promo code) but never with a referral code -
 // referral codes are exclusive of every other discount, so redemption is
 // silently zeroed rather than erroring (points aren't something a shopper
 // deliberately "combines"; the balance is just sitting on their account).
 // Also capped to the remaining balance due and the customer's actual point
 // balance.
 let pointsRedeemed = 0;
 let pointsDiscountAmount = 0;
 if (!referral && payload.customerUserId && payload.pointsToRedeem && payload.pointsToRedeem > 0) {
 const balance = await getPointsBalance(payload.customerUserId);
 const requestedPoints = Math.min(Math.floor(payload.pointsToRedeem), balance);
 const requestedDollars = pointsToDollars(requestedPoints);
 pointsDiscountAmount = roundMoney(Math.min(requestedDollars, totalBeforePoints));
 pointsRedeemed = dollarsToPoints(pointsDiscountAmount);
 }

 const expectedTotal = roundMoney(Math.max(0, totalBeforePoints - pointsDiscountAmount));

 if (
 payload.expectedTotal !== undefined &&
 Math.abs(Number(payload.expectedTotal) - expectedTotal) > 0.01
 ) {
 throw new Error("Altered total detected");
 }

 // Resolve the chosen payment method and, for card orders only, add the
 // configurable card processing fee on top of expectedTotal. Manual methods
 // (Cash App / Zelle / PayPal) carry no fee. Both the fee config and the
 // method list come from the server so the client can never spoof a lower
 // fee - the client only previews the same shared calculation.
 const [paymentMethods, cardFeeConfig] = await Promise.all([
   getPaymentMethodsConfig(),
   getCardProcessingFeeConfig(),
 ]);
 const selectedMethodId = payload.paymentMethod?.trim() || "card";
 const selectedMethod = getPaymentMethodById(paymentMethods, selectedMethodId);

 if (!selectedMethod || !selectedMethod.enabled) {
   throw new Error("Unavailable payment method");
 }

 const isManual = isManualPaymentMethod(selectedMethod);
 const cardFee = isManual
   ? { amount: 0, percentage: 0 }
   : calculateCardProcessingFee(expectedTotal, cardFeeConfig);
 const finalTotal = roundMoney(expectedTotal + cardFee.amount);

 const orderId = `order-${randomUUID()}`;
 const orderNumber = generateOrderNumber();
 const provider = getPaymentProvider();

 const { error: orderInsertError } = await supabaseAdmin.from("orders").insert({
   order_id: orderId,
   order_number: orderNumber,
   payment_id: null,
   payment_method: selectedMethod.id,
   card_processing_fee: cardFee.amount,
   card_processing_fee_percent: cardFee.amount > 0 ? cardFee.percentage : 0,
   customer_email: payload.customer.email,
   customer_name: payload.customer.fullName,
   shipping_address: payload.customer.address,
   city: payload.customer.city,
   postal_code: payload.customer.postalCode,
   country: payload.customer.country,
   currency: payload.currency ?? "USD",
   subtotal,
   shipping_amount: shipping,
   handling_fee: handlingFee,
   tax_amount: taxAmount,
   discount_amount: discountAmount,
   bulk_discount_tier: bulkDiscountTier,
   bulk_discount_amount: bulkDiscountTier ? discountAmount : 0,
   priority: isPriorityOrder,
   amount_paid: finalTotal,
   referral_code: referral?.code ?? null,
   ambassador_id: referral?.ambassadorId ?? null,
   coupon_code: coupon?.code ?? null,
   customer_user_id: payload.customerUserId ?? null,
   points_redeemed: pointsRedeemed,
   payment_status: "pending_payment",
   fulfillment_status: "pending",
   created_at: new Date().toISOString(),
   updated_at: new Date().toISOString(),
 });

 if (orderInsertError) {
   console.error("Unable to create order record", orderInsertError);
   throw new Error("Unable to create order record");
 }

 const orderItemsPayload = lineItems.map((line) => ({
   order_id: orderId,
   product_id: line.product.id,
   product_name: line.product.variantLabel ? `${line.product.name} (${line.product.variantLabel})` : line.product.name,
   unit_price: line.product.price,
   quantity: line.quantity,
   line_total: roundMoney(line.product.price * line.quantity),
 }));

 const { error: itemInsertError } = await supabaseAdmin.from("order_items").insert(orderItemsPayload);
 if (itemInsertError) {
   console.error("Unable to create order items", itemInsertError);
   throw new Error("Unable to create order items");
 }

 // Manual methods (Cash App / Zelle / PayPal) are settled off-platform: the
 // customer follows on-page instructions and submits a transaction id, so
 // there's no hosted processor session. Only the card method uses the
 // payment provider (its existing hosted-checkout flow, unchanged).
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
   couponCode: coupon?.code ?? "",
   promotionApplied: bulkDiscountTier
     ? "BULK_SAVINGS"
     : isBuy3Get1Active
       ? "BUY_3_GET_1"
       : referral
         ? "REFERRAL"
         : coupon
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
 discountAmount: roundMoney(discountAmount + pointsDiscountAmount),
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
 postalCode: sanitizeText(customer.postalCode),
 country: sanitizeText(customer.country ?? ""),
 };
}