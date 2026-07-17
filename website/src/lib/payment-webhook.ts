import { randomUUID } from "crypto";
import { getPaymentProvider } from "@/lib/payment-provider";
import type { OrderStatus } from "@/lib/payment-types";

const processedWebhookIds = new Set<string>();
const orders = new Map<string, { status: OrderStatus; paymentId?: string }>();

export interface WebhookEventState {
  eventId: string;
  orderId: string;
  status: OrderStatus;
  providerStatus: string;
}

export async function processPaymentWebhook(payload: string, signature: string, secret: string, eventId: string) {
  const provider = getPaymentProvider();
  const isValid = provider.verifyWebhookSignature(payload, signature, secret);
  if (!isValid) {
    throw new Error("Invalid webhook signature");
  }

  if (processedWebhookIds.has(eventId)) {
    return { duplicate: true };
  }

  processedWebhookIds.add(eventId);

  const eventPayload = JSON.parse(payload) as { orderId?: string; type?: string; paymentId?: string; status?: string };
  const orderId = eventPayload.orderId ?? `order-${randomUUID()}`;

  const orderState = orders.get(orderId) ?? { status: "pending_payment" };
  let nextStatus: OrderStatus = orderState.status;

  switch (eventPayload.type) {
    case "payment.succeeded":
      nextStatus = "paid";
      break;
    case "payment.failed":
      nextStatus = "payment_failed";
      break;
    case "payment.canceled":
      nextStatus = "canceled";
      break;
    case "refund.completed":
      nextStatus = "refunded";
      break;
    default:
      nextStatus = "pending_payment";
  }

  orders.set(orderId, { ...orderState, status: nextStatus, paymentId: eventPayload.paymentId });

  return {
    duplicate: false,
    eventId,
    orderId,
    status: nextStatus,
    providerStatus: eventPayload.status ?? eventPayload.type ?? "unknown",
  } as WebhookEventState;
}
