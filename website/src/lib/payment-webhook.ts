import { randomUUID } from "crypto";
import { getPaymentProvider } from "@/lib/payment-provider";
import type { OrderStatus } from "@/lib/payment-types";
import { supabaseAdmin } from "@/lib/supabase-server";

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

  const eventPayload = JSON.parse(payload) as { orderId?: string; type?: string; paymentId?: string; status?: string };
  const orderId = eventPayload.orderId ?? `order-${randomUUID()}`;

  let nextStatus: OrderStatus = "pending_payment";

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

  const { data: existingRows, error: duplicateError } = await supabaseAdmin
    .from("referral_orders")
    .select("id, commission_percent, amount_paid, payment_status")
    .eq("order_id", orderId)
    .limit(1);

  if (duplicateError) {
    console.error("Unable to check existing referral orders", duplicateError);
    throw new Error("Unable to process webhook");
  }

  if (existingRows && existingRows.length > 0) {
    const existingRow = existingRows[0];
    if (existingRow.payment_status === nextStatus) {
      return { duplicate: true };
    }

    const commissionAmount =
      nextStatus === "paid" && existingRow.commission_percent
        ? Math.round((existingRow.amount_paid ?? 0) * (existingRow.commission_percent / 100) * 100) / 100
        : 0;

    await supabaseAdmin
      .from("referral_orders")
      .update({
        payment_status: nextStatus,
        payment_id: eventPayload.paymentId ?? null,
        commission_amount: commissionAmount,
      })
      .eq("order_id", orderId);
  } else {
    await supabaseAdmin.from("referral_orders").insert({
      order_id: orderId,
      payment_id: eventPayload.paymentId ?? null,
      payment_status: nextStatus,
      created_at: new Date().toISOString(),
    });
  }

  return {
    duplicate: false,
    eventId,
    orderId,
    status: nextStatus,
    providerStatus: eventPayload.status ?? eventPayload.type ?? "unknown",
  } as WebhookEventState;
}
