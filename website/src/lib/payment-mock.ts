import { randomUUID } from "crypto";
import { signWebhookPayload } from "@/lib/payment-provider";

// Builds the signed webhook request the MOCK gateway feeds into the real
// payment-webhook handler when a fake payment is approved, declined, refunded,
// or canceled on the /pay/mock page. The body shape mirrors exactly what a real
// processor echoes back (order metadata + line items), so the handler processes
// a fake payment through the identical code path as a live callback — the only
// difference is where the event originates.
//
// Pure and dependency-light (no DB / server-only imports) so the whole
// fake-payment contract is unit-testable: given an order, prove the produced
// event parses to the right fields, carries a valid signature, and maps to the
// intended order status.

export type MockPaymentOutcome = "approve" | "decline" | "cancel" | "refund";

export const MOCK_EVENT_TYPE_BY_OUTCOME: Record<MockPaymentOutcome, string> = {
  approve: "payment.succeeded",
  decline: "payment.failed",
  cancel: "payment.canceled",
  refund: "refund.completed",
};

export interface MockOrderLineItem {
  productId?: string | null;
  productName?: string | null;
  unitPrice?: number | null;
  quantity?: number | null;
  lineTotal?: number | null;
}

export interface MockOrderSnapshot {
  orderId: string;
  paymentId?: string | null;
  customerEmail?: string | null;
  customerName?: string | null;
  shippingAddress?: string | null;
  city?: string | null;
  postalCode?: string | null;
  currency?: string | null;
  subtotal?: number | null;
  shippingAmount?: number | null;
  discountAmount?: number | null;
  amountPaid?: number | null;
  referralCode?: string | null;
  ambassadorId?: string | null;
  couponCode?: string | null;
  customerUserId?: string | null;
  pointsRedeemed?: number | null;
  items?: MockOrderLineItem[];
}

export interface SignedWebhookRequest {
  body: string;
  signature: string;
  eventId: string;
  eventType: string;
}

function num(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function str(value: string | null | undefined): string | undefined {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed ? trimmed : undefined;
}

// The dev/test webhook secret. In mock mode both the signer (here) and the
// verifier (the webhook handler, called with this same value) are us, so a
// fixed fallback keeps fake payments working even when PAYMENT_WEBHOOK_SECRET
// is unset in a local/dev environment. A real processor always sets a real
// secret, and live mode never uses this path.
export function resolveMockWebhookSecret(secret = process.env.PAYMENT_WEBHOOK_SECRET): string {
  const trimmed = (secret ?? "").trim();
  return trimmed || "mock-webhook-secret";
}

// Serialize an order into the exact event-payload shape the webhook handler's
// normalizeOrderPayload() reads. Keeping the field names in lockstep with that
// reader is the contract this module (and its tests) guard.
export function buildMockEventBody(order: MockOrderSnapshot, eventType: string): string {
  const payload = {
    orderId: order.orderId,
    type: eventType,
    paymentId: str(order.paymentId) ?? `mock_pay_${order.orderId}`,
    status: eventType,
    customer: {
      email: str(order.customerEmail),
      fullName: str(order.customerName),
      address: str(order.shippingAddress),
      city: str(order.city),
      postalCode: str(order.postalCode),
    },
    amount: num(order.amountPaid),
    subtotal: num(order.subtotal),
    shippingAmount: num(order.shippingAmount),
    discountAmount: num(order.discountAmount),
    currency: str(order.currency) ?? "USD",
    referralCode: str(order.referralCode),
    ambassadorId: str(order.ambassadorId),
    couponCode: str(order.couponCode),
    customerUserId: str(order.customerUserId),
    pointsRedeemed: num(order.pointsRedeemed),
    items: (order.items ?? []).map((item) => ({
      productId: str(item.productId),
      productName: str(item.productName),
      unitPrice: num(item.unitPrice),
      quantity: num(item.quantity),
      lineTotal: num(item.lineTotal),
    })),
  };

  return JSON.stringify(payload);
}

// Build a fully signed webhook request (body + signature + unique event id)
// for a given fake-payment outcome. `eventId` is unique per call so each
// simulated event is processed once (the handler dedups on event id); pass an
// explicit id in tests for determinism.
export function buildMockWebhookRequest(
  order: MockOrderSnapshot,
  outcome: MockPaymentOutcome,
  options?: { secret?: string; eventId?: string },
): SignedWebhookRequest {
  const eventType = MOCK_EVENT_TYPE_BY_OUTCOME[outcome];
  const secret = resolveMockWebhookSecret(options?.secret);
  const body = buildMockEventBody(order, eventType);
  const signature = signWebhookPayload(body, secret);
  const eventId = options?.eventId ?? `mock_evt_${randomUUID()}`;

  return { body, signature, eventId, eventType };
}

// Standard set of test cards so testers get predictable outcomes, mirroring the
// well-known processor test numbers. Any number not in the decline set is
// treated as a successful approval.
const DECLINE_TEST_CARDS = new Set(["4000000000000002", "4000000000009995", "4000000000000127"]);

export function outcomeForTestCard(cardNumber: string): MockPaymentOutcome {
  const digits = (cardNumber ?? "").replace(/\D/g, "");
  return DECLINE_TEST_CARDS.has(digits) ? "decline" : "approve";
}
