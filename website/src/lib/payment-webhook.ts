import { randomUUID } from "crypto";
import { getPaymentProvider } from "@/lib/payment-provider";
import type { OrderStatus } from "@/lib/payment-types";
import { supabaseAdmin } from "@/lib/supabase-server";
import { sendEmail } from "@/lib/email/send";
import { sendOrderEmailOnce } from "@/lib/email/order-email-once";
import { enqueueFailedEmail } from "@/lib/email/retry-queue";
import { commissionEarnedTemplate, orderConfirmationTemplate, refundConfirmationTemplate } from "@/lib/email/templates";
import { getSiteUrl } from "@/lib/env";
import { redeemCoupon } from "@/lib/coupons";
import { calculateEarnedPoints, getActivePointsMultiplier, getActivePointsPerDollar, recordPointsLedgerEntry, redeemPoints, restoreRedeemedPoints, reverseOrderPoints } from "@/lib/membership";
import { redeemStoreCredit, refundStoreCreditForOrder } from "@/lib/store-credit";
import { detectCommissionFraudSignal, getEffectiveCommissionPercent } from "@/lib/ambassador-commission";
import { getAmbassadorProgramSettings } from "@/lib/ambassador-settings";
import { getReferralProgramConfig } from "@/lib/admin-control";
import { markAbandonedCartsRecovered } from "@/lib/cart-recovery";
import { decrementInventoryForOrder, restockInventoryForOrder, claimInventoryRestock } from "@/lib/inventory-fulfillment";
import { finalizeInventoryForOrder, releaseInventoryForOrder } from "@/lib/inventory-reservation";
import { after } from "next/server";
import { syncOrderToShippo } from "@/lib/shippo/order-sync";
import { resolveAmbassadorCustomerDiscount } from "@/lib/ambassador-discount";
import { activatePaidMembership, revokeMembershipForRefund } from "@/lib/membership-billing";
import {
  isMembershipEvent,
  handleMembershipEvent,
  type MembershipEventData,
} from "@/lib/membership-webhook";
import { recordSystemAlert } from "@/lib/monitoring";
import { getOrderAttribution } from "@/lib/order-attribution";
import { toAnalyticsAttribution } from "@/lib/attribution";

/**
 * The billing cycle to activate for a paid membership order.
 *
 * This used to be `String(cycle ?? "annual") === "monthly" ? "monthly" : "annual"`,
 * so a missing membership_cycle silently granted a ONE-YEAR term. Annual
 * activation also writes cancel_at_period_end = true (an annual pass does not
 * auto-renew), so a guessed cycle produced a member whose account page read
 * "set to cancel at the end of your period" immediately after paying.
 *
 * A missing cycle is a data fault, not an annual purchase. Default to the
 * cheaper, shorter, self-correcting option — monthly renews in 30 days, and a
 * wrong monthly costs the customer 30 days of benefits rather than 365 of ours.
 */
export function resolveMembershipCycle(raw: unknown, orderId: string): "monthly" | "annual" {
  const value = String(raw ?? "").trim().toLowerCase();
  if (value === "monthly" || value === "annual") return value;
  console.error(
    `[membership] order ${orderId} has no membership_cycle ("${String(raw)}") — defaulting to monthly rather than granting a year.`,
  );
  return "monthly";
}

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
    // VeyraGate remaps its internal `charge.*` to `payment.*` for merchants, but a
    // subscription that includes '*' surfaces the UNMAPPED internal name — and the
    // live endpoint for this store subscribes to both `charge.succeeded` and '*'.
    // Without these aliases a real successful charge falls to the default below and
    // the order is never marked paid.
    case "payment.succeeded":
    case "charge.succeeded":
      return "paid";
    // Veyra's quickstart lists the failure event as `payment_failed` (underscore)
    // while its drop-in script emits `payment.failed` (dot). Accept both rather
    // than bet on which one the webhook actually carries — guessing wrong means a
    // failed charge is recorded as nothing at all.
    case "payment.failed":
    case "payment_failed":
    case "charge.failed":
      return "payment_failed";
    case "payment.canceled":
    case "charge.canceled":
      return "canceled";
    case "refund.completed":
    case "charge.refunded":
      return "refunded";
    // Veyra names these `dispute.*`; the internal vocabulary here is `chargeback.*`.
    case "chargeback.created":
    case "chargeback.lost":
    case "dispute.created":
    case "dispute.lost":
      return "refunded";
    default:
      return "pending_payment";
  }
}

/**
 * Does this event type actually describe a money state we recognise?
 *
 * A '*' subscription delivers events that say nothing about an order's payment
 * state — `payout.paid`, `dispute.evidence_required`, and anything Veyra adds
 * later. getOrderStatusForEventType maps all of those to "pending_payment" via its
 * default, so without this check an unrecognised event could write "pending_payment"
 * over an order that is already PAID: the customer's money is taken and the order
 * reads unpaid. The existing demotion guard only covers payment_failed/canceled,
 * so it would not catch it.
 */
export function isRecognisedMoneyEvent(eventType: string): boolean {
  return getOrderStatusForEventType(eventType) !== "pending_payment";
}

export interface RefundOutcome {
  isRefundEvent: boolean;
  isChargeback: boolean;
  isFullRefund: boolean;
  /** The payment_status to persist (partially_refunded vs refunded vs passthrough). */
  paymentStatus: OrderStatus;
  /** Cumulative refund_amount to record (actual money returned, not gross). */
  recordedRefundAmount: number;
  /** Fraction of commission to reverse (1 = full). */
  refundedFraction: number;
  /** Restock the order's inventory only on a FULL reversal. */
  shouldRestock: boolean;
}

// Pure resolver for how a refund / chargeback / cancel event is recorded.
// Centralizes partial-vs-full detection so the webhook records the SAME way the
// admin refund path does: a partial refund keeps `partially_refunded` status and
// records only the amount actually returned (accumulated), not the full charge.
// Chargebacks are ALWAYS a full reversal — a partial `amount` on a chargeback
// must never leave residual commission or a `partially_refunded` status.
export function resolveRefundOutcome(input: {
  eventType: string;
  nextStatus: OrderStatus;
  refundEventAmount: number;
  amountPaid: number;
  merchandiseBase: number;
  existingRefundAmount: number;
}): RefundOutcome {
  const { eventType, nextStatus, amountPaid } = input;
  const merchandiseBase = Math.max(0, Number(input.merchandiseBase) || 0);
  const refundEventAmount = Number.isFinite(input.refundEventAmount) ? Math.max(0, input.refundEventAmount) : 0;
  const existingRefundAmount = Number.isFinite(input.existingRefundAmount) ? Math.max(0, input.existingRefundAmount) : 0;
  const isChargeback = eventType.startsWith("chargeback");
  const isRefundEvent = nextStatus === "refunded" || nextStatus === "canceled" || nextStatus === "payment_failed";

  if (!isRefundEvent) {
    return { isRefundEvent: false, isChargeback, isFullRefund: false, paymentStatus: nextStatus, recordedRefundAmount: existingRefundAmount, refundedFraction: 0, shouldRestock: false };
  }

  // Partial applies ONLY to a genuine refund.completed carrying a positive
  // amount below what was charged. Chargebacks / cancels / failures are full.
  const isPartial = nextStatus === "refunded" && !isChargeback && refundEventAmount > 0 && refundEventAmount < amountPaid;
  const isFullRefund = !isPartial;
  const paymentStatus: OrderStatus = isPartial ? "partially_refunded" : nextStatus;
  // Prorate on the CUMULATIVE amount refunded (prior partials + this event), not
  // just this event — otherwise a second partial refund overwrites the first and
  // the ambassador keeps commission on merchandise that was already refunded.
  // computeRetainedCommission recomputes retained = original * (1 - fraction)
  // from the original base each time, so this fraction must be cumulative.
  // Single partials are unchanged (existingRefundAmount is 0).
  const cumulativeRefundAmount = existingRefundAmount + refundEventAmount;
  const refundedFraction = isFullRefund ? 1 : merchandiseBase > 0 ? Math.min(1, cumulativeRefundAmount / merchandiseBase) : 1;
  // refund_amount is only meaningful for money returned (refunded / partial). A
  // cancel/failure of a paid order records no refund dollars.
  const recordedRefundAmount = nextStatus === "refunded"
    ? isFullRefund ? roundMoney(amountPaid) : roundMoney(Math.min(amountPaid, existingRefundAmount + refundEventAmount))
    : existingRefundAmount;

  return { isRefundEvent: true, isChargeback, isFullRefund, paymentStatus, recordedRefundAmount, refundedFraction, shouldRestock: isFullRefund };
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
    // Stamp the campaign this order came from onto the purchase event.
    //
    // These fields were hard-coded null, which meant a purchase row could never
    // be grouped by campaign the way every page_view already can — the funnel
    // ended one step before the only step that pays for itself. Reading the
    // link here (rather than recomputing anything) keeps the rule intact:
    // analytics observes commerce. `getOrderAttribution` never throws and
    // returns null for an organic order, so the fields simply stay null and no
    // sale is invented for an ad that had nothing to do with it.
    const attribution = await getOrderAttribution(input.orderId);
    const attributed = toAnalyticsAttribution(attribution);

    await supabaseAdmin.from("website_analytics_events").insert({
      event_type: input.eventType,
      page_path: "/checkout",
      page_url: null,
      referrer: null,
      session_id: `order:${input.orderId}`,
      visitor_id: attributed.visitor_id,
      user_agent: null,
      ip_address: null,
      country: null,
      city: null,
      device_type: null,
      utm_source: attributed.utm_source,
      utm_medium: attributed.utm_medium,
      utm_campaign: attributed.utm_campaign,
      event_payload: {
        orderId: input.orderId,
        amountPaid: input.amountPaid,
        referralCode: input.referralCode ?? null,
        ambassadorId: input.ambassadorId ?? null,
        // The browsing session that produced this order. `session_id` above
        // keeps its existing `order:<id>` convention so nothing reading that
        // column changes meaning; the real session travels here.
        attributionSessionId: attribution?.sessionId ?? null,
        attributionFirstSource: attribution?.first?.utmSource ?? null,
        attributionTtclid: attribution?.last?.ttclid ?? null,
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
    /**
     * VeyraGate's merchant envelope: `{ id, type, created_at, data: <charge> }`,
     * where the order id rides in `data.metadata.order_id` — there is no top-level
     * reference field. Read defensively (`data.object ?? data`) because the charge
     * object has been seen both nested and un-nested.
     */
    data?: {
      metadata?: { order_id?: string; veyragate_session_id?: string };
      object?: { metadata?: { order_id?: string; veyragate_session_id?: string } };
    };
  };
}

/**
 * The order id, wherever the sender put it.
 *
 * The internal/mock gateway sends a flat `orderId`. VeyraGate nests it at
 * `data.metadata.order_id` — which is exactly what LivePaymentProvider asks for
 * when it opens the session (`metadata: { order_id: input.orderId }`). Without
 * this, a real VeyraGate callback resolves to no order id at all, falls through
 * to a random `order-<uuid>`, matches nothing, and the customer's card is charged
 * while their order sits unpaid forever.
 */
export function resolveWebhookOrderId(eventPayload: {
  orderId?: string;
  data?: { metadata?: { order_id?: string }; object?: { metadata?: { order_id?: string } } };
}): string | null {
  return (
    eventPayload.orderId ??
    eventPayload.data?.metadata?.order_id ??
    eventPayload.data?.object?.metadata?.order_id ??
    null
  );
}

/**
 * The processor's own session id, when it sends one.
 *
 * Preferred over `metadata.order_id` for matching, because it is minted
 * server-side by the processor and echoed back — nothing a client ever touched.
 * Our own order row records it in `payment_id` at checkout, so the two can be
 * joined. `metadata.order_id` stays as the fallback for senders that don't
 * carry a session id (the internal/mock gateway) and for orders written before
 * payment_id was persisted.
 */
export function resolveWebhookSessionId(eventPayload: {
  data?: {
    metadata?: { veyragate_session_id?: string };
    object?: { metadata?: { veyragate_session_id?: string } };
  };
}): string | null {
  return (
    eventPayload.data?.metadata?.veyragate_session_id ??
    eventPayload.data?.object?.metadata?.veyragate_session_id ??
    null
  );
}

/** The order carrying this processor session id, if we wrote one. */
async function findOrderIdByPaymentId(paymentId: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin
    .from("orders")
    .select("order_id")
    .eq("payment_id", paymentId)
    .maybeSingle();
  if (error || !data) return null;
  return String(data.order_id);
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
    .select("id, order_id, order_number, order_type, membership_tier_id, membership_cycle, payment_status, fulfillment_status, payment_id, referral_code, ambassador_id, coupon_code, subtotal, shipping_amount, discount_amount, tax_amount, card_processing_fee, amount_paid, refund_amount, paid_at, customer_user_id, customer_email, customer_name, shipping_address, city, postal_code, points_redeemed, store_credit_redeemed_cents")
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

/**
 * Accrue the commission for an order that is ALREADY PAID, from the order row.
 *
 * The repair sweep's entry point (review finding 1). Both paid lanes derive the
 * accrual's two money inputs identically and from nothing but the order:
 *
 *   qualifyingSubtotal   = orders.subtotal                      (what checkout gated on)
 *   commissionableSubtotal = orders.subtotal - orders.discount_amount
 *
 * That is the whole reason a repair is possible without a new column or a new
 * migration: `orders` is already the durable record of what is owed, and has
 * been since checkout wrote it. A missing `referral_orders` row is therefore
 * always reconstructable, never lost.
 *
 * Eligibility is re-evaluated at repair time, not frozen at payment time — the
 * same defence-in-depth `ensureCommissionRecord` has always applied. An
 * ambassador deactivated between the payment and the repair accrues a row with
 * commission 0 and an ineligible_reason, which is the correct conservative
 * answer and is still strictly better than no row at all.
 */
export async function accrueCommissionForPaidOrder(order: {
  order_id: unknown;
  ambassador_id?: unknown;
  referral_code?: unknown;
  subtotal?: unknown;
  discount_amount?: unknown;
  customer_email?: unknown;
  shipping_address?: unknown;
  city?: unknown;
  postal_code?: unknown;
}): Promise<{ id: string } | null> {
  const subtotal = roundMoney(Number(order.subtotal ?? 0));
  const discountAmount = roundMoney(Number(order.discount_amount ?? 0));

  return ensureCommissionRecord({
    orderId: String(order.order_id),
    ambassadorId: order.ambassador_id ? String(order.ambassador_id) : undefined,
    referralCode: order.referral_code ? String(order.referral_code) : undefined,
    commissionableSubtotal: roundMoney(Math.max(0, subtotal - discountAmount)),
    qualifyingSubtotal: subtotal,
    paymentStatus: "paid",
    customerEmail: order.customer_email ? String(order.customer_email) : null,
    shippingAddress: order.shipping_address ? String(order.shipping_address) : null,
    city: order.city ? String(order.city) : null,
    postalCode: order.postal_code ? String(order.postal_code) : null,
  });
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
    supabaseAdmin.from("ambassadors").select("status, customer_discount_percent").eq("id", input.ambassadorId).maybeSingle(),
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

  // Snapshot the discount rate this code was giving customers WHEN THE ORDER WAS
  // PLACED. commission_percent is already frozen per row for the same reason:
  // raise an ambassador's rate next month and every historical commission would
  // otherwise appear to have been earned at the new number, and the recorded
  // discount would stop explaining the recorded total.
  //
  // Resolved with the same rule checkout uses -- override first, program default
  // when unset -- so the stored figure matches what the shopper actually got
  // rather than what the ambassador happens to be set to now.
  const customerDiscountPercent = resolveAmbassadorCustomerDiscount(
    ambassadorRow.data?.customer_discount_percent,
    referralProgram.discountPercent,
  );
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

  // The dollars the referral took off, derived from the two subtotals already
  // in hand: what checkout gated on, less what is commissionable. On the order
  // Block G+H drove through the browser that is 131.10 - 117.30 = 13.80, which
  // is the "Ambassador code EXPLICIT15 -$13.80" line the shopper actually saw.
  //
  // Clamped at zero. qualifyingSubtotal falls back to commissionableSubtotal, so
  // a caller passing a smaller one would otherwise produce a negative — and
  // referral_orders_customer_discount_check refuses that.
  const customerDiscountAmount = roundMoney(Math.max(0, qualifyingSubtotal - commissionableSubtotal));

  const basePayload = {
    order_id: input.orderId,
    ambassador_id: input.ambassadorId,
    referral_code: input.referralCode,
    commission_percent: commissionPercent,
    customer_discount_percent: customerDiscountPercent,
    commission_amount: commissionAmount,
    // NOT NULL in production, with no default, and never sent until now — so
    // EVERY accrual insert was refused with 23502 before it could even reach the
    // payment_status CHECK. Zero commissions exist in production as a result.
    // original_subtotal is the pre-discount merchandise subtotal, the same
    // number the minimum-qualifying-order check uses.
    original_subtotal: qualifyingSubtotal,
    customer_discount: customerDiscountAmount,
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
    // Defense in depth: NEVER regress a commission that has already advanced
    // beyond "pending" (approved for payout, paid, reversed, voided, or under
    // review) back to pending. Rewriting basePayload (payment_status:"pending")
    // over an already-paid commission would re-enter it into the payout pipeline
    // and pay the ambassador a second time. The per-order side-effects claim
    // upstream already prevents a replay from reaching here, but this guard makes
    // it impossible regardless of the caller.
    const existingStatus = String(existingCommission.payment_status ?? "pending").toLowerCase();
    if (existingStatus !== "pending") {
      return { id: existingCommission.id };
    }

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
        customer_discount_percent: customerDiscountPercent,
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
      customer_discount_percent: customerDiscountPercent,
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
  // "fulfilled" and never enter the shipping queue.
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

  // BEST-EFFORT, LIKE EVERY OTHER SIDE EFFECT ON THIS PATH (review finding 1).
  //
  // This used to be unguarded, and the claim above is single-use: the UPDATE
  // carries `.eq("payment_status", <what we read>)`, so once it lands a retry
  // matches zero rows and returns alreadyPaid. An accrual that threw therefore
  // took out everything BELOW it as well — analytics, coupon redemption,
  // abandoned-cart recovery, points earned and redeemed, the confirmation
  // email, membership activation and, worst of all, `finalizeInventoryForOrder`.
  // The customer paid, the units stayed on the shelf, and the store went on
  // selling stock it no longer had. None of it re-ran, ever.
  //
  // The commission itself is not dropped by catching here: repairMissingCommissionAccruals
  // re-derives it from the order row, which carries everything the accrual needs.
  try {
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
  } catch (commissionError) {
    console.error("Unable to record commission for manually approved order", orderId, commissionError);
  }

  try {
    await logCommerceAnalyticsEvent({
      eventType: "purchase",
      orderId,
      amountPaid,
      referralCode,
      ambassadorId,
    });
  } catch (analyticsError) {
    // Same reasoning: an analytics write is never worth an unfulfilled order.
    console.error("Unable to log purchase analytics for manually approved order", orderId, analyticsError);
  }

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
        tax: Number(order.tax_amount ?? 0),
        cardProcessingFee: Number(order.card_processing_fee ?? 0),
        total: amountPaid,
      });
      // Send-once + audited. Returns without sending if a confirmation for this
      // order is already recorded, which is what makes a replayed manual
      // approval safe independently of the caller's own guards.
      const emailResult = await sendOrderEmailOnce({
        orderId,
        kind: "order_confirmation",
        to: String(order.customer_email),
        template,
      });
      if (emailResult.attempted && !emailResult.sent) {
        console.error("Order confirmation email not sent for order", orderId, emailResult.error);
        // The (orderId, kind) pair lets the sweep close this send-once slot when
        // it delivers (C-02). Without it the retry succeeds, the log row stays
        // 'failed', and the next caller sends the customer a second receipt.
        await enqueueFailedEmail(
          { to: String(order.customer_email), subject: template.subject, html: template.html, text: template.text },
          emailResult.error,
          { orderId, kind: "order_confirmation" },
        );
      }
    } catch {
      // Confirmation email is best-effort; approval already succeeded.
    }
  }

  if (isMembershipOrder) {
    // Turn on the membership + perks now that payment is verified.
    try {
      if (order.customer_user_id && order.membership_tier_id) {
        const cycle = resolveMembershipCycle(order.membership_cycle, orderId);
        await activatePaidMembership(String(order.customer_user_id), String(order.membership_tier_id), cycle);
      }
    } catch (membershipError) {
      console.error("Unable to activate membership for order", orderId, membershipError);
    }
  } else {
    // Commit stock now that payment is verified. Finalize the reservation held
    // at checkout (permanent deduct); if no active hold exists (untracked item,
    // expired hold, or pre-migration order) fall back to the legacy atomic
    // decrement so tracked stock still moves. The atomic order claim above
    // guarantees this runs exactly once per order, so no double-decrement.
    const fin = await finalizeInventoryForOrder(orderId);
    if (fin.degraded || fin.finalized === 0) {
      await decrementInventoryForOrder(
        (order.order_items ?? []) as Array<{ product_id?: string | null; quantity?: number | null }>,
      );
    }
    // Same deferred push as the card path. An admin waiting on an approval
    // click deserves the same protection from a slow third party as a shopper
    // waiting on checkout.
    scheduleShippoSync(orderId);
  }

  // RECORD THAT THE PAID SIDE EFFECTS RAN (review finding 2).
  //
  // `paid_side_effects_at` is the vocabulary the two paid lanes share, and until
  // now only the card lane spoke it — it was written in exactly ONE place in the
  // repository, inside processPaymentWebhook. This lane runs the identical side
  // effects behind its own single-use claim (the conditional payment_status
  // flip) and left the latch NULL forever.
  //
  // Anything downstream asking "were this order's units decremented?" therefore
  // got "no" for every manually-paid order. returnInventoryForCancelledOrder
  // asks exactly that, and answered it by releasing a reservation that was
  // already finalized — a no-op — so cancelling a manually-paid order destroyed
  // its stock and reported "released".
  //
  // WRITTEN LAST, NOT AS PART OF THE CLAIM. The latch has to mean "the decrement
  // happened", not "the decrement was about to be attempted". Setting it up with
  // the paid-flip would mark stock as decremented before finalizeInventoryForOrder
  // ran, and a crash in between would let a later cancel restock units that were
  // never removed — inventing stock, which oversells. Failing the other way round
  // (latch NULL, stock already moved) merely repeats the old conservative
  // behaviour for one narrow window, and this codebase's stated rule for
  // inventory ambiguity is to never guess in the direction that invents units.
  const { error: latchError } = await supabaseAdmin
    .from("orders")
    .update({ paid_side_effects_at: new Date().toISOString() })
    .eq("order_id", orderId)
    .is("paid_side_effects_at", null);

  if (latchError) {
    // Never fails the approval — the payment is verified and the stock has
    // moved. But a cancel will now under-restock, so say so.
    console.error("Unable to record paid_side_effects_at for manual order", orderId, latchError);
  }

  return { orderId, alreadyPaid: false, status: "paid" };
}

/**
 * Push a paid order to Shippo once the response has been sent.
 *
 * after() throws if called outside a request scope, and processPaymentWebhook
 * is reachable from places that have none — the reconciliation sweep, a script,
 * a test. An uncaught throw there would fail the whole webhook over a
 * side-effect, which is precisely the failure mode this deferral exists to
 * prevent, so the throw is swallowed and the 30-minute sweep picks the order up
 * instead.
 */
function scheduleShippoSync(orderId: string): void {
  const run = async () => {
    try {
      await syncOrderToShippo(orderId);
    } catch (syncError) {
      console.error("Unable to sync order to Shippo", orderId, syncError);
    }
  };
  try {
    after(run);
  } catch {
    // No request scope. The sweep will handle it; never let this reach the
    // caller, who is in the middle of confirming a payment.
  }
}

export async function processPaymentWebhook(payload: string, signature: string, secret: string, eventId: string) {
  const provider = getPaymentProvider();
  const isValid = provider.verifyWebhookSignature(payload, signature, secret);
  if (!isValid) {
    throw new Error("Invalid webhook signature");
  }

  const eventPayload = normalizeOrderPayload(payload);

  // ── Membership lifecycle events ───────────────────────────────────────────
  // These describe a SUBSCRIPTION, not an order, so they must not fall through
  // to the order pipeline below: it would resolve no order, synthesise a random
  // order id, and return early having recorded nothing. That silent drop is why
  // a Veyra-billed renewal never advanced next_billing_at, leaving the member
  // to lose access ~3 days later while still being charged.
  //
  // Claimed through the SAME payment_events path as order events, so a
  // duplicate delivery cannot double-apply a renewal.
  const rawEventType = (eventPayload.type ?? "").trim();
  if (isMembershipEvent(rawEventType)) {
    // `data` is typed here for the ORDER envelope (metadata/object); a membership
    // event carries a different, non-overlapping projection on the same field.
    const membershipData = (eventPayload.data ?? {}) as unknown as MembershipEventData;
    // event_id is the unique key; the membership id occupies order_id purely as
    // a human-readable scope for the claim row.
    const claimKey = `membership-${(membershipData.membership_id ?? "unknown").slice(0, 64)}`;
    const claimedMembershipEvent = await claimEvent(eventId, claimKey, "pending_payment");
    if (!claimedMembershipEvent) {
      return { duplicate: true, eventId, membership: true, handled: false };
    }
    const outcome = await handleMembershipEvent(rawEventType, membershipData);
    await markEventProcessed(eventId, claimKey, "pending_payment");
    return { duplicate: false, eventId, membership: true, ...outcome };
  }

  // Match on the processor's own session id FIRST (server-minted, unspoofable,
  // and recorded on our order as payment_id), falling back to the order id in
  // metadata. Falls back to a synthetic id ONLY when no sender put one
  // anywhere, so the event is still recorded rather than lost — but it will
  // match no order, which is why these resolvers have to know every shape a
  // real sender uses.
  const sessionId = resolveWebhookSessionId(eventPayload);
  const orderIdFromSession = sessionId ? await findOrderIdByPaymentId(sessionId) : null;
  const orderId = orderIdFromSession ?? resolveWebhookOrderId(eventPayload) ?? `order-${randomUUID()}`;
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

  // An event that says nothing about a money state must never write one. A '*'
  // subscription delivers plenty of those (payout.paid,
  // dispute.evidence_required, whatever the processor adds next), and
  // getOrderStatusForEventType maps every one of them to "pending_payment" via
  // its default — which the upsert below would then write over a real order.
  // The demotion guard further down only covers payment_failed/canceled, so it
  // does not catch this.
  if (orderRecord && !isRecognisedMoneyEvent(eventPayload.type ?? "")) {
    const existingStatus = (orderRecord.payment_status ?? "pending_payment") as OrderStatus;
    await markEventProcessed(eventId, orderId, existingStatus);
    return {
      duplicate: false,
      eventId,
      orderId,
      status: existingStatus,
      providerStatus: eventPayload.status ?? eventPayload.type ?? "unknown",
    } satisfies WebhookEventState;
  }

  // Refund/cancel are terminal money states. A late or replayed
  // `payment.succeeded` (arriving with a fresh event_id after a refund) must
  // NOT flip the order back to "paid" and re-award commissions, points,
  // coupons and the confirmation email. Record the event
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
  // "pending_payment" is included because it is what getOrderStatusForEventType
  // returns for ANY event it does not recognise — and a '*' subscription delivers
  // plenty of those (payout.paid, dispute.evidence_required, anything added later).
  // Without it, an unrelated notification demotes a paid order to unpaid: the money
  // is taken and the order says otherwise.
  if (
    priorPaymentStatus === "paid" &&
    (nextStatus === "payment_failed" || nextStatus === "canceled" || nextStatus === "pending_payment")
  ) {
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
  // store-credit reversal). Only short-circuit when the order is already FULLY
  // terminal (refunded/canceled) — a "partially_refunded" order must still let a
  // subsequent FULL refund event through to complete the restock + reversal.
  const FULLY_TERMINAL_REFUND_STATES = new Set(["refunded", "canceled"]);
  if (
    (nextStatus === "refunded" || nextStatus === "canceled" || nextStatus === "payment_failed") &&
    priorPaymentStatus &&
    FULLY_TERMINAL_REFUND_STATES.has(priorPaymentStatus)
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

  // Resolve how this refund/chargeback/cancel is recorded (partial vs full,
  // status to persist, cumulative refund amount, commission fraction, restock).
  // No-op for non-refund events. Mirrors the admin refund path's correctness.
  const refundOutcome = resolveRefundOutcome({
    eventType: eventPayload.type ?? "",
    nextStatus,
    refundEventAmount: Number(eventPayload.amount ?? 0),
    amountPaid,
    merchandiseBase: commissionableSubtotal,
    existingRefundAmount: roundMoney(Number(orderRecord?.refund_amount ?? 0)),
  });

  // Atomic paid-claim (H1): exactly one webhook event may flip a not-yet-paid
  // order to "paid" and therefore run the paid side-effects below. A concurrent
  // SECOND distinct success event (different event_id, so not caught by the
  // event-claim dedup) updates zero rows here and skips the side-effects,
  // preventing double commission / points / coupon redemption / confirmation
  // email / inventory decrement. Mirrors finalizeManualPayment.
  // Atomic paid-flip: exactly one delivery flips a not-yet-paid EXISTING order
  // to paid. It sets fulfillment_status/paid_at ONLY on this first transition
  // (via .neq("payment_status","paid")), so a duplicate delivery — or a later
  // "shipped" fulfillment state — is never reverted.
  if (nextStatus === "paid" && orderRecord) {
    // Amount assertion. The money HAS moved, so we never refuse to record it —
    // an unrecorded real charge is strictly worse than a flagged one. But an
    // amount that disagrees with what checkout computed means something is
    // wrong upstream, so the order is held OUT of fulfilment (fulfillment_status
    // stays "pending" instead of advancing to "awaiting_fulfillment") and an
    // operator is alerted rather than the parcel shipping on a bad number.
    const eventAmount = roundMoney(Number(eventPayload.amount ?? 0));
    const recordedAmount = roundMoney(Number(orderRecord.amount_paid ?? 0));
    const amountDisagrees = eventAmount > 0 && recordedAmount > 0 && Math.abs(eventAmount - recordedAmount) > 0.01;

    const nowIso = new Date().toISOString();
    const { error: flipError } = await supabaseAdmin
      .from("orders")
      .update({
        payment_status: "paid",
        fulfillment_status: amountDisagrees ? "pending" : "awaiting_fulfillment",
        paid_at: nowIso,
        payment_id: eventPayload.paymentId ?? orderRecord.payment_id ?? null,
        provider_event_id: eventId,
        updated_at: nowIso,
      })
      .eq("order_id", orderId)
      .neq("payment_status", "paid");
    if (flipError) {
      throw flipError;
    }

    if (amountDisagrees) {
      await recordSystemAlert({
        type: "payment_amount_mismatch",
        severity: "critical",
        message: `Order ${orderId} was paid for $${eventAmount.toFixed(2)} but checkout recorded $${recordedAmount.toFixed(2)}. The order is marked paid and held out of fulfilment pending review.`,
        context: { order_id: orderId, event_amount: eventAmount, recorded_amount: recordedAmount, event_id: eventId },
      });
    }
  }

  // Persist order DATA fields. For an EXISTING paid order the data is already
  // authoritative from checkout and the flip above owns the status transition,
  // so we do NOT re-upsert it — that previously clobbered a later
  // fulfillment_status ("shipped") back to "awaiting_fulfillment" on a duplicate
  // paid delivery. Only a brand-new webhook-created order, or a non-paid status
  // change (refund/cancel/failed), needs the upsert.
  if (!orderRecord || nextStatus !== "paid") {
    await upsertOrderRecord({
      orderId,
      // EVERY field below falls back to the stored row, and that is the whole
      // point of this block.
      //
      // A real processor's callback carries a charge, not a shopper: it has no
      // top-level `customer`. Only our own mock gateway populates one, and it
      // does so by reading these very columns back out of the database — which
      // is exactly why this never showed up in testing. Against a live webhook
      // the identity fields arrived undefined, basePayload turned each one into
      // `?? null`, and this UPDATE wiped the customer's email, name and address
      // off a real order.
      //
      // It fires on any NON-paid event, so the trigger is routine: a first-
      // attempt card decline, or a refund/chargeback on a completed order. The
      // consequences are silent and expensive — no confirmation email (the
      // receipt is gated on the email), no ambassador commission, no coupon
      // redemption, a Shippo label with an empty address, and an /admin row with
      // no idea who bought it.
      //
      // customerUserId and pointsRedeemed already had this fallback; the
      // identity fields simply never got it.
      paymentId: eventPayload.paymentId ?? orderRecord?.payment_id ?? undefined,
      customerEmail: eventPayload.customer?.email ?? orderRecord?.customer_email ?? undefined,
      customerName: eventPayload.customer?.fullName ?? orderRecord?.customer_name ?? undefined,
      shippingAddress: eventPayload.customer?.address ?? orderRecord?.shipping_address ?? undefined,
      city: eventPayload.customer?.city ?? orderRecord?.city ?? undefined,
      postalCode: eventPayload.customer?.postalCode ?? orderRecord?.postal_code ?? undefined,
      currency: eventPayload.currency ?? "USD",
      subtotal,
      shippingAmount,
      discountAmount,
      amountPaid,
      referralCode: eventPayload.referralCode ?? orderRecord?.referral_code ?? undefined,
      ambassadorId: eventPayload.ambassadorId ?? orderRecord?.ambassador_id ?? undefined,
      couponCode: eventPayload.couponCode ?? orderRecord?.coupon_code ?? undefined,
      customerUserId: eventPayload.customerUserId ?? orderRecord?.customer_user_id ?? undefined,
      pointsRedeemed: eventPayload.pointsRedeemed ?? orderRecord?.points_redeemed ?? 0,
      paymentStatus: refundOutcome.paymentStatus,
      fulfillmentStatus: nextStatus === "paid" ? "awaiting_fulfillment" : orderRecord?.fulfillment_status ?? "pending",
      paidAt: nextStatus === "paid" ? new Date().toISOString() : orderRecord?.paid_at ?? null,
      providerEventId: eventId,
      items: eventPayload.items,
    });
    await upsertOrderItems(orderId, eventPayload.items);
  }

  if (nextStatus === "paid") {
    // Atomic, exactly-once claim for the paid SIDE-EFFECTS. Only ONE webhook
    // delivery wins the claim (paid_side_effects_at flips NULL -> now); a
    // concurrent, duplicate, or replayed delivery loses and skips every
    // side-effect below — so an ambassador is never paid twice, stock never
    // double-decrements, and no duplicate email/points. Because the claim is a
    // separate row-update from the paid-flip, a crash BETWEEN the flip and here
    // leaves it NULL, so a retry re-wins and completes the side-effects (no
    // silently-stranded paid order). Every effect below is best-effort so one
    // failure can't strand the rest.
    const { data: seClaim, error: seError } = await supabaseAdmin
      .from("orders")
      .update({ paid_side_effects_at: new Date().toISOString() })
      .eq("order_id", orderId)
      .is("paid_side_effects_at", null)
      .select("id");
    if (seError) {
      throw seError;
    }
    const runSideEffects = Boolean(seClaim && seClaim.length > 0);

    if (runSideEffects) {
      const isMembershipOrder = String(orderRecord?.order_type ?? "product") === "membership";

      // Ambassador commission — MUST be gated (an ungated replay reset a paid
      // commission back to pending and paid the ambassador twice).
      try {
        // Attribution is read from the AUTHORITATIVE order row (persisted at
        // checkout), not the provider's echoed webhook payload. A live card
        // processor may not echo our custom metadata back at the top level, and
        // relying on it silently dropped the ambassador's commission even though
        // orders.ambassador_id was correctly set. Fall back to the payload only
        // when the order row hasn't materialised yet (webhook-before-order).
        await ensureCommissionRecord({
          orderId,
          ambassadorId: orderRecord?.ambassador_id ?? eventPayload.ambassadorId,
          referralCode: orderRecord?.referral_code ?? eventPayload.referralCode,
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

      try {
        await logCommerceAnalyticsEvent({
          eventType: "purchase",
          orderId,
          amountPaid,
          referralCode: eventPayload.referralCode,
          ambassadorId: eventPayload.ambassadorId,
        });
      } catch (analyticsError) {
        console.error("Unable to log purchase analytics for order", orderId, analyticsError);
      }

      if (effectiveCouponCode) {
        try {
          await redeemCoupon(effectiveCouponCode);
        } catch (couponError) {
          console.error("Unable to redeem coupon for order", orderId, couponError);
        }
      }

      // Resolve the buyer's email from the DB order row when the processor's
      // callback doesn't echo it back (a real card processor often omits our
      // custom metadata) — otherwise a paid customer keeps getting "you left
      // items in your cart" emails and no receipt.
      const buyerEmail = eventPayload.customer?.email
        ?? (orderRecord?.customer_email ? String(orderRecord.customer_email) : null);

      if (buyerEmail) {
        try {
          await markAbandonedCartsRecovered(buyerEmail, orderId);
        } catch (recoveryError) {
          console.error("Unable to mark abandoned carts recovered for order", orderId, recoveryError);
        }
      }

      const customerUserId = eventPayload.customerUserId ?? orderRecord?.customer_user_id ?? null;
      // Memberships are a digital purchase: no loyalty points earned or redeemed
      // (matches the manual-approval path).
      if (customerUserId && !isMembershipOrder) {
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

      if (buyerEmail) {
        try {
          // Prefer the authoritative DB line items (persisted at checkout); a
          // live processor's callback may omit cart items, which would render an
          // empty receipt. Fall back to the echoed payload only when the DB has
          // none (webhook-before-order).
          let emailItems = (eventPayload.items ?? []).map((item) => ({
            name: item.productName ?? item.productId ?? "Item",
            quantity: item.quantity ?? 0,
            lineTotal: roundMoney(item.lineTotal ?? 0),
          }));
          try {
            const { data: dbItems } = await supabaseAdmin
              .from("order_items")
              .select("product_name, product_id, quantity, line_total")
              .eq("order_id", orderId);
            if (dbItems && dbItems.length > 0) {
              emailItems = dbItems.map((item) => ({
                name: (item.product_name as string | null) ?? (item.product_id as string | null) ?? "Item",
                quantity: Number(item.quantity ?? 0),
                lineTotal: roundMoney(Number(item.line_total ?? 0)),
              }));
            }
          } catch {
            // Fall back to the payload items already assigned above.
          }
          const template = orderConfirmationTemplate({
            customerName: eventPayload.customer?.fullName ?? String(orderRecord?.customer_name ?? ""),
            // Show the friendly VL-XXXX order number, not the internal UUID.
            orderId: orderRecord?.order_number ? String(orderRecord.order_number) : orderId,
            items: emailItems,
            subtotal,
            shipping: shippingAmount,
            discount: discountAmount,
            tax: Number(orderRecord?.tax_amount ?? 0),
            cardProcessingFee: Number(orderRecord?.card_processing_fee ?? 0),
            total: amountPaid,
          });
          // Send-once + audited. The paid_side_effects_at claim above already
          // stops a duplicate delivery reaching this line; this is the second,
          // independent guarantee, enforced by a unique index rather than by
          // this function remembering to check.
          const emailResult = await sendOrderEmailOnce({
            orderId,
            kind: "order_confirmation",
            to: buyerEmail,
            template,
          });
          if (emailResult.attempted && !emailResult.sent) {
            // Never throw (order is already paid), but make a silent miss visible
            // and queue it for durable retry by the sweep.
            console.error("Order confirmation email not sent for order", orderId, emailResult.error);
            await enqueueFailedEmail(
              { to: buyerEmail, subject: template.subject, html: template.html, text: template.text },
              emailResult.error,
              { orderId, kind: "order_confirmation" },
            );
          }
        } catch (emailError) {
          console.error("Unable to send order confirmation email for order", orderId, emailError);
        }
      }

      // Turn on the membership + perks now that a card payment has cleared.
      if (isMembershipOrder && customerUserId && orderRecord?.membership_tier_id) {
        try {
          const cycle = resolveMembershipCycle(orderRecord.membership_cycle, orderId);
          await activatePaidMembership(String(customerUserId), String(orderRecord.membership_tier_id), cycle);
        } catch (membershipError) {
          console.error("Unable to activate membership for order", orderId, membershipError);
        }
      }

      // Commit stock exactly once. Read the line items from the DB order_items
      // (authoritative from checkout) so decrement and the refund restock use
      // the SAME source — a real processor's callback may omit cart items, which
      // would otherwise decrement nothing yet restock real units on refund.
      // Membership orders are digital and hold no inventory.
      if (!isMembershipOrder) {
        try {
          // Finalize the checkout reservation (permanent deduct). Fall back to
          // the legacy atomic decrement only when there's no active hold to
          // finalize (untracked item, expired hold, or pre-migration order).
          const fin = await finalizeInventoryForOrder(orderId);
          if (fin.degraded || fin.finalized === 0) {
            const { data: soldItems } = await supabaseAdmin
              .from("order_items")
              .select("product_id, quantity")
              .eq("order_id", orderId);
            await decrementInventoryForOrder(
              (soldItems ?? []) as Array<{ product_id?: string | null; quantity?: number | null }>,
            );
          }
        } catch (inventoryError) {
          console.error("Unable to decrement inventory for order", orderId, inventoryError);
        }
      }

      // Push the paid order into Shippo — AFTER the response is sent.
      //
      // This was originally awaited inline and broke checkout: a Shippo request
      // can take up to SHIPPO_REQUEST_TIMEOUT_MS (15s), which pushed the webhook
      // response past the payment provider's own timeout. The provider never got
      // its 200, so the shopper sat on "Processing…" for an order that had in
      // fact been paid — and whose confirmation email had already gone out a few
      // lines above.
      //
      // after() is the fix rather than simply deleting the call: the work still
      // runs immediately, so the order reaches Shippo within seconds of payment,
      // but it runs AFTER the response is flushed and therefore cannot delay it.
      // Deleting it entirely would have left the 30-minute cron as the only
      // route, which is not "automatic" by any useful definition.
      //
      // The 30-minute sweep remains as the safety net for the case where this
      // callback dies with the process.
      scheduleShippoSync(orderId);
    }
  }

  if (nextStatus === "refunded" || nextStatus === "canceled" || nextStatus === "payment_failed") {
    // Reverse only the PROPORTIONAL commission on a partial refund, prorated
    // against the MERCHANDISE base the commission is computed on (subtotal −
    // discount) — NOT the gross total. Prorating on gross (amount_paid, which
    // includes tax/shipping/card fee) wrongly claws back commission when a
    // shipping/tax-only amount is refunded. A refund at/above the merchandise
    // base is a full reversal. Cancels/failures also fully reverse.
    await updateCommissionOnRefund(orderId, { refundedFraction: refundOutcome.refundedFraction });

    // Release any still-active inventory hold. For a never-paid order (failed /
    // canceled) this returns the reserved units immediately; for a paid order
    // the hold was already finalized, so this no-ops and the restock below does
    // the work. Idempotent and best-effort.
    await releaseInventoryForOrder(orderId);

    // Return committed stock — but ONLY when this order was actually paid (so
    // its inventory was decremented). A refund/cancel of an order that never
    // reached "paid" (e.g. payment_failed) must not conjure phantom units, and
    // a replayed refund event finds the status already terminal and skips.
    // "partially_refunded" is a paid-derived state (a partial refund was already
    // issued on a paid order), so a later full refund/cancel must still restock.
    const wasPaid = priorPaymentStatus === "paid" || priorPaymentStatus === "partially_refunded";
    // Restock ONLY on a full reversal — a partial refund must not return the
    // whole order's stock. A later full refund/cancel still restocks (its own
    // atomic claim), because a partial leaves status "partially_refunded".
    if (wasPaid && refundOutcome.shouldRestock && (nextStatus === "refunded" || nextStatus === "canceled")) {
      const isMembershipOrder = String(orderRecord?.order_type ?? "product") === "membership";
      // Atomic exactly-once claim: only the FIRST refund/cancel event for this
      // order restocks; a concurrent chargeback or replayed event loses the
      // claim and skips, so stock is never returned twice.
      // Only the caller that WON the claim restocks. "already_claimed" means
      // somebody else returned these units; "unavailable" means the claim could
      // not be evaluated, and restocking blind could double-return them.
      if (!isMembershipOrder && await claimInventoryRestock(orderId) === "claimed") {
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
          .update({ refund_amount: refundOutcome.recordedRefundAmount, refunded_at: new Date().toISOString(), updated_at: new Date().toISOString() })
          .eq("order_id", orderId);
      } catch (refundAmountError) {
        console.error("Unable to record refund amount for order", orderId, refundAmountError);
      }
      // Notify the customer their refund was processed (processor-initiated
      // refunds previously sent nothing). Best-effort — never block webhook
      // processing; sendEmail queues/retries on failure.
      if (orderRecord?.customer_email) {
        try {
          const refundEmail = refundConfirmationTemplate({
            customerName: String(orderRecord.customer_name ?? ""),
            orderId: String(orderRecord.order_number ?? orderId),
            refundAmount: refundOutcome.recordedRefundAmount,
            isFullRefund: refundOutcome.isFullRefund,
          });
          await sendEmail({ to: String(orderRecord.customer_email), ...refundEmail });
        } catch (refundEmailError) {
          console.error("Unable to send refund confirmation email for order", orderId, refundEmailError);
        }
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
