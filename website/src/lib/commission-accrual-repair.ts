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
 * ACCRUALS ATTEMPTED per run. The sweep shares a 60-second window with a dozen
 * other jobs, so it takes a bite rather than the whole backlog; the next run
 * takes the next bite, oldest first.
 *
 * THIS BOUNDS THE WORK, NOT THE SCAN. It used to be applied as `.limit(100)` on
 * the candidate SELECT while the "has no accrual" filter ran in JavaScript
 * afterwards, so 100 already-accrued orders at the oldest end of the window
 * filled the page on every tick and the 101st order — the one with a genuinely
 * missing commission — was never even read. That is MISSED COMMISSION: a real
 * obligation to a real person that is never created. The shipping sweep had the
 * same defect and the same fix (shipping-cost-repair.ts:123-183); the two are
 * deliberately the same shape now.
 */
const DEFAULT_LIMIT = 100;

/** Rows read per page of the candidate SELECT. The select is cheap and indexed. */
const CANDIDATE_PAGE_SIZE = 200;

/**
 * Ceiling on candidate rows READ per run, so scan cost cannot grow without
 * bound as the window fills. Reaching it is reported, never silent.
 */
const MAX_CANDIDATE_SCAN = 5000;

/** PostgREST puts the `.in()` list in the URL, so it is chunked like every other one. */
const IN_CHUNK = 200;

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
  /**
   * Orders found to be missing an accrual that this run did not get to, because
   * `limit` accruals had already been attempted. They are not lost: they sort
   * ahead of everything that arrives later, so the next tick starts with them.
   */
  deferred?: number;
  /**
   * The window held more candidates than MAX_CANDIDATE_SCAN, so this run did
   * not read all of them. Reported rather than silent: it is the ONE condition
   * under which the scan can fail to SEE an order with a missing commission.
   */
  scanTruncated?: boolean;
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

function round2(value: unknown): number {
  return Math.round(Number(value ?? 0) * 100) / 100;
}

/**
 * Did somebody else record this order's WHOLE obligation while we were working
 * on it?
 *
 * WHY "A ROW EXISTS" IS NOT THAT QUESTION. This classified on the error CODE
 * and then confirmed with "is there a referral_orders row for this order_id?",
 * which is TRIVIALLY TRUE WHEN THIS RUN WROTE IT. `ensureCommissionRecord`
 * performs two non-transactional writes:
 *
 *     referral_orders  insert   (the ledger the payout reads)
 *     commissions      upsert   (the mirror the profit report reads)
 *
 * If the ledger insert succeeds and the mirror upsert then raises 23505 —
 * commissions.order_id is unique too — the old check saw its OWN ledger row and
 * called it `converged`. Reproduced: ledger row present, mirror absent,
 * {scanned:1, repaired:0, converged:1, failed:0}, no alert. The ambassador is
 * paid from the ledger, the profit report never sees the expense, and the next
 * sweep is a no-op because it keys on the ledger row's ABSENCE. Permanent, and
 * the one alert that would have said so had been switched off.
 *
 * So the confirming read has to establish that the obligation is FULLY
 * RECORDED, on BOTH ledgers, FOR THIS AMBASSADOR, AT ONE AGREED AMOUNT.
 * Anything less is reported as `failed`, which alerts — the conservative
 * direction, because the cost of a false "all clear" here is an ambassador
 * silently going unpaid or an expense silently vanishing from profit.
 *
 * A commission_amount of 0 is NOT treated as absence: ensureCommissionRecord
 * legitimately writes 0 with an `ineligible_reason` (program off, commissions
 * paused, ambassador not active, under the minimum order). What must hold is
 * that the two ledgers AGREE about the number, whatever it is.
 */
async function accrualLandedConcurrently(
  order: { orderId: string; ambassadorId: string | null },
  error: unknown,
): Promise<{ converged: true } | { converged: false; reason: string }> {
  if (errorCode(error) !== "23505") return { converged: false, reason: describeError(error) };

  const [ledger, mirror] = await Promise.all([
    supabaseAdmin
      .from("referral_orders")
      .select("id, ambassador_id, commission_amount")
      .eq("order_id", order.orderId)
      .maybeSingle(),
    supabaseAdmin
      .from("commissions")
      .select("id, partner_id, commission_amount")
      .eq("order_id", order.orderId)
      .maybeSingle(),
  ]);

  // A read that FAILED is not a read that found nothing.
  if (ledger.error) return { converged: false, reason: `ledger confirm read failed: ${describeError(ledger.error)}` };
  if (mirror.error) return { converged: false, reason: `mirror confirm read failed: ${describeError(mirror.error)}` };

  if (!ledger.data) {
    return { converged: false, reason: "23505 raised but no referral_orders row exists for this order" };
  }
  if (!mirror.data) {
    // The exact half-written state described above.
    return {
      converged: false,
      reason: "referral_orders row present but the commissions mirror is MISSING — the payout ledger and the "
        + "profit report disagree about this order. Profit is overstated by this commission until it is written.",
    };
  }

  if (order.ambassadorId) {
    if (String(ledger.data.ambassador_id ?? "") !== order.ambassadorId) {
      return {
        converged: false,
        reason: `referral_orders row belongs to ambassador ${String(ledger.data.ambassador_id ?? "null")}, `
          + `not ${order.ambassadorId} — this order's obligation was not the one that landed`,
      };
    }
    if (String(mirror.data.partner_id ?? "") !== order.ambassadorId) {
      return {
        converged: false,
        reason: `commissions row belongs to partner ${String(mirror.data.partner_id ?? "null")}, `
          + `not ${order.ambassadorId}`,
      };
    }
  }

  const ledgerAmount = round2(ledger.data.commission_amount);
  const mirrorAmount = round2(mirror.data.commission_amount);
  if (ledgerAmount !== mirrorAmount) {
    return {
      converged: false,
      reason: `the two ledgers disagree about the money: referral_orders ${ledgerAmount.toFixed(2)} vs `
        + `commissions ${mirrorAmount.toFixed(2)}`,
    };
  }

  return { converged: true };
}

/**
 * Every paid, ambassador-carrying order in the window, oldest first, read in
 * cheap pages. `limit` deliberately does NOT appear here — see DEFAULT_LIMIT.
 */
async function collectCandidates(since: string): Promise<{
  rows: Array<Record<string, unknown>>;
  truncated: boolean;
}> {
  // A PAID ORDER WITH A NULL paid_at IS STILL A PAID ORDER.
  //
  // `.gte("paid_at", since)` alone never matches NULL, so such an order was
  // invisible to this sweep FOREVER — the ambassador's commission could never
  // be repaired at all, at any limit. The window is still bounded (an order
  // with no paid_at is admitted on its created_at instead) so the scan cannot
  // grow without end.
  const windowFilter = `paid_at.gte.${since},and(paid_at.is.null,created_at.gte.${since})`;

  const page = (offset: number) =>
    supabaseAdmin
      .from("orders")
      .select("order_id, subtotal, discount_amount, ambassador_id, referral_code, customer_email, shipping_address, city, postal_code, paid_at, created_at")
      .eq("payment_status", "paid")
      .not("ambassador_id", "is", null)
      .or(windowFilter)
      // Oldest first: a backlog is cleared in the order it accrued, so the
      // ambassador who has been waiting longest is paid first. NULL paid_at
      // sorts FIRST because those are precisely the rows that were starved.
      .order("paid_at", { ascending: true, nullsFirst: true })
      // order_id IS A TIEBREAK, NOT DECORATION. Orders paid in the same second
      // share a paid_at, and without a total order the page boundaries are not
      // stable, so offset paging could skip a row.
      .order("order_id", { ascending: true })
      .range(offset, offset + CANDIDATE_PAGE_SIZE - 1);

  const rows: Array<Record<string, unknown>> = [];
  let offset = 0;
  for (;;) {
    const { data, error } = await page(offset);
    // A sweep that cannot read is not a sweep that found nothing.
    if (error) throw error;
    const batch = (data ?? []) as Array<Record<string, unknown>>;
    rows.push(...batch);
    if (batch.length < CANDIDATE_PAGE_SIZE) return { rows, truncated: false };
    offset += CANDIDATE_PAGE_SIZE;
    if (offset >= MAX_CANDIDATE_SCAN) {
      // TRUNCATION IS A CLAIM ABOUT ROWS WE DID NOT READ, SO PROVE IT.
      const probe = await page(offset);
      if (probe.error) throw probe.error;
      return { rows, truncated: (probe.data ?? []).length > 0 };
    }
  }
}

/** Which of these order ids already carry a referral_orders row. */
async function accruedOrderIds(orderIds: string[]): Promise<Set<string>> {
  const accrued = new Set<string>();
  for (let i = 0; i < orderIds.length; i += IN_CHUNK) {
    const { data, error } = await supabaseAdmin
      .from("referral_orders")
      .select("order_id")
      .in("order_id", orderIds.slice(i, i + IN_CHUNK));
    if (error) throw error;
    for (const row of (data ?? []) as Array<{ order_id: unknown }>) {
      accrued.add(String(row.order_id));
    }
  }
  return accrued;
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

  const { rows: candidates, truncated } = await collectCandidates(since);
  result.scanned = candidates.length;
  if (truncated) result.scanTruncated = true;
  if (candidates.length === 0) return result;

  const accrued = await accruedOrderIds(candidates.map((order) => String(order.order_id)));
  const missing = candidates.filter((order) => !accrued.has(String(order.order_id)));
  if (missing.length === 0) return result;

  // `limit` bounds the ACCRUALS ATTEMPTED, applied AFTER the absence filter, so
  // a window full of already-accrued orders cannot hide a missing one.
  const toRepair = missing.slice(0, Math.max(0, limit));
  if (missing.length > toRepair.length) result.deferred = missing.length - toRepair.length;

  const failures: Array<{ orderId: string; error: string }> = [];

  for (const order of toRepair) {
    const orderId = String(order.order_id);
    const ambassadorId = order.ambassador_id == null ? null : String(order.ambassador_id);
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
      //
      // But ONLY when the whole obligation is confirmed on both ledgers — see
      // accrualLandedConcurrently. A 23505 from the commissions mirror after
      // the referral_orders insert has already committed is NOT convergence,
      // and it used to be counted as one.
      const outcome = await accrualLandedConcurrently({ orderId, ambassadorId }, error);
      if (outcome.converged) {
        result.converged += 1;
        continue;
      }

      result.failed += 1;
      failures.push({ orderId, error: `${describeError(error)} | not converged: ${outcome.reason}` });
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

  if (result.scanTruncated) {
    // The one condition under which this sweep can fail to SEE a missing
    // commission. Silent truncation is how the old `.limit()` scan hid the
    // backlog in the first place, so it is said out loud.
    await recordSystemAlert({
      type: "commission_accrual_scan_truncated",
      severity: "warning",
      message:
        `The commission-accrual sweep hit its ${MAX_CANDIDATE_SCAN}-row candidate ceiling with rows still unread. `
        + "Orders past the ceiling are not being checked for a missing commission this tick.",
      context: { scanned: result.scanned, maxCandidateScan: MAX_CANDIDATE_SCAN },
    }).catch((alertError) => {
      console.error("Unable to record a commission-accrual scan-truncation alert", alertError);
    });
  }

  return result;
}
