import "server-only";

import { supabaseAdmin } from "@/lib/supabase-server";
import { accrueCommissionForPaidOrder } from "@/lib/payment-webhook";
import { recordSystemAlert } from "@/lib/monitoring";
import { describeError } from "@/lib/operator-error";

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
 * AN OBLIGATION IS TWO ROWS, AND EITHER ONE MISSING IS A MISSING OBLIGATION.
 *
 * `ensureCommissionRecord` writes `referral_orders` (what the payout reads) and
 * `commissions` (what the profit report reads) as two separate, non-
 * transactional statements. The candidate set therefore keys on the absence of
 * EITHER, not just the ledger:
 *
 *   no referral_orders row  -> the accrual never ran      -> accrue it
 *   ledger but no mirror    -> the accrual half-committed -> mirror it
 *
 * The second used to be invisible here. The sweep alerted about it on the tick
 * that produced it and then never looked at the order again, because the row it
 * keyed on is exactly the row that exists. The ambassador is owed, the profit
 * report cannot see the expense, and `updateCommissionOnRefund` silently
 * updates zero mirror rows. See repairMissingMirror for why that half is
 * repaired FROM THE LEDGER rather than by re-accruing.
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
   * Orders whose payout ledger row was present but whose `commissions` mirror
   * was NOT, and whose mirror was written by THIS run from that ledger row.
   *
   * Counted apart from `repaired` because it is a different repair: nothing is
   * re-derived and the payout ledger is not touched. See repairMissingMirror.
   */
  mirrorRepaired?: number;
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
  return obligationFullyRecorded(order);
}

/**
 * Is this order's obligation FULLY RECORDED — on both ledgers, for this
 * ambassador, at one agreed amount?
 *
 * The one place that question is answered, used by BOTH outcomes that need it:
 * classifying a 23505 as convergence (above), and confirming that a mirror
 * repair actually landed (below). A repair that reported success without
 * passing this check would be the same false "all clear" the 23505 path used to
 * give, which is what let a half-written accrual sit unrepaired.
 */
async function obligationFullyRecorded(
  order: { orderId: string; ambassadorId: string | null },
): Promise<{ converged: true } | { converged: false; reason: string }> {
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

/** Which of these order ids already carry a `commissions` MIRROR row. */
async function mirroredOrderIds(orderIds: string[]): Promise<Set<string>> {
  const mirrored = new Set<string>();
  for (let i = 0; i < orderIds.length; i += IN_CHUNK) {
    const { data, error } = await supabaseAdmin
      .from("commissions")
      .select("order_id")
      .in("order_id", orderIds.slice(i, i + IN_CHUNK));
    if (error) throw error;
    for (const row of (data ?? []) as Array<{ order_id: unknown }>) {
      mirrored.add(String(row.order_id));
    }
  }
  return mirrored;
}

/**
 * REPAIR THE HALF-WRITTEN ACCRUAL: ledger row present, `commissions` mirror
 * absent.
 *
 * WHY THIS IS NOT "JUST RE-ACCRUE IT". `accrueCommissionForPaidOrder` →
 * `ensureCommissionRecord` RE-DERIVES the commission from today's eligibility
 * and rewrites the payout ledger. On this state that is wrong twice over:
 *
 *   - the obligation is ALREADY RECORDED and may already have been approved for
 *     payout or paid, and re-deriving it would restate money the ambassador has
 *     been told they are owed;
 *   - `ensureCommissionRecord` returns EARLY, writing nothing at all, for any
 *     ledger row that has advanced past `pending` — so for exactly the rows
 *     where restating would do the most damage it would also do nothing, and
 *     the sweep would report a repair that never happened.
 *
 * So the mirror is written FROM THE LEDGER ROW. The ledger is what the payout
 * reads and therefore what the ambassador is actually owed; copying it is the
 * only write that makes the two agree BY CONSTRUCTION rather than by hoping two
 * derivations match. `status` mirrors `payment_status` for the same reason: a
 * mirror stamped "pending" over a ledger row that is "paid" would leave the two
 * disagreeing about where in the payout lifecycle this obligation sits, and
 * `isEarnedCommission` reads the mirror's copy.
 *
 * THE FOREIGN KEY IS CHECKED BEFORE THE WRITE, not after. `commissions
 * .partner_id` is `not null references partners(id)`, so an ambassador with no
 * partners row makes this upsert raise 23503 — the very failure that produced
 * the half-written state in the first place. Refusing early leaves the state
 * exactly as it was, still visible to the next tick, and alerts with the
 * actionable reason.
 */
async function repairMissingMirror(
  order: { orderId: string; ambassadorId: string | null },
): Promise<{ repaired: true } | { repaired: false; converged: boolean; reason: string }> {
  const { data: ledger, error: ledgerError } = await supabaseAdmin
    .from("referral_orders")
    // ONE STRING LITERAL, not a concatenation: the typed client parses the
    // select list at the type level, and a `+` expression degrades the row type
    // to GenericStringError — every field access below would then be an error.
    .select("id, order_id, ambassador_id, referral_code, commission_percent, customer_discount_percent, commission_amount, payment_status, tier_name, ineligible_reason, fraud_flag, fraud_reason, created_at")
    .eq("order_id", order.orderId)
    .maybeSingle();

  // A read that FAILED is not a read that found nothing.
  if (ledgerError) return { repaired: false, converged: false, reason: `ledger read failed: ${describeError(ledgerError)}` };
  if (!ledger) {
    // It was there when the candidate set was built and is not there now.
    // Nothing to mirror; the next tick sees it as a missing accrual instead.
    return { repaired: false, converged: false, reason: "the referral_orders row disappeared between the scan and the repair" };
  }

  const ledgerAmbassadorId = ledger.ambassador_id == null ? null : String(ledger.ambassador_id);
  if (!ledgerAmbassadorId) {
    return {
      repaired: false,
      converged: false,
      reason: "the referral_orders row carries no ambassador_id, so commissions.partner_id (not null) cannot be written from it",
    };
  }
  if (order.ambassadorId && ledgerAmbassadorId !== order.ambassadorId) {
    return {
      repaired: false,
      converged: false,
      reason: `referral_orders row belongs to ambassador ${ledgerAmbassadorId}, not ${order.ambassadorId} — `
        + "the order and its recorded obligation disagree about who is owed",
    };
  }

  const { data: partner, error: partnerError } = await supabaseAdmin
    .from("partners")
    .select("id")
    .eq("id", ledgerAmbassadorId)
    .maybeSingle();
  if (partnerError) return { repaired: false, converged: false, reason: `partners read failed: ${describeError(partnerError)}` };
  if (!partner) {
    return {
      repaired: false,
      converged: false,
      reason: `ambassador ${ledgerAmbassadorId} has no partners row, so commissions.partner_id `
        + "(not null references partners(id)) would reject the mirror. Create the partners row and this repairs itself.",
    };
  }

  const now = new Date().toISOString();
  const { error: upsertError } = await supabaseAdmin
    .from("commissions")
    .upsert({
      order_id: String(ledger.order_id),
      partner_id: ledgerAmbassadorId,
      referral_code: ledger.referral_code ?? null,
      commission_percent: ledger.commission_percent ?? 0,
      customer_discount_percent: ledger.customer_discount_percent ?? 0,
      commission_amount: ledger.commission_amount ?? 0,
      // The mirror of referral_orders.payment_status — see the docblock.
      status: String(ledger.payment_status ?? "pending"),
      tier_name: ledger.tier_name ?? null,
      ineligible_reason: ledger.ineligible_reason ?? null,
      fraud_flag: ledger.fraud_flag ?? false,
      fraud_reason: ledger.fraud_reason ?? null,
      // The obligation's real age, not the age of the repair.
      created_at: ledger.created_at ?? now,
      updated_at: now,
    }, { onConflict: "order_id" });

  if (upsertError) {
    // A concurrent writer may have got there first. That is convergence only if
    // the whole obligation is now recorded and the two ledgers agree.
    const outcome = await obligationFullyRecorded({ orderId: order.orderId, ambassadorId: ledgerAmbassadorId });
    if (outcome.converged) return { repaired: false, converged: true, reason: "" };
    return { repaired: false, converged: false, reason: `${describeError(upsertError)} | not converged: ${outcome.reason}` };
  }

  // PROVE IT LANDED. A repair reported without confirming both ledgers is the
  // same false "all clear" this module exists to stop giving.
  const confirmed = await obligationFullyRecorded({ orderId: order.orderId, ambassadorId: ledgerAmbassadorId });
  if (!confirmed.converged) {
    return { repaired: false, converged: false, reason: `mirror written but not confirmed: ${confirmed.reason}` };
  }
  return { repaired: true };
}

/**
 * THE HOLD PERIOD STARTS WHEN THE ORDER WAS PAID, NOT WHEN THE SWEEP NOTICED.
 *
 * autoApproveEligibleCommissions gates on referral_orders.created_at, and the
 * live accrual writes created_at = now — correct on the webhook path, where now
 * IS the payment. When the accrual failed and this sweep wrote the row later,
 * the same rule measured the 30-day hold from the repair, so an ambassador
 * whose commission went missing for a week was paid a week late on top of it.
 *
 * The accrual itself lives in payment-webhook.ts and is shared with the live
 * path, so the age is corrected here, after the write, and only backwards: a
 * row can be made as old as its order, never younger. Both ledgers move so the
 * commissions mirror agrees (repairMissingMirror already copies created_at).
 * Best effort — the commission IS recorded; a failure here is a late payout,
 * not a lost one, and is logged.
 */
async function alignAccrualAgeToPaidAt(orderId: string, paidAt: unknown): Promise<void> {
  const paidAtMs = typeof paidAt === "string" ? Date.parse(paidAt) : NaN;
  if (!Number.isFinite(paidAtMs)) return;
  const paidAtIso = new Date(paidAtMs).toISOString();

  for (const table of ["referral_orders", "commissions"] as const) {
    try {
      const { error } = await supabaseAdmin
        .from(table)
        .update({ created_at: paidAtIso })
        .eq("order_id", orderId)
        .gt("created_at", paidAtIso);
      if (error) {
        console.error(`[commission-repair] could not align ${table}.created_at to paid_at for ${orderId}`, error);
      }
    } catch (error) {
      // Never fails the repair: the commission is recorded, and the sweep must
      // count it as such. A late payout is logged; a lost one would not be.
      console.error(`[commission-repair] could not align ${table}.created_at to paid_at for ${orderId}`, error);
    }
  }
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

  // A HALF-WRITTEN OBLIGATION IS A MISSING ONE. The candidate set used to key
  // on the LEDGER row's absence alone, so an order whose referral_orders row
  // committed and whose `commissions` mirror did not left the set permanently:
  // the sweep alerted about it on the tick that produced it and never looked at
  // it again. The ambassador is owed, the profit report cannot see the expense,
  // and `updateCommissionOnRefund` updates zero mirror rows. Both halves of the
  // obligation are checked here, and an order missing EITHER is repairable.
  const orderIds = candidates.map((order) => String(order.order_id));
  const [accrued, mirrored] = await Promise.all([accruedOrderIds(orderIds), mirroredOrderIds(orderIds)]);
  // ONE QUEUE, IN THE CANDIDATE ORDER, so `limit` is shared fairly between the
  // two kinds of repair and the oldest unmet obligation is always served first
  // — including under a stream of arrivals, where a per-class queue would let a
  // newly arrived missing accrual overtake a half-written row from weeks ago.
  const missing = candidates.filter(
    (order) => !accrued.has(String(order.order_id)) || !mirrored.has(String(order.order_id)),
  );
  if (missing.length === 0) return result;

  // `limit` bounds the ACCRUALS ATTEMPTED, applied AFTER the absence filter, so
  // a window full of already-accrued orders cannot hide a missing one.
  const toRepair = missing.slice(0, Math.max(0, limit));
  if (missing.length > toRepair.length) result.deferred = missing.length - toRepair.length;

  const failures: Array<{ orderId: string; error: string }> = [];

  for (const order of toRepair) {
    const orderId = String(order.order_id);
    const ambassadorId = order.ambassador_id == null ? null : String(order.ambassador_id);

    // The ledger row exists and only the mirror is missing: write the mirror
    // from the ledger. Never re-accrue — see repairMissingMirror.
    if (accrued.has(orderId)) {
      const outcome = await repairMissingMirror({ orderId, ambassadorId });
      if (outcome.repaired) {
        result.mirrorRepaired = (result.mirrorRepaired ?? 0) + 1;
      } else if (outcome.converged) {
        result.converged += 1;
      } else {
        result.failed += 1;
        failures.push({ orderId, error: `commissions mirror missing for a committed accrual: ${outcome.reason}` });
      }
      continue;
    }

    try {
      await accrueCommissionForPaidOrder(order as Parameters<typeof accrueCommissionForPaidOrder>[0]);
      await alignAccrualAgeToPaidAt(orderId, order.paid_at);
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
        `${failures.length} paid order(s) carry an ambassador whose commission is not fully recorded — the payout `
        + "ledger row, its profit-report mirror, or both — and repairing them failed. Ambassadors are not being "
        + "credited, or the commission expense is missing from profit. If this names a missing partners row, create "
        + "it and the sweep clears the backlog on its next run. If it names a check-constraint violation, apply "
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
