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
 * IDEMPOTENT BY CONSTRUCTION, AND UNDER TRUE CONCURRENCY BY THE DATABASE.
 *
 * Sequentially: the sweep looks for ABSENCE, so a second run over the same
 * window finds nothing to do, and `ensureCommissionRecord` refuses to regress
 * any row that has advanced past `pending`.
 *
 * Concurrently that is NOT enough, and the earlier wording here was wrong to
 * imply it was. `ensureCommissionRecord` is SELECT-then-INSERT: a live webhook
 * accruing for an order this sweep is mid-way through can have both readers see
 * no row and both take the INSERT branch. What stops that is not this file and
 * not the application at all — it is
 *
 *     referral_orders_order_id_key  UNIQUE (order_id)
 *
 * declared inline on the column in every create-table in src/lib/sql (and read
 * back off live Postgres — docs/FINAL-VERIFICATION-LOG.md). The loser's INSERT
 * is refused with 23505, so one conversion can only ever hold ONE commission
 * obligation, and `markCommissionsPaid` (which sums commission_amount across an
 * ambassador's approved rows) cannot pay it twice.
 *
 * DO NOT DROP THAT CONSTRAINT, and do not "optimise" the insert into an
 * unguarded write on the strength of the absence check alone. The loser's 23505
 * is a NORMAL, EXPECTED outcome here, not a failure: it is counted as
 * `converged` below, never as `failed`, so the critical alert keeps meaning
 * what it says.
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
  /** Orders that had no accrual and now have one, written by THIS run. */
  repaired: number;
  /**
   * Orders whose accrual was refused by referral_orders_order_id_key because a
   * concurrent writer (the live payment webhook, or another sweep) inserted it
   * between our absence check and our insert — CONFIRMED by re-reading the row.
   * The ambassador is credited exactly once; this run simply was not the writer.
   * Counted apart from `failed` so it never triggers the critical alert.
   */
  converged: number;
  /** Orders that had no accrual and still do not — the accrual failed again. */
  failed: number;
}

/** PostgREST hands back a plain object, not an Error. Pull the code off either. */
function errorCode(error: unknown): string | null {
  if (error && typeof error === "object" && "code" in error) {
    const code = (error as { code?: unknown }).code;
    return code == null ? null : String(code);
  }
  return null;
}

/**
 * The alert below tells an operator to read the error and, if it names a check
 * constraint, apply a specific migration. `String(error)` on a PostgREST error
 * object yields "[object Object]" — so every failure, including the 23514
 * backlog this alert exists for, arrived with its diagnosis erased. Keep the
 * code, message, details and hint.
 */
function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object") {
    const e = error as { code?: unknown; message?: unknown; details?: unknown; hint?: unknown };
    const parts = [e.code, e.message, e.details, e.hint]
      .filter((value) => value != null && String(value) !== "")
      .map(String);
    if (parts.length > 0) return parts.join(" | ");
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
  return String(error);
}

/**
 * Did somebody else accrue this order while we were working on it?
 *
 * Only ever true for a 23505, and only after POSITIVELY CONFIRMING the row is
 * there. If the confirming read fails we return false and the order is reported
 * as failed — the conservative direction, because the cost of a false "all
 * clear" here is an ambassador silently going unpaid.
 */
async function accrualLandedConcurrently(orderId: string, error: unknown): Promise<boolean> {
  if (errorCode(error) !== "23505") return false;

  const { data, error: readError } = await supabaseAdmin
    .from("referral_orders")
    .select("id")
    .eq("order_id", orderId)
    .limit(1);

  if (readError) return false;
  return (data ?? []).length > 0;
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

  const result: CommissionAccrualRepairResult = { scanned: 0, repaired: 0, converged: 0, failed: 0 };

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
    const orderId = String(order.order_id);
    try {
      await accrueCommissionForPaidOrder(order as Parameters<typeof accrueCommissionForPaidOrder>[0]);
      result.repaired += 1;
    } catch (error) {
      // A unique violation here is the DB doing its job: the live webhook (or
      // another sweep) inserted the row between our absence check and our
      // insert. The ambassador IS credited. Reporting that as `failed` fires a
      // critical "Ambassadors are not being credited" on every referred order
      // paid inside a sweep window, which trains the operator to ignore the one
      // alert that matters.
      if (await accrualLandedConcurrently(orderId, error)) {
        result.converged += 1;
        continue;
      }

      result.failed += 1;
      failures.push({ orderId, error: describeError(error) });
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
