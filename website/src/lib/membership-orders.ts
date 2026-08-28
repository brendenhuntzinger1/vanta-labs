import "server-only";

import { randomUUID } from "crypto";
import { supabaseAdmin } from "@/lib/supabase-server";
import { recordSystemAlert } from "@/lib/monitoring";

// ---------------------------------------------------------------------------
// A MEMBERSHIP RENEWAL IS A SALE, SO IT HAS TO BE AN ORDER (VL-29 / VL-REV-01).
//
// Both renewal lanes — Veyra's `membership.renewed` webhook and our own billing
// sweep — recorded a `membership_billing_events` row and stopped there. Exactly
// ONE screen in this application reads that table (admin/membership's analytics
// tile). Every other money surface reads `orders`:
//
//   • /admin/revenue                (admin-revenue.ts)
//   • the dashboard + profit engine (admin-profit.ts, admin-dashboard-rollups.sql)
//   • analytics and the trend chart (admin-analytics.ts)
//   • the orders CSV export, the tax report, reconciliation
//
// So a member on $29/month was, to all of them, a customer who bought once and
// never came back. Recurring revenue — the whole point of the membership
// product — was invisible to the owner's actual reporting, and it got worse
// every month the store ran.
//
// This module writes the missing row, and it writes it the way the rest of the
// system already describes a membership sale (see membership-billing.ts's
// signup orders and payment-webhook.ts's paid transition):
//
//   order_type "membership"      — a sale, but never a fulfilment. ledger.ts is
//                                  explicit that a membership is revenue;
//                                  fulfillment queues filter it out by type.
//   payment_status "paid"        — the money was CAPTURED before we are called.
//   fulfillment_status "fulfilled" — digital, nothing ships, so it must not sit
//                                  in the pick queue forever.
//   amount_paid = what was CHARGED, not the tier's list price.
//
// IDEMPOTENCY IS THE CALLER'S PERIOD KEY, NOT A TIMESTAMP. `payment_id` carries
// a stable identifier for the PERIOD being billed, and production has a partial
// unique index on it (orders_payment_id_uniq, payment-order-integrity.sql). A
// redelivered webhook, a retried sweep, or two sweeps overlapping therefore
// resolve to the same row rather than booking the same $29 twice. Both a
// pre-check and the 23505 from that index are honoured, because the index is
// the only guard that survives a race and the pre-check is the only guard on a
// deployment that has not run the migration yet.
//
// NOTHING HERE THROWS. The member's access must never depend on a bookkeeping
// write: a renewal that charged the card and could not write its order is an
// alert for the operator, not a lapsed membership for the customer.
// ---------------------------------------------------------------------------

export interface MembershipRenewalOrderInput {
  userId: string;
  /** The tier renewed. Used for the order's tier column and the line item. */
  tierId: string | null;
  /** "monthly" | "annual" — anything else is treated as monthly (see below). */
  billingCycle: string | null;
  /** What the processor actually CAPTURED, in cents. */
  amountCents: number;
  /**
   * Stable identity for the period being billed — NOT for the delivery or the
   * attempt. `membership-renewal:<subscription or user>:<period>`, so every
   * retry of the same renewal collapses onto one order and next month's
   * renewal is still its own.
   */
  paymentId: string;
  /** Defaults to now. */
  paidAt?: string;
}

export interface MembershipRenewalOrderResult {
  recorded: boolean;
  orderId?: string;
  orderNumber?: string;
  reason?: "already_recorded" | "no_amount" | "write_failed";
}

interface TierSummary {
  id: string;
  slug: string | null;
  name: string | null;
}

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * "monthly" or "annual", defaulting to monthly.
 *
 * The same rule payment-webhook.resolveMembershipCycle applies, and for the
 * same reason: a missing cycle is a data fault, and guessing "annual" would
 * describe a $29 charge as a year's purchase on every report that reads it.
 */
function normalizeCycle(raw: string | null | undefined): "monthly" | "annual" {
  return String(raw ?? "").trim().toLowerCase() === "annual" ? "annual" : "monthly";
}

async function findTier(tierId: string | null): Promise<TierSummary | null> {
  if (!tierId) return null;
  const { data, error } = await supabaseAdmin
    .from("membership_tiers")
    .select("id, slug, name")
    .eq("id", tierId)
    .maybeSingle();
  if (error) return null;
  return (data as TierSummary | null) ?? null;
}

async function findContact(userId: string): Promise<{ email: string | null; name: string | null }> {
  try {
    const { data, error } = await supabaseAdmin.auth.admin.getUserById(userId);
    if (error || !data?.user?.email) return { email: null, name: null };
    const fullName = typeof data.user.user_metadata?.full_name === "string" ? data.user.user_metadata.full_name : "";
    return { email: data.user.email, name: fullName || data.user.email.split("@")[0] };
  } catch {
    // A contact we cannot read is a blank name on a report, not a reason to
    // lose the revenue row.
    return { email: null, name: null };
  }
}

async function existingOrderFor(paymentId: string): Promise<{ order_id: string; order_number: string | null } | null> {
  const { data, error } = await supabaseAdmin
    .from("orders")
    .select("order_id, order_number")
    .eq("payment_id", paymentId)
    .maybeSingle();
  if (error) return null;
  return (data as { order_id: string; order_number: string | null } | null) ?? null;
}

/**
 * Book a membership renewal charge as a paid order.
 *
 * Call this ONLY once the money is captured — a failed or pending renewal must
 * not appear on any revenue surface (M-03 is the same rule seen from the other
 * side: an order that never took payment must not report revenue or profit).
 */
export async function recordMembershipRenewalOrder(
  input: MembershipRenewalOrderInput,
): Promise<MembershipRenewalOrderResult> {
  const amountCents = Math.round(Number(input.amountCents) || 0);
  // A $0 "renewal" moved no money. Booking it would add a $0 order to the
  // count and drag average order value down with an empty denominator — the
  // same defect ledger.isSaleOrder exists to keep replacements out of.
  if (amountCents <= 0) return { recorded: false, reason: "no_amount" };

  const paymentId = input.paymentId.trim();
  if (!paymentId) return { recorded: false, reason: "write_failed" };

  try {
    const already = await existingOrderFor(paymentId);
    if (already) {
      return {
        recorded: false,
        reason: "already_recorded",
        orderId: already.order_id,
        orderNumber: already.order_number ?? undefined,
      };
    }

    const [tier, contact] = await Promise.all([findTier(input.tierId), findContact(input.userId)]);

    const cycle = normalizeCycle(input.billingCycle);
    const amount = roundMoney(amountCents / 100);
    const now = input.paidAt ?? new Date().toISOString();
    const orderId = `order-${randomUUID()}`;
    const orderNumber = `VL-${randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`;

    const { error } = await supabaseAdmin.from("orders").insert({
      order_id: orderId,
      order_number: orderNumber,
      payment_id: paymentId,
      order_type: "membership",
      membership_tier_id: input.tierId ?? null,
      membership_cycle: cycle,
      payment_method: "card",
      customer_email: contact.email,
      customer_name: contact.name,
      customer_user_id: input.userId,
      currency: "USD",
      subtotal: amount,
      shipping_amount: 0,
      handling_fee: 0,
      tax_amount: 0,
      discount_amount: 0,
      amount_paid: amount,
      payment_status: "paid",
      // Digital: nothing is picked, packed or posted. Same value the payment
      // webhook writes when a membership order is paid.
      fulfillment_status: "fulfilled",
      paid_at: now,
      created_at: now,
      updated_at: now,
    });

    if (error) {
      // The unique index did the deduplication for us — another delivery of the
      // same renewal won the race. That is success, not a failure to report.
      if ((error as { code?: string }).code === "23505") {
        return { recorded: false, reason: "already_recorded" };
      }
      throw error;
    }

    // A line item so the order reads like every other order on the admin screens
    // (and so the detail page is not an empty box). unit_cost_cents is a hard 0:
    // a membership has no product cost, which is also why admin-profit passes no
    // COGS lines for order_type "membership".
    const tierLabel = tier?.name ?? "Membership";
    await supabaseAdmin.from("order_items").insert({
      order_id: orderId,
      product_id: `membership:${tier?.slug ?? input.tierId ?? "unknown"}`,
      product_name: `${cycle === "annual" ? "Annual" : "Monthly"} Membership renewal — ${tierLabel}`,
      unit_price: amount,
      quantity: 1,
      line_total: amount,
      unit_cost_cents: 0,
    });

    return { recorded: true, orderId, orderNumber };
  } catch (error) {
    // Loud, but never fatal: the card was charged, so the membership must go on
    // regardless. An unrecorded renewal is money the reports cannot see, which
    // is exactly the defect this module exists to close — so it raises an alert
    // rather than disappearing into a log line.
    const message = error instanceof Error ? error.message : String((error as { message?: unknown })?.message ?? error);
    console.error(`[membership] could not record a renewal order for user ${input.userId}: ${message}`);
    await recordSystemAlert({
      type: "membership_renewal_order_not_recorded",
      severity: "critical",
      message:
        `A membership renewal of ${(amountCents / 100).toFixed(2)} USD for user ${input.userId} was charged, but its order row could not be written (${message}). `
        + "The money is real and the member keeps their benefits; every revenue surface is short by this amount until the row is added.",
      context: { userId: input.userId, tierId: input.tierId, amountCents, paymentId },
    }).catch(() => {});
    return { recorded: false, reason: "write_failed" };
  }
}
