import "server-only";

import { supabaseAdmin } from "@/lib/supabase-server";
import { accrueCommissionForPaidOrder } from "@/lib/payment-webhook";
import { recordSystemAlert } from "@/lib/monitoring";

/**
 * RE-DERIVE COMMISSIONS THAT WERE NEVER RECORDED (review finding 1, P0).
 *
 * THE DEFECT THIS EXISTS FOR. Both paid lanes take a single-use, exactly-once
 * claim and then accrue:
 *
 *   card    orders.paid_side_effects_at  NULL -> now   (processPaymentWebhook)
 *   manual  orders.payment_status        <read> -> paid (finalizeManualPayment)
 *
 * Once the claim lands the accrual gets exactly ONE attempt, and nothing
 * retries it. A webhook redelivery loses the claim and skips the side effects;
 * an admin's second approve returns alreadyPaid. So a single failed insert lost
 * an ambassador's commission permanently, and the only trace was a console line
 * in a serverless log. That is not a durable record of money owed to a real
 * person.
 *
 * WHY NO NEW COLUMN AND NO NEW MIGRATION. `orders` is ALREADY the durable
 * record. Checkout persists ambassador_id, referral_code, subtotal and
 * discount_amount before payment is ever attempted, and those four are exactly
 * what the accrual consumes. A paid order carrying an ambassador and having no
 * `referral_orders` row is, by construction, an accrual that never ran — and
 * everything needed to run it is still sitting on the order. Adding a
 * `commission_accrued_at` latch would have made recovery depend on the very
 * migration ordering that caused the loss.
 *
 * WHY A MISSING ROW IS AN UNAMBIGUOUS SIGNAL. `ensureCommissionRecord` writes a
 * row even when it declines to pay — commission_amount 0 with an
 * `ineligible_reason` — so "no row" never means "considered and refused". It
 * only ever means "never attempted, or attempted and failed". Both are ours to
 * fix.
 *
 * IDEMPOTENT BY CONSTRUCTION. The sweep looks for ABSENCE, so a second run over
 * the same window finds nothing to do. It does not need its own claim, and two
 * concurrent runs converge: `ensureCommissionRecord` refuses to regress any row
 * that has advanced past `pending`, and the worst case of a genuine race is one
 * redundant write of identical values.
 *
 * THIS ALSO REPAIRS THE PAST. Run against a database where the accrual has been
 * failing, it clears the whole backlog inside the window rather than only
 * protecting orders from here on.
 */

/** How far back a sweep looks. Bounded so the scan cost cannot grow forever. */
const DEFAULT_LOOKBACK_DAYS = 30;

/**
 * Orders examined per run. The sweep shares a 60-second window with a dozen
 * other jobs, so it takes a bite rather than the whole backlog; the next run
 * takes the next bite, oldest first.
 */
const DEFAULT_LIMIT = 100;

export interface CommissionAccrualRepairResult {
  /** Paid, ambassador-carrying orders inspected in the window. */
  scanned: number;
  /** Orders that had no accrual and now have one. */
  repaired: number;
  /** Orders that had no accrual and still do not — the accrual failed again. */
  failed: number;
}

export async function repairMissingCommissionAccruals(options?: {
  lookbackDays?: number;
  limit?: number;
  now?: Date;
}): Promise<CommissionAccrualRepairResult> {
  const now = options?.now ?? new Date();
  const lookbackDays = options?.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;
  const limit = options?.limit ?? DEFAULT_LIMIT;
  const since = new Date(now.getTime() - lookbackDays * 24 * 60 * 60 * 1000).toISOString();

  const result: CommissionAccrualRepairResult = { scanned: 0, repaired: 0, failed: 0 };

  // Oldest first: a backlog is cleared in the order it accrued, so the
  // ambassador who has been waiting longest is paid first.
  const { data: orders, error: ordersError } = await supabaseAdmin
    .from("orders")
    .select("order_id, subtotal, discount_amount, ambassador_id, referral_code, customer_email, shipping_address, city, postal_code")
    .eq("payment_status", "paid")
    .not("ambassador_id", "is", null)
    .gte("paid_at", since)
    .order("paid_at", { ascending: true })
    .limit(limit);

  if (ordersError) {
    // A sweep that cannot read is not a sweep that found nothing.
    throw ordersError;
  }

  const candidates = (orders ?? []) as Array<Record<string, unknown>>;
  result.scanned = candidates.length;
  if (candidates.length === 0) return result;

  const orderIds = candidates.map((order) => String(order.order_id));
  const { data: existing, error: existingError } = await supabaseAdmin
    .from("referral_orders")
    .select("order_id")
    .in("order_id", orderIds);

  if (existingError) {
    throw existingError;
  }

  const accrued = new Set((existing ?? []).map((row) => String((row as { order_id: unknown }).order_id)));
  const missing = candidates.filter((order) => !accrued.has(String(order.order_id)));
  if (missing.length === 0) return result;

  const failures: Array<{ orderId: string; error: string }> = [];

  for (const order of missing) {
    try {
      await accrueCommissionForPaidOrder(order as Parameters<typeof accrueCommissionForPaidOrder>[0]);
      result.repaired += 1;
    } catch (error) {
      result.failed += 1;
      failures.push({
        orderId: String(order.order_id),
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (failures.length > 0) {
    // The single most likely cause is the referral_orders payment_status CHECK
    // still refusing 'pending' because sql/referral-orders-commission-lifecycle.sql
    // has not been applied. Naming the orders makes the backlog recoverable by
    // hand if it ever comes to that.
    await recordSystemAlert({
      type: "commission_accrual_unrecovered",
      severity: "critical",
      message:
        `${failures.length} paid order(s) carry an ambassador but still have no commission, and re-accruing them failed. `
        + "Ambassadors are not being credited. If this names a check-constraint violation, apply "
        + "src/lib/sql/referral-orders-commission-lifecycle.sql — the sweep will clear the backlog on its next run.",
      context: { failures: failures.slice(0, 25), totalFailed: failures.length },
    }).catch((alertError) => {
      console.error("Unable to record a commission-accrual repair alert", alertError);
    });
  }

  return result;
}
