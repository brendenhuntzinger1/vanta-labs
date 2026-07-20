import { randomUUID } from "crypto";
import { getPaymentProvider } from "@/lib/payment-provider";
import type { OrderStatus } from "@/lib/payment-types";
import { supabaseAdmin } from "@/lib/supabase-server";
import { sendEmail } from "@/lib/email/send";
import { orderConfirmationTemplate } from "@/lib/email/templates";
import { redeemCoupon } from "@/lib/coupons";
import { calculateEarnedPoints, getActivePointsMultiplier, getCustomerMembership, recordPointsLedgerEntry, reverseOrderPoints } from "@/lib/membership";
import { detectCommissionFraudSignal, getEffectiveCommissionPercent } from "@/lib/ambassador-commission";
import { getAmbassadorProgramSettings } from "@/lib/ambassador-settings";

export interface WebhookEventState {
  eventId: string;
  orderId: string;
  status: OrderStatus;
  providerStatus: string;
  duplicate: boolean;
}

export interface CommissionState {
  status: "pending" | "reversed" | "manual_review";
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
    case "chargeback.created":
    case "chargeback.lost":
      return "refunded";
    default:
      return "pending_payment";
  }
}

export function getCommissionStateForRefund(currentStatus: string | null | undefined): CommissionState {
  const normalizedStatus = (currentStatus ?? "pending").toLowerCase();

  if (normalizedStatus === "paid" || normalizedStatus === "commission_paid") {
    return {
      status: "manual_review",
      reviewRequired: true,
      reviewReason: "Refund received after commission payment",
    };
  }

  const isKnownStatus =
    normalizedStatus === "pending" ||
    normalizedStatus === "approved_for_payout" ||
    normalizedStatus === "reversed" ||
    normalizedStatus === "voided";

  return {
    status: "reversed",
    reviewRequired: !isKnownStatus,
    reviewReason: isKnownStatus ? null : `Refund applied to commission status: ${normalizedStatus}`,
  };
}

function roundMoney(value: number) {
  return Math.round(value * 100) / 100;
}

async function logCommerceAnalyticsEvent(input: {
  eventType: "purchase" | "refund";
  orderId: string;
  amountPaid: number;
  referralCode?: string;
  ambassadorId?: string;
}) {
  try {
    await supabaseAdmin.from("website_analytics_events").insert({
      event_type: input.eventType,
      page_path: "/checkout",
      page_url: null,
      referrer: null,
      session_id: `order:${input.orderId}`,
      visitor_id: null,
      user_agent: null,
      ip_address: null,
      country: null,
      city: null,
      device_type: null,
      utm_source: null,
      utm_medium: null,
      utm_campaign: null,
      event_payload: {
        orderId: input.orderId,
        amountPaid: input.amountPaid,
        referralCode: input.referralCode ?? null,
        ambassadorId: input.ambassadorId ?? null,
      },
      created_at: new Date().toISOString(),
    });
  } catch {
    // Analytics must not block order processing.
  }
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
    couponCode?: string;
    customerUserId?: string;
    pointsRedeemed?: number;
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
    .select("id, order_id, payment_status, payment_id, referral_code, ambassador_id, amount_paid, paid_at, customer_user_id, points_redeemed")
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
  couponCode?: string;
  customerUserId?: string;
  pointsRedeemed?: number;
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
    coupon_code: input.couponCode ?? null,
    customer_user_id: input.customerUserId ?? null,
    points_redeemed: input.pointsRedeemed ?? 0,
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
  commissionableSubtotal?: number;
  paymentStatus: OrderStatus;
  providerEventId?: string;
  customerEmail?: string | null;
  shippingAddress?: string | null;
  city?: string | null;
  postalCode?: string | null;
}) {
  if (!input.ambassadorId || !input.referralCode) {
    return null;
  }

  const commissionableSubtotal = roundMoney(input.commissionableSubtotal ?? 0);

  const [ambassadorSettings, effectiveCommission, fraudSignal] = await Promise.all([
    getAmbassadorProgramSettings(),
    getEffectiveCommissionPercent({
      ambassadorId: input.ambassadorId,
      fallbackPercent: input.commissionPercent ?? 0,
    }),
    detectCommissionFraudSignal({
      ambassadorId: input.ambassadorId,
      orderId: input.orderId,
      customerEmail: input.customerEmail,
      shippingAddress: input.shippingAddress,
      city: input.city,
      postalCode: input.postalCode,
    }),
  ]);

  // Re-checked here (not just at checkout) as defense in depth - the order
  // shouldn't be able to earn a commission below the minimum qualifying
  // order regardless of how it reached "paid".
  const isIneligible = commissionableSubtotal < ambassadorSettings.minimumQualifyingOrder;
  const ineligibleReason = isIneligible
    ? `Order subtotal ${commissionableSubtotal.toFixed(2)} is below the ${ambassadorSettings.minimumQualifyingOrder.toFixed(2)} minimum qualifying order.`
    : null;

  const commissionPercent = isIneligible ? 0 : effectiveCommission.percent;
  const commissionAmount = isIneligible ? 0 : roundMoney(commissionableSubtotal * (commissionPercent / 100));

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
    commission_percent: commissionPercent,
    commission_amount: commissionAmount,
    amount_paid: commissionableSubtotal,
    payment_id: null,
    payment_status: "pending",
    provider_event_id: input.providerEventId ?? null,
    tier_name: effectiveCommission.tierName,
    ineligible_reason: ineligibleReason,
    fraud_flag: fraudSignal.flagged,
    fraud_reason: fraudSignal.reason,
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
        commission_percent: commissionPercent,
        commission_amount: commissionAmount,
        status: "pending",
        tier_name: effectiveCommission.tierName,
        ineligible_reason: ineligibleReason,
        fraud_flag: fraudSignal.flagged,
        fraud_reason: fraudSignal.reason,
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
      commission_percent: commissionPercent,
      commission_amount: commissionAmount,
      status: "pending",
      tier_name: effectiveCommission.tierName,
      ineligible_reason: ineligibleReason,
      fraud_flag: fraudSignal.flagged,
      fraud_reason: fraudSignal.reason,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }, { onConflict: "order_id" });

  if (commissionMirrorError) {
    throw commissionMirrorError;
  }

  return { id: data.id };
}

export async function updateCommissionOnRefund(orderId: string) {
  const { data: existingCommission, error: lookupError } = await supabaseAdmin
    .from("referral_orders")
    .select("payment_status")
    .eq("order_id", orderId)
    .maybeSingle();

  if (lookupError) {
    throw lookupError;
  }

  if (!existingCommission) {
    return;
  }

  const commissionState = getCommissionStateForRefund(existingCommission.payment_status);

  const { error } = await supabaseAdmin
    .from("referral_orders")
    .update({
      payment_status: commissionState.status,
      reversed_at: new Date().toISOString(),
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
      status: commissionState.status,
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
  const commissionableSubtotal = roundMoney(Math.max(0, subtotal - discountAmount));

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
    couponCode: eventPayload.couponCode,
    customerUserId: eventPayload.customerUserId ?? orderRecord?.customer_user_id ?? undefined,
    pointsRedeemed: eventPayload.pointsRedeemed ?? orderRecord?.points_redeemed ?? 0,
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
      commissionableSubtotal,
      paymentStatus: nextStatus,
      providerEventId: eventId,
      customerEmail: eventPayload.customer?.email,
      shippingAddress: eventPayload.customer?.address,
      city: eventPayload.customer?.city,
      postalCode: eventPayload.customer?.postalCode,
    });

    await logCommerceAnalyticsEvent({
      eventType: "purchase",
      orderId,
      amountPaid,
      referralCode: eventPayload.referralCode,
      ambassadorId: eventPayload.ambassadorId,
    });

    const wasAlreadyPaid = orderRecord?.payment_status === "paid";

    if (!wasAlreadyPaid && eventPayload.couponCode) {
      await redeemCoupon(eventPayload.couponCode);
    }

    const customerUserId = eventPayload.customerUserId ?? orderRecord?.customer_user_id ?? null;
    if (!wasAlreadyPaid && customerUserId) {
      try {
        const pointsRedeemed = Number(eventPayload.pointsRedeemed ?? orderRecord?.points_redeemed ?? 0);
        if (pointsRedeemed > 0) {
          await recordPointsLedgerEntry({
            userId: customerUserId,
            amount: -pointsRedeemed,
            reason: "redeem",
            orderId,
          });
        }

        const membership = await getCustomerMembership(customerUserId);
        const { multiplier } = await getActivePointsMultiplier();
        const pointsEarned = calculateEarnedPoints(commissionableSubtotal, membership.tier.pointsPerDollar, multiplier);

        if (pointsEarned > 0) {
          await recordPointsLedgerEntry({
            userId: customerUserId,
            amount: pointsEarned,
            reason: "order_earn",
            orderId,
          });

          await supabaseAdmin.from("orders").update({ points_earned: pointsEarned }).eq("order_id", orderId);
        }
      } catch (pointsError) {
        console.error("Unable to process membership points for order", orderId, pointsError);
      }
    }

    if (!wasAlreadyPaid && eventPayload.customer?.email) {
      try {
        const template = orderConfirmationTemplate({
          customerName: eventPayload.customer.fullName ?? "",
          orderId,
          items: (eventPayload.items ?? []).map((item) => ({
            name: item.productName ?? item.productId ?? "Item",
            quantity: item.quantity ?? 0,
            lineTotal: roundMoney(item.lineTotal ?? 0),
          })),
          subtotal,
          shipping: shippingAmount,
          discount: discountAmount,
          total: amountPaid,
        });
        await sendEmail({ to: eventPayload.customer.email, ...template });
      } catch {
        // Order processing must not fail because a confirmation email couldn't be sent.
      }
    }
  }

  if (nextStatus === "refunded" || nextStatus === "canceled" || nextStatus === "payment_failed") {
    await updateCommissionOnRefund(orderId);

    if (nextStatus === "refunded") {
      try {
        await reverseOrderPoints(orderId);
      } catch (pointsError) {
        console.error("Unable to reverse membership points for order", orderId, pointsError);
      }
    }

    if (nextStatus === "refunded" || nextStatus === "canceled") {
      await logCommerceAnalyticsEvent({
        eventType: "refund",
        orderId,
        amountPaid,
        referralCode: eventPayload.referralCode,
        ambassadorId: eventPayload.ambassadorId,
      });
    }
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
