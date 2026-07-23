import { randomUUID } from "crypto";
import { getPaymentProvider } from "@/lib/payment-provider";
import type { OrderStatus } from "@/lib/payment-types";
import { supabaseAdmin } from "@/lib/supabase-server";
import { sendEmail } from "@/lib/email/send";
import { commissionEarnedTemplate, orderConfirmationTemplate } from "@/lib/email/templates";
import { getSiteUrl } from "@/lib/env";
import { redeemCoupon } from "@/lib/coupons";
import { calculateEarnedPoints, getActivePointsMultiplier, getActivePointsPerDollar, recordPointsLedgerEntry, redeemPoints, restoreRedeemedPoints, reverseOrderPoints } from "@/lib/membership";
import { redeemStoreCredit, refundStoreCreditForOrder } from "@/lib/store-credit";
import { detectCommissionFraudSignal, getEffectiveCommissionPercent } from "@/lib/ambassador-commission";
import { getAmbassadorProgramSettings } from "@/lib/ambassador-settings";
import { getReferralProgramConfig } from "@/lib/admin-control";
import { markAbandonedCartsRecovered } from "@/lib/cart-recovery";
import { decrementInventoryForOrder, restockInventoryForOrder } from "@/lib/inventory-fulfillment";
import { transmitOrderToFulfillment } from "@/lib/fulfillment/service";
import { activateAnnualMembership, revokeMembershipForRefund } from "@/lib/membership-billing";

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

// How long an unfinished claim may sit before it's assumed dead (a prior
// attempt crashed after claiming but before completing) and may be retaken.
// Webhook processing takes seconds, so 5 minutes never reclaims a live attempt.
const STALE_CLAIM_MS = 5 * 60 * 1000;

// Atomically claim a webhook event before running any side-effects. The
// event_id is the primary key of payment_events, so a concurrent duplicate
// delivery (processors retry and can fan out) loses the insert race with a
// unique-violation (23505). processed_at is the COMPLETION marker: a claimed
// row with processed_at IS NULL is in-flight. If that claim is stale (its owner
// crashed before markEventProcessed), it is reclaimed so the processor's retry
// can finish the order instead of being skipped forever as a "duplicate".
async function claimEvent(eventId: string, orderId: string, status: OrderStatus): Promise<boolean> {
  const nowIso = new Date().toISOString();
  const { error } = await supabaseAdmin.from("payment_events").insert({
    event_id: eventId,
    order_id: orderId,
    status,
    claimed_at: nowIso,
    processed_at: null,
  });

  if (!error) {
    return true;
  }

  if ((error as { code?: string }).code !== "23505") {
    throw error;
  }

  // A row already exists. Decide: genuinely completed (skip), a live in-flight
  // claim (skip), or a stale/stranded claim (reclaim and reprocess).
  const { data: existing } = await supabaseAdmin
    .from("payment_events")
    .select("processed_at, claimed_at")
    .eq("event_id", eventId)
    .maybeSingle();

  if (!existing) {
    // The row was deleted (e.g. releaseEvent) between our failed insert and this
    // read — try to claim it fresh once more.
    const retry = await supabaseAdmin.from("payment_events").insert({
      event_id: eventId,
      order_id: orderId,
      status,
      claimed_at: nowIso,
      processed_at: null,
    });
    return !retry.error;
  }

  if (existing.processed_at) {
    return false; // genuinely already processed — a true duplicate
  }

  const staleBefore = new Date(Date.now() - STALE_CLAIM_MS).toISOString();
  if (String(existing.claimed_at ?? "") >= staleBefore) {
    return false; // a recent, still-live claim is in flight — skip
  }

  // Stale unprocessed claim → retake it atomically. The guards ensure only ONE
  // reclaimer wins even if several retries arrive together.
  const { data: reclaimed, error: reclaimError } = await supabaseAdmin
    .from("payment_events")
    .update({ claimed_at: nowIso, order_id: orderId, status })
    .eq("event_id", eventId)
    .is("processed_at", null)
    .lt("claimed_at", staleBefore)
    .select("event_id");

  if (reclaimError) {
    throw reclaimError;
  }

  return Boolean(reclaimed && reclaimed.length > 0);
}

// Undo a claim when processing fails partway, so the event isn't permanently
// treated as a duplicate and a retry can reprocess it cleanly.
async function releaseEvent(eventId: string) {
  await supabaseAdmin.from("payment_events").delete().eq("event_id", eventId);
}

async function getOrderByOrderId(orderId: string) {
  const { data, error } = await supabaseAdmin
    .from("orders")
    .select("id, order_id, order_type, payment_status, fulfillment_status, payment_id, referral_code, ambassador_id, coupon_code, subtotal, shipping_amount, discount_amount, amount_paid, paid_at, customer_user_id, points_redeemed, store_credit_redeemed_cents")
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
  // Pre-discount merchandise subtotal — the SAME number checkout gates on. Used
  // for the minimum-qualifying-order check so a cart that qualified at checkout
  // always earns, even after the referral discount lowers the net (fixes the
  // "used a code, ambassador got $0" edge). Falls back to commissionableSubtotal.
  qualifyingSubtotal?: number;
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
  const qualifyingSubtotal = roundMoney(input.qualifyingSubtotal ?? commissionableSubtotal);

  const [ambassadorSettings, referralProgram, fraudSignal, ambassadorRow] = await Promise.all([
    getAmbassadorProgramSettings(),
    getReferralProgramConfig(),
    detectCommissionFraudSignal({
      ambassadorId: input.ambassadorId,
      orderId: input.orderId,
      customerEmail: input.customerEmail,
      shippingAddress: input.shippingAddress,
      city: input.city,
      postalCode: input.postalCode,
    }),
    supabaseAdmin.from("ambassadors").select("status").eq("id", input.ambassadorId).maybeSingle(),
  ]);

  // Fall back to the admin's default commission rate (Control Center) when the
  // order/ambassador carries no explicit rate, instead of a hardcoded number.
  const effectiveCommission = await getEffectiveCommissionPercent({
    ambassadorId: input.ambassadorId,
    fallbackPercent: input.commissionPercent ?? referralProgram.defaultCommissionPercent,
  });

  // Eligibility is re-checked here (not just at checkout) as defense in depth,
  // and now also enforces live ambassador state: a commission never accrues if
  // the program is off, commissions are globally paused, or the ambassador has
  // been deactivated/removed since the order was placed. The minimum-order check
  // uses the pre-discount subtotal (what checkout gated on) so a qualifying cart
  // is never silently zeroed by its own referral discount.
  const ambassadorApproved = String(ambassadorRow.data?.status ?? "") === "approved";
  let ineligibleReason: string | null = null;
  if (!referralProgram.enabled) {
    ineligibleReason = "Referral program is disabled.";
  } else if (referralProgram.commissionsPaused) {
    ineligibleReason = "Commissions are paused.";
  } else if (!ambassadorApproved) {
    ineligibleReason = "Ambassador is not active.";
  } else if (qualifyingSubtotal < ambassadorSettings.minimumQualifyingOrder) {
    ineligibleReason = `Order subtotal ${qualifyingSubtotal.toFixed(2)} is below the ${ambassadorSettings.minimumQualifyingOrder.toFixed(2)} minimum qualifying order.`;
  }

  const isIneligible = ineligibleReason !== null;
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

  // Notify the ambassador of the new commission — only on a genuinely NEW
  // commission row (never on webhook retries, which hit the existingCommission
  // branch above), and only when a real, eligible, non-fraud commission was
  // earned. Best-effort: a failed send must never break order processing.
  if (commissionAmount > 0 && !isIneligible && !fraudSignal.flagged) {
    await notifyAmbassadorOfNewCommission({
      ambassadorId: input.ambassadorId,
      referralCode: input.referralCode,
      commissionAmount,
    }).catch(() => {});
  }

  return { id: data.id };
}

// Sends the ambassador the minimal "you earned a commission" email. Contains
// ONLY commission earned, running unpaid balance, referral code, and the
// biweekly-payout reminder — no order totals, customer data, or revenue.
async function notifyAmbassadorOfNewCommission(input: {
  ambassadorId: string;
  referralCode: string;
  commissionAmount: number;
}) {
  const { data: ambassador } = await supabaseAdmin
    .from("partners")
    .select("name, email")
    .eq("id", input.ambassadorId)
    .maybeSingle();

  if (!ambassador?.email) {
    return;
  }

  // Running unpaid balance = every commission still owed (pending or approved
  // for payout, not yet paid) for this ambassador. The row just inserted is
  // "pending", so it's already included.
  const { data: unpaidRows } = await supabaseAdmin
    .from("referral_orders")
    .select("commission_amount, payment_status")
    .eq("ambassador_id", input.ambassadorId)
    .in("payment_status", ["pending", "approved_for_payout"]);

  const unpaidBalance = roundMoney(
    (unpaidRows ?? []).reduce((sum, row) => sum + Number(row.commission_amount ?? 0), 0),
  );

  const template = commissionEarnedTemplate({
    name: String(ambassador.name ?? ""),
    commissionAmount: roundMoney(input.commissionAmount),
    unpaidBalance,
    referralCode: input.referralCode,
    dashboardUrl: `${getSiteUrl().replace(/\/$/, "")}/account/ambassador`,
  });

  await sendEmail({ to: String(ambassador.email), ...template });
}

// Computes the commission that should remain after a refund. A FULL refund
// (refundedFraction >= ~1) voids the commission entirely; a PARTIAL refund
// reduces it proportionally to the share of the order value that was refunded,
// so the ambassador keeps commission on the merchandise the customer kept.
export function computeRetainedCommission(input: {
  base: number; // commissionable (discounted merchandise) subtotal
  percent: number;
  refundedFraction: number;
}): number {
  const fraction = Math.min(1, Math.max(0, input.refundedFraction));
  const original = roundMoney(input.base * (input.percent / 100));
  return roundMoney(original * (1 - fraction));
}

export async function updateCommissionOnRefund(
  orderId: string,
  options?: { refundedFraction?: number },
) {
  const { data: existingCommission, error: lookupError } = await supabaseAdmin
    .from("referral_orders")
    .select("payment_status, commission_amount, commission_percent, amount_paid")
    .eq("order_id", orderId)
    .maybeSingle();

  if (lookupError) {
    throw lookupError;
  }

  if (!existingCommission) {
    return;
  }

  // Default to a full reversal when no fraction is supplied (webhook refund/
  // cancel paths that don't carry an amount) — preserves prior behavior.
  const refundedFraction = Math.min(1, Math.max(0, options?.refundedFraction ?? 1));
  const isFullRefund = refundedFraction >= 0.999;
  const now = new Date().toISOString();
  const currentStatus = (existingCommission.payment_status ?? "pending").toLowerCase();
  const alreadyPaid = currentStatus === "paid" || currentStatus === "commission_paid";

  let referralUpdate: Record<string, unknown>;
  let commissionStatus: string;

  if (isFullRefund) {
    const commissionState = getCommissionStateForRefund(existingCommission.payment_status);
    commissionStatus = commissionState.status;
    referralUpdate = {
      payment_status: commissionState.status,
      reversed_at: now,
      review_required: commissionState.reviewRequired,
      review_reason: commissionState.reviewReason,
      updated_at: now,
    };
  } else {
    // Partial refund → keep a proportional commission. Recompute from the stored
    // base + percent so repeated partials don't compound off the mutated amount.
    const retained = computeRetainedCommission({
      base: Number(existingCommission.amount_paid ?? 0),
      percent: Number(existingCommission.commission_percent ?? 0),
      refundedFraction,
    });
    // If it was already paid out, we can't silently claw money back — flag for
    // an admin to reconcile; otherwise just lower the payable amount.
    commissionStatus = alreadyPaid ? "manual_review" : String(existingCommission.payment_status ?? "pending");
    referralUpdate = {
      commission_amount: retained,
      payment_status: commissionStatus,
      review_required: alreadyPaid,
      review_reason: alreadyPaid ? "Partial refund after commission was paid — reconcile overpayment" : null,
      updated_at: now,
    };
  }

  const { error } = await supabaseAdmin
    .from("referral_orders")
    .update(referralUpdate)
    .eq("order_id", orderId);

  if (error) {
    throw error;
  }

  const commissionMirror: Record<string, unknown> = { status: commissionStatus, updated_at: now };
  if (!isFullRefund && referralUpdate.commission_amount !== undefined) {
    commissionMirror.commission_amount = referralUpdate.commission_amount;
  }

  const { error: commissionMirrorError } = await supabaseAdmin
    .from("commissions")
    .update(commissionMirror)
    .eq("order_id", orderId);

  if (commissionMirrorError) {
    throw commissionMirrorError;
  }
}

export interface ManualPaymentFinalizeResult {
  orderId: string;
  alreadyPaid: boolean;
  status: OrderStatus;
}

// Reused post-paid side effects for a MANUAL payment (Cash App / Zelle /
// PayPal) once an admin approves it. Mirrors exactly what the card webhook
// does on payment.succeeded - flips the order to paid + awaiting_fulfillment,
// records the ambassador commission, redeems a coupon, marks abandoned carts
// recovered, awards/redeems membership points, and sends the order
// confirmation email - so approving a manual payment triggers the identical
// downstream fulfillment workflow with no extra manual steps.
export async function finalizeManualPayment(
  orderId: string,
  options: { verifiedBy: string },
): Promise<ManualPaymentFinalizeResult> {
  const { data: order, error } = await supabaseAdmin
    .from("orders")
    .select("*, order_items(*)")
    .eq("order_id", orderId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!order) {
    throw new Error("Order not found");
  }

  if (order.payment_status === "paid") {
    return { orderId, alreadyPaid: true, status: "paid" };
  }

  // Only orders that have never been paid may be approved. Refunded/canceled/
  // partially-refunded orders must NOT be re-run (that would re-award
  // commission/points/coupons and undo the refund).
  const APPROVABLE_STATUSES = new Set(["pending_payment", "awaiting_verification", "payment_rejected"]);
  if (!APPROVABLE_STATUSES.has(String(order.payment_status))) {
    throw new Error(`Cannot approve an order with status "${order.payment_status}".`);
  }

  // Manual methods only — a card order must never be approved through this
  // path (it would double-award once the real card webhook also fires).
  const method = String(order.payment_method ?? "");
  if (!method || method === "card") {
    throw new Error("This order is not a manual payment order.");
  }

  const now = new Date().toISOString();
  const subtotal = roundMoney(Number(order.subtotal ?? 0));
  const discountAmount = roundMoney(Number(order.discount_amount ?? 0));
  const amountPaid = roundMoney(Number(order.amount_paid ?? 0));
  const commissionableSubtotal = roundMoney(Math.max(0, subtotal - discountAmount));

  // Membership orders are digital — nothing ships, so they go straight to
  // "fulfilled" and are never sent to the 3PL.
  const isMembershipOrder = String(order.order_type ?? "product") === "membership";

  // Atomic claim: the update only succeeds if the status is still what we
  // read. If a concurrent approve (double-click / second admin) already
  // flipped it to paid, zero rows update and we no-op instead of double-
  // awarding points/commission/coupons/emails.
  const { data: claimed, error: updateError } = await supabaseAdmin
    .from("orders")
    .update({
      payment_status: "paid",
      fulfillment_status: isMembershipOrder ? "fulfilled" : "awaiting_fulfillment",
      paid_at: now,
      verified_at: now,
      verified_by: options.verifiedBy,
      updated_at: now,
    })
    .eq("order_id", orderId)
    .eq("payment_status", order.payment_status)
    .select("id");

  if (updateError) {
    throw updateError;
  }

  if (!claimed || claimed.length === 0) {
    return { orderId, alreadyPaid: true, status: "paid" };
  }

  const referralCode = order.referral_code ? String(order.referral_code) : undefined;
  const ambassadorId = order.ambassador_id ? String(order.ambassador_id) : undefined;

  await ensureCommissionRecord({
    orderId,
    ambassadorId,
    referralCode,
    commissionableSubtotal,
    qualifyingSubtotal: subtotal,
    paymentStatus: "paid",
    customerEmail: order.customer_email ? String(order.customer_email) : null,
    shippingAddress: order.shipping_address ? String(order.shipping_address) : null,
    city: order.city ? String(order.city) : null,
    postalCode: order.postal_code ? String(order.postal_code) : null,
  });

  await logCommerceAnalyticsEvent({
    eventType: "purchase",
    orderId,
    amountPaid,
    referralCode,
    ambassadorId,
  });

  if (order.coupon_code) {
    try {
      await redeemCoupon(String(order.coupon_code));
    } catch (couponError) {
      console.error("Unable to redeem coupon on manual payment", orderId, couponError);
    }
  }

  if (order.customer_email) {
    try {
      await markAbandonedCartsRecovered(String(order.customer_email), orderId);
    } catch (recoveryError) {
      console.error("Unable to mark abandoned carts recovered for order", orderId, recoveryError);
    }
  }

  const customerUserId = order.customer_user_id ? String(order.customer_user_id) : null;
  // Membership purchases don't earn or redeem loyalty points (it's a digital,
  // non-refundable subscription, not a merchandise order).
  if (customerUserId && !isMembershipOrder) {
    try {
      const pointsRedeemed = Number(order.points_redeemed ?? 0);
      if (pointsRedeemed > 0) {
        await redeemPoints(customerUserId, pointsRedeemed, orderId);
      }

      const storeCreditRedeemedCents = Number(order.store_credit_redeemed_cents ?? 0);
      if (storeCreditRedeemedCents > 0) {
        await redeemStoreCredit(customerUserId, storeCreditRedeemedCents, orderId);
      }

      const pointsRate = await getActivePointsPerDollar(customerUserId);
      const { multiplier } = await getActivePointsMultiplier();
      const pointsEarned = calculateEarnedPoints(commissionableSubtotal, pointsRate, multiplier);

      if (pointsEarned > 0) {
        await recordPointsLedgerEntry({ userId: customerUserId, amount: pointsEarned, reason: "order_earn", orderId });
        await supabaseAdmin.from("orders").update({ points_earned: pointsEarned }).eq("order_id", orderId);
      }
    } catch (pointsError) {
      console.error("Unable to process membership points for manual order", orderId, pointsError);
    }
  }

  if (order.customer_email) {
    try {
      const items = (order.order_items ?? []) as Array<{ product_name?: string; product_id?: string; quantity?: number; line_total?: number }>;
      const template = orderConfirmationTemplate({
        customerName: String(order.customer_name ?? ""),
        orderId: order.order_number ? String(order.order_number) : orderId,
        items: items.map((item) => ({
          name: item.product_name ?? item.product_id ?? "Item",
          quantity: Number(item.quantity ?? 0),
          lineTotal: roundMoney(Number(item.line_total ?? 0)),
        })),
        subtotal,
        shipping: roundMoney(Number(order.shipping_amount ?? 0)),
        discount: discountAmount,
        total: amountPaid,
      });
      await sendEmail({ to: String(order.customer_email), ...template });
    } catch {
      // Confirmation email is best-effort; approval already succeeded.
    }
  }

  if (isMembershipOrder) {
    // Turn on the membership + perks now that payment is verified.
    try {
      if (order.customer_user_id && order.membership_tier_id) {
        await activateAnnualMembership(String(order.customer_user_id), String(order.membership_tier_id));
      }
    } catch (membershipError) {
      console.error("Unable to activate membership for order", orderId, membershipError);
    }
  } else {
    // Commit stock now that payment is verified. The atomic order claim above
    // guarantees this runs exactly once per order, so no double-decrement.
    await decrementInventoryForOrder(
      (order.order_items ?? []) as Array<{ product_id?: string | null; quantity?: number | null }>,
    );
    // Auto-transmit the paid + verified order to the 3PL (best-effort; never
    // blocks approval).
    await transmitOrderToFulfillment(orderId);
  }

  return { orderId, alreadyPaid: false, status: "paid" };
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

  // Claim the event up front (atomic) so concurrent duplicate deliveries can't
  // both run the paid side-effects below.
  const claimed = await claimEvent(eventId, orderId, nextStatus);
  if (!claimed) {
    return {
      duplicate: true,
      eventId,
      orderId,
      status: nextStatus,
      providerStatus: eventPayload.status ?? eventPayload.type ?? "unknown",
    } satisfies WebhookEventState;
  }

  try {
  const orderRecord = await getOrderByOrderId(orderId);

  // Refund/cancel are terminal money states. A late or replayed
  // `payment.succeeded` (arriving with a fresh event_id after a refund) must
  // NOT flip the order back to "paid" and re-award commissions, points,
  // coupons, the confirmation email, and 3PL transmission. Record the event
  // against the existing status and stop.
  const REFUND_TERMINAL_STATES = new Set(["refunded", "partially_refunded", "canceled"]);
  const priorPaymentStatus = orderRecord?.payment_status ? String(orderRecord.payment_status) : null;
  if (nextStatus === "paid" && priorPaymentStatus && REFUND_TERMINAL_STATES.has(priorPaymentStatus)) {
    await markEventProcessed(eventId, orderId, priorPaymentStatus as OrderStatus);
    return {
      duplicate: false,
      eventId,
      orderId,
      status: priorPaymentStatus as OrderStatus,
      providerStatus: eventPayload.status ?? eventPayload.type ?? "unknown",
    } satisfies WebhookEventState;
  }

  // A late/out-of-order payment.failed or payment.canceled must NOT demote an
  // order that is already PAID — that would void the ambassador's earned
  // commission and restock sold inventory. Only a genuine refund/chargeback
  // (nextStatus "refunded") may leave the paid state. Record against paid + stop.
  if (priorPaymentStatus === "paid" && (nextStatus === "payment_failed" || nextStatus === "canceled")) {
    await markEventProcessed(eventId, orderId, "paid");
    return {
      duplicate: false,
      eventId,
      orderId,
      status: "paid",
      providerStatus: eventPayload.status ?? eventPayload.type ?? "unknown",
    } satisfies WebhookEventState;
  }

  // Repeated refund/chargeback events for the same order (distinct event_ids —
  // e.g. refund.completed then chargeback.lost — so not caught by the claim
  // dedup) must not re-run refund side-effects (double restock, double points/
  // store-credit reversal). If already in a refund-terminal state, record + stop.
  if (
    (nextStatus === "refunded" || nextStatus === "canceled" || nextStatus === "payment_failed") &&
    priorPaymentStatus &&
    REFUND_TERMINAL_STATES.has(priorPaymentStatus)
  ) {
    await markEventProcessed(eventId, orderId, priorPaymentStatus as OrderStatus);
    return {
      duplicate: false,
      eventId,
      orderId,
      status: priorPaymentStatus as OrderStatus,
      providerStatus: eventPayload.status ?? eventPayload.type ?? "unknown",
    } satisfies WebhookEventState;
  }

  // Money fields are DB-authoritative: they were computed and persisted at
  // checkout, so we trust the stored order over the webhook event payload (a
  // real processor's callback may omit them, which would otherwise zero the
  // recorded revenue and the ambassador commission). Fall back to the payload
  // only for a brand-new webhook-created order that has no prior row.
  const subtotal = roundMoney(Number(orderRecord?.subtotal ?? eventPayload.subtotal ?? 0));
  const shippingAmount = roundMoney(Number(orderRecord?.shipping_amount ?? eventPayload.shippingAmount ?? 0));
  const discountAmount = roundMoney(Number(orderRecord?.discount_amount ?? eventPayload.discountAmount ?? 0));
  const amountPaid = roundMoney(Number(orderRecord?.amount_paid ?? eventPayload.amount ?? 0));
  const commissionableSubtotal = roundMoney(Math.max(0, subtotal - discountAmount));
  const effectiveCouponCode = orderRecord?.coupon_code ? String(orderRecord.coupon_code) : eventPayload.couponCode;

  // Atomic paid-claim (H1): exactly one webhook event may flip a not-yet-paid
  // order to "paid" and therefore run the paid side-effects below. A concurrent
  // SECOND distinct success event (different event_id, so not caught by the
  // event-claim dedup) updates zero rows here and skips the side-effects,
  // preventing double commission / points / coupon redemption / confirmation
  // email / inventory decrement / 3PL transmit. Mirrors finalizeManualPayment.
  let wonPaidClaim = false;
  if (nextStatus === "paid") {
    if (!orderRecord) {
      wonPaidClaim = true; // first time we've seen this order
    } else {
      const nowIso = new Date().toISOString();
      const { data: claimed, error: claimError } = await supabaseAdmin
        .from("orders")
        .update({
          payment_status: "paid",
          fulfillment_status: "awaiting_fulfillment",
          paid_at: nowIso,
          payment_id: eventPayload.paymentId ?? orderRecord.payment_id ?? null,
          provider_event_id: eventId,
          updated_at: nowIso,
        })
        .eq("order_id", orderId)
        .neq("payment_status", "paid")
        .select("id");
      if (claimError) {
        throw claimError;
      }
      wonPaidClaim = Boolean(claimed && claimed.length > 0);
    }
  }

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
    fulfillmentStatus: nextStatus === "paid" ? "awaiting_fulfillment" : orderRecord?.fulfillment_status ?? "pending",
    paidAt: nextStatus === "paid" ? new Date().toISOString() : orderRecord?.paid_at ?? null,
    providerEventId: eventId,
    items: eventPayload.items,
  });

  await upsertOrderItems(orderId, eventPayload.items);

  if (nextStatus === "paid") {
    // Commission recording must never strand a paid order or block the
    // customer's confirmation email / points below (e.g. a schema mismatch on
    // the commissions table). Best-effort: log and continue.
    try {
      await ensureCommissionRecord({
        orderId,
        ambassadorId: eventPayload.ambassadorId,
        referralCode: eventPayload.referralCode,
        commissionPercent: eventPayload.commissionPercent,
        commissionableSubtotal,
        qualifyingSubtotal: subtotal,
        paymentStatus: nextStatus,
        providerEventId: eventId,
        customerEmail: eventPayload.customer?.email,
        shippingAddress: eventPayload.customer?.address,
        city: eventPayload.customer?.city,
        postalCode: eventPayload.customer?.postalCode,
      });
    } catch (commissionError) {
      console.error("Unable to record commission for order", orderId, commissionError);
    }

    await logCommerceAnalyticsEvent({
      eventType: "purchase",
      orderId,
      amountPaid,
      referralCode: eventPayload.referralCode,
      ambassadorId: eventPayload.ambassadorId,
    });

    if (wonPaidClaim && effectiveCouponCode) {
      await redeemCoupon(effectiveCouponCode);
    }

    if (wonPaidClaim && eventPayload.customer?.email) {
      try {
        await markAbandonedCartsRecovered(eventPayload.customer.email, orderId);
      } catch (recoveryError) {
        console.error("Unable to mark abandoned carts recovered for order", orderId, recoveryError);
      }
    }

    const customerUserId = eventPayload.customerUserId ?? orderRecord?.customer_user_id ?? null;
    if (wonPaidClaim && customerUserId) {
      try {
        const pointsRedeemed = Number(orderRecord?.points_redeemed ?? eventPayload.pointsRedeemed ?? 0);
        if (pointsRedeemed > 0) {
          await redeemPoints(customerUserId, pointsRedeemed, orderId);
        }

        const storeCreditRedeemedCents = Number(orderRecord?.store_credit_redeemed_cents ?? 0);
        if (storeCreditRedeemedCents > 0) {
          await redeemStoreCredit(customerUserId, storeCreditRedeemedCents, orderId);
        }

        const pointsRate = await getActivePointsPerDollar(customerUserId);
        const { multiplier } = await getActivePointsMultiplier();
        const pointsEarned = calculateEarnedPoints(commissionableSubtotal, pointsRate, multiplier);

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

    if (wonPaidClaim && eventPayload.customer?.email) {
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

    // Commit stock exactly once, on the first paid transition. Membership
    // orders are digital and hold no inventory, so they are skipped.
    const isMembershipOrder = String(orderRecord?.order_type ?? "product") === "membership";
    if (wonPaidClaim && !isMembershipOrder) {
      await decrementInventoryForOrder(
        (eventPayload.items ?? []).map((item) => ({ product_id: item.productId, quantity: item.quantity })),
      );
    }

    // Auto-transmit newly-paid card orders to the 3PL (best-effort).
    if (wonPaidClaim) {
      await transmitOrderToFulfillment(orderId);
    }
  }

  if (nextStatus === "refunded" || nextStatus === "canceled" || nextStatus === "payment_failed") {
    await updateCommissionOnRefund(orderId);

    // Return committed stock — but ONLY when this order was actually paid (so
    // its inventory was decremented). A refund/cancel of an order that never
    // reached "paid" (e.g. payment_failed) must not conjure phantom units, and
    // a replayed refund event finds the status already terminal and skips.
    const wasPaid = priorPaymentStatus === "paid";
    if (wasPaid && (nextStatus === "refunded" || nextStatus === "canceled")) {
      const isMembershipOrder = String(orderRecord?.order_type ?? "product") === "membership";
      if (!isMembershipOrder) {
        const { data: refundItems } = await supabaseAdmin
          .from("order_items")
          .select("product_id, quantity")
          .eq("order_id", orderId);
        await restockInventoryForOrder(
          (refundItems ?? []) as Array<{ product_id?: string | null; quantity?: number | null }>,
        );
      }
    }

    if (nextStatus === "refunded") {
      // Record the refund amount/time so the admin refund path (which guards on
      // refund_amount / payment_status) sees this order as already refunded and
      // can't double-restock or double-reverse. Best-effort: never block.
      try {
        await supabaseAdmin
          .from("orders")
          .update({ refund_amount: amountPaid, refunded_at: new Date().toISOString(), updated_at: new Date().toISOString() })
          .eq("order_id", orderId);
      } catch (refundAmountError) {
        console.error("Unable to record refund amount for order", orderId, refundAmountError);
      }
      try {
        await reverseOrderPoints(orderId);
      } catch (pointsError) {
        console.error("Unable to reverse membership points for order", orderId, pointsError);
      }
      try {
        await restoreRedeemedPoints(orderId);
      } catch (restoreError) {
        console.error("Unable to restore redeemed points for order", orderId, restoreError);
      }
      try {
        await refundStoreCreditForOrder(orderId);
      } catch (creditError) {
        console.error("Unable to return store credit for order", orderId, creditError);
      }
      // A refunded/charged-back MEMBERSHIP order ends the membership immediately
      // so its benefits stop — otherwise a customer could buy a membership, get
      // it refunded, and keep member pricing/free shipping/points forever.
      try {
        const { data: refundedOrder } = await supabaseAdmin
          .from("orders")
          .select("order_type, customer_user_id")
          .eq("order_id", orderId)
          .maybeSingle();
        if (
          refundedOrder
          && String(refundedOrder.order_type ?? "product") === "membership"
          && refundedOrder.customer_user_id
        ) {
          await revokeMembershipForRefund(String(refundedOrder.customer_user_id));
        }
      } catch (membershipError) {
        console.error("Unable to revoke membership for refunded order", orderId, membershipError);
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
  } catch (processingError) {
    // Processing failed after the event was claimed. Release the claim so the
    // processor's retry can reprocess it instead of being skipped as a
    // duplicate, then rethrow so the caller returns a non-2xx and retries.
    await releaseEvent(eventId).catch(() => {});
    throw processingError;
  }
}
