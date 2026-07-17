import { randomUUID } from "crypto";
import { getPaymentProvider } from "@/lib/payment-provider";
import type { CartItemInput, CustomerInput, PromotionInput, OrderStatus } from "@/lib/payment-types";

// Approved processor integration point:
// Connect the real processor here once an approved provider is selected.
import { products } from "@/lib/demo-data";
import { demoReferralCodes } from "@/lib/referral-codes";

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

const productsById = new Map<string, ServerProduct>(
  products.map((product) => [product.slug, {
    id: product.slug,
    name: product.name,
    price: Number(product.price.replace(/[^0-9.]/g, "")),
    stockStatus: product.stockStatus,
  }]),
);

function sanitizeText(value: string) {
  return value.replace(/[<>]/g, "").trim();
}

function validateCustomer(customer: CustomerInput) {
  if (!customer.email || !customer.email.includes("@")) {
    throw new Error("Invalid email address");
  }
  if (!customer.fullName || !customer.address || !customer.city || !customer.postalCode) {
    throw new Error("Incomplete customer details");
  }
}

function calculateShipping(subtotal: number) {
  return subtotal > 0 ? 24 : 0;
}

function validatePromotion(code?: string): PromotionInput | null {
  if (!code) {
    return null;
  }
  const promotion = demoReferralCodes.find((entry) => entry.code === code.toUpperCase());
  if (!promotion) {
    throw new Error("Invalid referral code");
  }
  if (promotion.status !== "Active") {
    throw new Error("Inactive referral code");
  }
  const expirationDate = new Date(promotion.expirationDate);
  if (Number.isNaN(expirationDate.getTime()) || expirationDate < new Date()) {
    throw new Error("Expired referral code");
  }
  if (promotion.uses >= promotion.maxUses) {
    throw new Error("Referral code has reached maximum uses");
  }
  return {
    code: promotion.code,
    discountPercent: promotion.customerDiscountPercent,
    expiresAt: promotion.expirationDate,
    status: promotion.status,
    maxUses: promotion.maxUses,
    uses: promotion.uses,
  };
}

export async function createCheckoutSession(payload: CreateCheckoutPayload): Promise<PendingOrder> {
  validateCustomer(payload.customer);

  const sanitizedItems = payload.items.map((item) => ({
    id: sanitizeText(item.id),
    quantity: Number(item.quantity),
  }));

  if (sanitizedItems.length === 0) {
    throw new Error("Cart is empty");
  }

  if (sanitizedItems.some((item) => !item.id || item.quantity < 1 || Number.isNaN(item.quantity))) {
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
    return { product, quantity: item.quantity };
  });

  const subtotal = lineItems.reduce((sum, line) => sum + line.product.price * line.quantity, 0);
  const shipping = calculateShipping(subtotal);
  const promotion = validatePromotion(payload.referralCode);
  const discountAmount = promotion ? subtotal * (promotion.discountPercent / 100) : 0;
  const expectedTotal = subtotal + shipping - discountAmount;

  if (payload.expectedTotal !== undefined && Number(payload.expectedTotal) !== expectedTotal) {
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
      referralCode: promotion?.code ?? "",
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
