import { randomUUID } from "crypto";
import { getPaymentProvider } from "@/lib/payment-provider";
import { getCatalogProductsBySlugs } from "@/lib/catalog";
import { calculateDiscountAmount } from "@/lib/referral-service";
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
 status: OrderStatus;
 total: number;
 subtotal: number;
 shipping: number;
 discountAmount: number;
 paymentId: string;
 hostedCheckoutUrl: string;
}

export interface CreateCheckoutPayload {
 items: CartItemInput[];
 customer: CustomerInput;
 referralCode?: string;
 currency?: string;
 expectedTotal?: number;
}

interface ValidatedReferral {
 ambassadorId: string;
 code: string;
 discountPercent: number;
 commissionPercent: number;
 ambassadorName: string;
}

const FREE_SHIPPING_THRESHOLD = 250;
const FLAT_SHIPPING_FEE = 15;

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
 !customer.postalCode
 ) {
 throw new Error("Incomplete customer details");
 }
}

function calculateShipping(subtotal: number) {
 return subtotal >= FREE_SHIPPING_THRESHOLD ? 0 : subtotal > 0 ? FLAT_SHIPPING_FEE : 0;
}

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
 .select("id, name, referral_code, commission_percent, status")
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

 const product: ServerProduct = {
   ...baseProduct,
   id: item.id,
   price: selectedDose
     ? Number((selectedDose.salePrice ?? selectedDose.price).replace(/[^0-9.]/g, ""))
     : baseProduct.price,
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

 const shipping = roundMoney(calculateShipping(subtotal));
 const buy3Get1Discount = calculateBuy3Get1Discount(lineItems);
 const isBuy3Get1Active = buy3Get1Discount > 0;

 if (isBuy3Get1Active && payload.referralCode?.trim()) {
 throw new Error("Referral codes cannot be combined with Buy 3 Get 1 Free. Remove the referral code to continue.");
 }

 const referral = isBuy3Get1Active
   ? null
   : await validateReferralCode(payload.referralCode);

 const discountAmount = roundMoney(
   isBuy3Get1Active
     ? buy3Get1Discount
     : referral
       ? calculateDiscountAmount(subtotal, referral.discountPercent)
       : 0,
 );

 const expectedTotal = roundMoney(
 subtotal + shipping - discountAmount,
 );

 if (
 payload.expectedTotal !== undefined &&
 Math.abs(Number(payload.expectedTotal) - expectedTotal) > 0.01
 ) {
 throw new Error("Altered total detected");
 }

 const orderId = `order-${randomUUID()}`;
 const provider = getPaymentProvider();

 const { error: orderInsertError } = await supabaseAdmin.from("orders").insert({
   order_id: orderId,
   payment_id: null,
   customer_email: payload.customer.email,
   customer_name: payload.customer.fullName,
   shipping_address: payload.customer.address,
   city: payload.customer.city,
   postal_code: payload.customer.postalCode,
   currency: payload.currency ?? "USD",
   subtotal,
   shipping_amount: shipping,
   discount_amount: discountAmount,
   amount_paid: expectedTotal,
   referral_code: referral?.code ?? null,
   ambassador_id: referral?.ambassadorId ?? null,
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

 const checkout = await provider.createCheckoutSession({
 orderId,
 customerEmail: payload.customer.email,
 amount: Math.round(expectedTotal),
 currency: payload.currency ?? "USD",

 metadata: {
 orderId,
 ambassadorId: referral?.ambassadorId ?? "",
 referralCode: referral?.code ?? "",
 promotionApplied: isBuy3Get1Active ? "BUY_3_GET_1" : referral ? "REFERRAL" : "NONE",
 originalSubtotal: subtotal.toFixed(2),
 customerDiscount: discountAmount.toFixed(2),
 amountPaid: expectedTotal.toFixed(2),
 customerEmail: payload.customer.email,
 },
 });

 return {
 orderId,
 status: "pending_payment",
 total: expectedTotal,
 subtotal,
 shipping,
 discountAmount,
 paymentId: checkout.paymentId,
 hostedCheckoutUrl: checkout.hostedCheckoutUrl,
 };
}

export function sanitizeCustomerInput(customer: CustomerInput) {
 return {
 email: sanitizeText(customer.email).toLowerCase(),
 fullName: sanitizeText(customer.fullName),
 address: sanitizeText(customer.address),
 city: sanitizeText(customer.city),
 postalCode: sanitizeText(customer.postalCode),
 };
}