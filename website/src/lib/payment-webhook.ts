import { randomUUID } from "crypto";
import { getPaymentProvider } from "@/lib/payment-provider";
import type { OrderStatus } from "@/lib/payment-types";
import { supabaseAdmin } from "@/lib/supabase-server";

export interface WebhookEventState {
  eventId: string;
  orderId: string;
  status: OrderStatus;
  providerStatus: string;
  duplicate: boolean;
}

export interface CommissionState {
  status: "pending" | "paid" | "voided" | "manual_review";
  reviewRequired: boolean;
  reviewReason: string | null;
}

export function getOrderStatusForEventType(eventType: string): OrderStatus {
  switch (eventType) {
    case "payment.succeeded":
      return "paid";
    case "payment.failed":
      return "payment_failed";
    case "payment.canceled":
      return "canceled";
    case "refund.completed":
      return "refunded";
    default:
      return "pending_payment";
  }
}

export function getCommissionStateForRefund(commissionStatus: string | null | undefined): CommissionState {
  if (commissionStatus === "paid") {
    return {
      status: "manual_review",
      reviewRequired: true,
      reviewReason: "Refund received after commission payment",
    };
  }

  return {
    status: "voided",
    reviewRequired: false,
    reviewReason: null,
  };
}

function roundMoney(value: number) {
  return Math.round(value * 100) / 100;
}

function normalizeOrderPayload(payload: string) {
  return JSON.parse(payload) as {
    orderId?: string;
    type?: string;
    paymentId?: string;
    status?: string;
    customer?: {
      email?: string;
      fullName?: string;
      address?: string;
      city?: string;
      postalCode?: string;
    };
    amount?: number;
    subtotal?: number;
    shippingAmount?: number;
    discountAmount?: number;
    currency?: string;
    referralCode?: string;
    ambassadorId?: string;
    commissionPercent?: number;
    items?: Array<{
      productId?: string;
      productName?: string;
      unitPrice?: number;
      quantity?: number;
      lineTotal?: number;
    }>;
  };
}

async function markEventProcessed(eventId: string, orderId: string, status: OrderStatus) {
  const { error } = await supabaseAdmin.from("payment_events").upsert(
    {
      event_id: eventId,
      order_id: orderId,
      status,
      processed_at: new Date().toISOString(),
    },
    { onConflict: "event_id" },
  );

  if (error) {
    throw error;
  }
}

async function getExistingEvent(eventId: string) {
  const { data, error } = await supabaseAdmin
    .from("payment_events")
    .select("event_id")
    .eq("event_id", eventId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data;
}

async function getOrderByOrderId(orderId: string) {
  const { data, error } = await supabaseAdmin
    .from("orders")
    .select("id, order_id, payment_status, payment_id, referral_code, ambassador_id, amount_paid, paid_at")
    .eq("order_id", orderId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data;
}

async function upsertOrderRecord(input: {
  orderId: string;
  paymentId?: string;
  customerEmail?: string;
  customerName?: string;
  shippingAddress?: string;
  city?: string;
  postalCode?: string;
  currency?: string;
  subtotal?: number;
  shippingAmount?: number;
  discountAmount?: number;
  amountPaid?: number;
  referralCode?: string;
  ambassadorId?: string;
  paymentStatus: OrderStatus;
  fulfillmentStatus?: string;
  paidAt?: string | null;
  providerEventId?: string;
  items?: Array<{
    productId?: string;
    productName?: string;
    unitPrice?: number;
    quantity?: number;
    lineTotal?: number;
  }>;
}) {
  const { data: existingOrder, error: existingError } = await supabaseAdmin
    .from("orders")
    .select("id")
    .eq("order_id", input.orderId)
    .maybeSingle();

  if (existingError) {
    throw existingError;
  }

  const basePayload = {
    order_id: input.orderId,
    payment_id: input.paymentId ?? null,
    customer_email: input.customerEmail ?? null,
    customer_name: input.customerName ?? null,
    shipping_address: input.shippingAddress ?? null,
    city: input.city ?? null,
    postal_code: input.postalCode ?? null,
    currency: input.currency ?? "USD",
    subtotal: roundMoney(input.subtotal ?? 0),
    shipping_amount: roundMoney(input.shippingAmount ?? 0),
    discount_amount: roundMoney(input.discountAmount ?? 0),
    amount_paid: roundMoney(input.amountPaid ?? 0),
    referral_code: input.referralCode ?? null,
    ambassador_id: input.ambassadorId ?? null,
    payment_status: input.paymentStatus,
    fulfillment_status: input.fulfillmentStatus ?? "pending",
    provider_event_id: input.providerEventId ?? null,
    paid_at: input.paidAt ?? null,
    updated_at: new Date().toISOString(),
  };

  if (existingOrder) {
    const { error } = await supabaseAdmin.from("orders").update(basePayload).eq("order_id", input.orderId);
    if (error) {
      throw error;
    }

    return { id: existingOrder.id };
  }

  const { data, error } = await supabaseAdmin.from("orders").insert({
    ...basePayload,
    created_at: new Date().toISOString(),
  }).select("id").single();

  if (error) {
    throw error;
  }

  return { id: data.id };
}

async function upsertOrderItems(orderId: string, items?: Array<{
  productId?: string;
  productName?: string;
  unitPrice?: number;
  quantity?: number;
  lineTotal?: number;
}>) {
  if (!items || items.length === 0) {
    return;
  }

  const rows = items
    .filter((item) => item.productId || item.productName)
    .map((item) => ({
      order_id: orderId,
      product_id: item.productId ?? null,
      product_name: item.productName ?? null,
      unit_price: roundMoney(item.unitPrice ?? 0),
      quantity: Number(item.quantity ?? 0),
      line_total: roundMoney(item.lineTotal ?? 0),
    }));

  if (rows.length === 0) {
    return;
  }

  await supabaseAdmin.from("order_items").delete().eq("order_id", orderId);
  const { error } = await supabaseAdmin.from("order_items").insert(rows);
  if (error) {
    throw error;
  }
}

async function ensureCommissionRecord(input: {
  orderId: string;
  ambassadorId?: string;
  referralCode?: string;
  commissionPercent?: number;
  amountPaid?: number;
  paymentStatus: OrderStatus;
  providerEventId?: string;
}) {
  if (!input.ambassadorId || !input.referralCode) {
    return null;
  }

  const commissionAmount = roundMoney((input.amountPaid ?? 0) * ((input.commissionPercent ?? 0) / 100));

  const { data: existingCommission, error: commissionLookupError } = await supabaseAdmin
    .from("referral_orders")
    .select("id, payment_status")
    .eq("order_id", input.orderId)
    .maybeSingle();

  if (commissionLookupError) {
    throw commissionLookupError;
  }

  const basePayload = {
    order_id: input.orderId,
    ambassador_id: input.ambassadorId,
    referral_code: input.referralCode,
    commission_percent: input.commissionPercent ?? 0,
    commission_amount: commissionAmount,
    amount_paid: roundMoney(input.amountPaid ?? 0),
    payment_id: null,
    payment_status: input.paymentStatus === "paid" ? "paid" : "pending",
    provider_event_id: input.providerEventId ?? null,
    updated_at: new Date().toISOString(),
  };

  if (existingCommission) {
    const { error } = await supabaseAdmin.from("referral_orders").update(basePayload).eq("order_id", input.orderId);
    if (error) {
      throw error;
    }

    const { error: commissionMirrorError } = await supabaseAdmin
      .from("commissions")
      .upsert({
        order_id: input.orderId,
        partner_id: input.ambassadorId,
        referral_code: input.referralCode,
        commission_percent: input.commissionPercent ?? 0,
        commission_amount: commissionAmount,
        status: "pending",
        updated_at: new Date().toISOString(),
      }, { onConflict: "order_id" });

    if (commissionMirrorError) {
      throw commissionMirrorError;
    }

    return { id: existingCommission.id };
  }

  const { data, error } = await supabaseAdmin.from("referral_orders").insert({
    ...basePayload,
    created_at: new Date().toISOString(),
  }).select("id").single();

  if (error) {
    throw error;
  }

  const { error: commissionMirrorError } = await supabaseAdmin
    .from("commissions")
    .upsert({
      order_id: input.orderId,
      partner_id: input.ambassadorId,
      referral_code: input.referralCode,
      commission_percent: input.commissionPercent ?? 0,
      commission_amount: commissionAmount,
      status: "pending",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }, { onConflict: "order_id" });

  if (commissionMirrorError) {
    throw commissionMirrorError;
  }

  return { id: data.id };
}

async function updateCommissionOnRefund(orderId: string, paymentStatus: OrderStatus) {
  const commissionState = getCommissionStateForRefund(paymentStatus === "refunded" ? "paid" : null);

  const { error } = await supabaseAdmin
    .from("referral_orders")
    .update({
      payment_status: commissionState.status,
      review_required: commissionState.reviewRequired,
      review_reason: commissionState.reviewReason,
      updated_at: new Date().toISOString(),
    })
    .eq("order_id", orderId);

  if (error) {
    throw error;
  }

  const { error: commissionMirrorError } = await supabaseAdmin
    .from("commissions")
    .update({
      status: commissionState.status === "voided" ? "voided" : "pending",
      updated_at: new Date().toISOString(),
    })
    .eq("order_id", orderId);

  if (commissionMirrorError) {
    throw commissionMirrorError;
  }
}

export async function processPaymentWebhook(payload: string, signature: string, secret: string, eventId: string) {
  const provider = getPaymentProvider();
  const isValid = provider.verifyWebhookSignature(payload, signature, secret);
  if (!isValid) {
    throw new Error("Invalid webhook signature");
  }

  const eventPayload = normalizeOrderPayload(payload);
  const orderId = eventPayload.orderId ?? `order-${randomUUID()}`;
  const nextStatus = getOrderStatusForEventType(eventPayload.type ?? "");

  const existingEvent = await getExistingEvent(eventId);
  if (existingEvent) {
    return {
      duplicate: true,
      eventId,
      orderId,
      status: nextStatus,
      providerStatus: eventPayload.status ?? eventPayload.type ?? "unknown",
    } satisfies WebhookEventState;
  }

  const orderRecord = await getOrderByOrderId(orderId);
  const subtotal = roundMoney(eventPayload.subtotal ?? 0);
  const shippingAmount = roundMoney(eventPayload.shippingAmount ?? 0);
  const discountAmount = roundMoney(eventPayload.discountAmount ?? 0);
  const amountPaid = roundMoney(eventPayload.amount ?? 0);

  await upsertOrderRecord({
    orderId,
    paymentId: eventPayload.paymentId,
    customerEmail: eventPayload.customer?.email,
    customerName: eventPayload.customer?.fullName,
    shippingAddress: eventPayload.customer?.address,
    city: eventPayload.customer?.city,
    postalCode: eventPayload.customer?.postalCode,
    currency: eventPayload.currency ?? "USD",
    subtotal,
    shippingAmount,
    discountAmount,
    amountPaid,
    referralCode: eventPayload.referralCode,
    ambassadorId: eventPayload.ambassadorId,
    paymentStatus: nextStatus,
    fulfillmentStatus: nextStatus === "paid" ? "awaiting_fulfillment" : orderRecord?.payment_status ?? "pending",
    paidAt: nextStatus === "paid" ? new Date().toISOString() : orderRecord?.paid_at ?? null,
    providerEventId: eventId,
    items: eventPayload.items,
  });

  await upsertOrderItems(orderId, eventPayload.items);

  if (nextStatus === "paid") {
    await ensureCommissionRecord({
      orderId,
      ambassadorId: eventPayload.ambassadorId,
      referralCode: eventPayload.referralCode,
      commissionPercent: eventPayload.commissionPercent,
      amountPaid,
      paymentStatus: nextStatus,
      providerEventId: eventId,
    });
  }

  if (nextStatus === "refunded") {
    await updateCommissionOnRefund(orderId, nextStatus);
  }

  await markEventProcessed(eventId, orderId, nextStatus);

  return {
    duplicate: false,
    eventId,
    orderId,
    status: nextStatus,
    providerStatus: eventPayload.status ?? eventPayload.type ?? "unknown",
  } satisfies WebhookEventState;
}
