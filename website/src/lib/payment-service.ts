import { randomUUID } from "crypto";
import { getPaymentProvider } from "@/lib/payment-provider";
import { products } from "@/lib/demo-data";
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
}

const productsById = new Map<string, ServerProduct>(
 products.map((product) => [
 product.slug,
 {
 id: product.slug,
 name: product.name,
 price: Number(product.price.replace(/[^0-9.]/g, "")),
 stockStatus: product.stockStatus,
 },
 ]),
);

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
 return subtotal > 0 ? 24 : 0;
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
 .select("id, referral_code, status")
 .ilike("referral_code", normalizedCode)
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

 const lineItems = sanitizedItems.map((item) => {
 const product = productsById.get(item.id);

 if (!product) {
 throw new Error(`Invalid product id: ${item.id}`);
 }

 if (product.stockStatus === "Reserved") {
 throw new Error(`Product is unavailable: ${product.name}`);
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
 const referral = await validateReferralCode(payload.referralCode);

 const discountAmount = roundMoney(
 referral
 ? subtotal * (referral.discountPercent / 100)
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

 const checkout = await provider.createCheckoutSession({
 orderId,
 customerEmail: payload.customer.email,
 amount: Math.round(expectedTotal),
 currency: payload.currency ?? "USD",

 metadata: {
 orderId,
 ambassadorId: referral?.ambassadorId ?? "",
 referralCode: referral?.code ?? "",
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