import "server-only";

import { supabaseAdmin } from "@/lib/supabase-server";
import { reverseOrderPoints, restoreRedeemedPoints } from "@/lib/membership";
import { refundStoreCreditForOrder, isRefundableRedemption, startOfCurrentMonthIso } from "@/lib/store-credit";
import { recordSystemAlert } from "@/lib/monitoring";

/**
 * COMPLETE THE SIDE-EFFECTS OF A REFUND THAT DID NOT FINISH.
 *
 * processPaymentWebhook runs four refund side-effects, each in its own
 * try/catch that logs to a serverless console and continues. The refund claim
 * is already spent by then, so a failure was permanent: revenue never reduced,
 * points never clawed back, store credit never returned.
 *
 * IDEMPOTENT BY CONSTRUCTION, TWICE OVER. The sweep selects on ABSENCE, and
 * each underlying function ALSO carries its own existing-row guard
 * (reverseOrderPoints and restoreRedeemedPoints on (order_id, reason);
 * refundStoreCreditForOrder on an already-refunded check). Two overlapping
 * sweeps therefore converge rather than double-crediting — which is exactly
 * why these four qualify for automatic repair and the other five do not.
 *
 * ONE SCAN, FOUR EFFECTS. All four are triggered by the same condition (this
 * order was refunded), so they share a single pass over refunded orders.
 */

const DEFAULT_LOOKBACK_DAYS = 90;

/**
 * How many ORDERS WITH WORK TO DO one run takes on. This bounds the WRITES, not
 * the reads — see collectRepairablePages for why that distinction is the whole
 * design.
 */
const DEFAULT_LIMIT = 50;

/** Rows read per page while scanning the window. */
const SCAN_PAGE_SIZE = 200;

/**
 * A ceiling on rows READ per run, so the scan cost cannot grow without bound as
 * the order table does. Sized far above any realistic count of refunded orders
 * in a 90-day window; reaching it is reported, never silent.
 */
const MAX_SCAN_ROWS = 5000;

export type RefundRepairEffect =
  | "refund_amount"
  | "points_reversal"
  | "points_restore"
  | "store_credit_refund";

export interface RefundRepairResult {
  /** Refunded orders READ from the window this run. */
  scanned: number;
  /** Effects that actually wrote something. */
  repaired: number;
  failed: number;
  /**
   * The window held more rows than MAX_SCAN_ROWS, so this run did not see all
   * of it. Surfaced rather than swallowed: it is the only condition under which
   * the scan can fail to reach a row that needs repair.
   */
  scanTruncated?: boolean;
}

export interface RefundCandidate {
  order_id: string;
  payment_status: string | null;
  refund_amount: number | null;
  points_earned: number | null;
  points_redeemed: number | null;
  store_credit_redeemed_cents: number | null;
  amount_paid: number | null;
  /**
   * NULL for a guest order. Both points effects write to a USER's ledger, so
   * with no user there is nothing either of them can ever do.
   */
  customer_user_id: string | null;
}

/** What the store-credit ledger says about one order, as the planner needs it. */
export interface RefundLedgerFacts {
  /**
   * At least one recorded redemption on this order is still refundable — see
   * isRefundableRedemption. Optional so a caller that only has the reason sets
   * keeps working; when it is omitted the planner assumes refundable.
   */
  storeCreditRefundable?: boolean;
}

/**
 * Refunded orders inside the lookback window — INCLUDING the ones with no
 * refunded_at at all.
 *
 * `refunded_at` IS NULLABLE, AND `>=` NEVER MATCHES NULL. That single fact made
 * the old `.gte("refunded_at", since)` blind to this sweep's PRIMARY case:
 * upsertOrderRecord writes payment_status = 'refunded' EARLY, while
 * refund_amount and refunded_at are written together LATER in a best-effort
 * update whose failure is swallowed. So the canonical "revenue was never
 * reduced" order — the exact order this sweep exists to repair — has
 * refunded_at IS NULL and was invisible to it.
 */
function refundedWindow(since: string) {
  return `refunded_at.gte.${since},refunded_at.is.null`;
}

/**
 * Which refund effects are still missing for one order.
 *
 * AN EFFECT IS ONLY PLANNED WHEN IT CAN ACTUALLY WRITE SOMETHING. This is not
 * an optimisation, it is the convergence rule. Every one of the four repair
 * functions returns quietly when there is nothing for it to do, so planning an
 * effect that will do nothing produces a sweep that plans it again on the next
 * tick, and the next, forever — while counting a "repair" each time. Three
 * distinct shapes of that bug live here, and each is closed by a condition
 * below:
 *
 *   - refund_amount   an order that took no money (`amount_paid <= 0`) has no
 *                     refund amount to record. The guarded UPDATE would match
 *                     0 -> 0 on every tick.
 *   - points          both points effects write to a USER's ledger, and
 *                     reverseOrderPoints / restoreRedeemedPoints return early
 *                     when the order has no customer_user_id. A guest order can
 *                     never have either applied.
 *   - store credit    refundStoreCreditForOrder declines a redemption that has
 *                     expired (spent in a prior month) and writes no row, so
 *                     the "no membership_redemption_refund row" condition stays
 *                     true forever.
 *
 * A repair that legitimately writes nothing is TERMINAL, not pending.
 */
export function planRefundRepairs(
  order: RefundCandidate,
  pointsLedgerReasons: Set<string>,
  storeCreditReasons: Set<string>,
  ledger?: RefundLedgerFacts,
): RefundRepairEffect[] {
  if (String(order.payment_status ?? "").toLowerCase() !== "refunded") return [];

  const planned: RefundRepairEffect[] = [];
  if (Number(order.amount_paid ?? 0) > 0 && Number(order.refund_amount ?? 0) <= 0) {
    planned.push("refund_amount");
  }
  const hasAccount = Boolean(order.customer_user_id);
  if (
    hasAccount
    && Number(order.points_earned ?? 0) > 0
    && !pointsLedgerReasons.has("order_refund_reversal")
  ) {
    planned.push("points_reversal");
  }
  if (
    hasAccount
    && Number(order.points_redeemed ?? 0) > 0
    && !pointsLedgerReasons.has("order_refund_points_restore")
  ) {
    planned.push("points_restore");
  }
  if (
    Number(order.store_credit_redeemed_cents ?? 0) > 0
    && (ledger?.storeCreditRefundable ?? true)
    && !storeCreditReasons.has("membership_redemption_refund")
  ) {
    planned.push("store_credit_refund");
  }
  return planned;
}

// ONE STRING LITERAL, DELIBERATELY: postgrest-js infers the row type from the
// literal, and a concatenated expression makes it give up and return
// GenericStringError[].
const COLUMNS =
  "order_id, payment_status, refund_amount, points_earned, points_redeemed, store_credit_redeemed_cents, amount_paid, customer_user_id";

/** Could this order need a ledger effect at all, before the ledgers are read? */
function mayNeedLedgerEffect(order: RefundCandidate): boolean {
  const points = Boolean(order.customer_user_id)
    && (Number(order.points_earned ?? 0) > 0 || Number(order.points_redeemed ?? 0) > 0);
  return points || Number(order.store_credit_redeemed_cents ?? 0) > 0;
}

function reasonsByOrder(rows: Array<{ order_id: unknown; reason: unknown }> | null) {
  const map = new Map<string, Set<string>>();
  for (const row of rows ?? []) {
    const key = String(row.order_id);
    if (!map.has(key)) map.set(key, new Set());
    map.get(key)!.add(String(row.reason));
  }
  return map;
}

interface PlannedOrder {
  order: RefundCandidate;
  effects: RefundRepairEffect[];
}

/**
 * WALK THE WINDOW UNTIL `limit` ORDERS THAT NEED WORK HAVE BEEN FOUND.
 *
 * WHY THIS IS NOT A SINGLE `.limit(n)` QUERY. Three of the four effects are
 * proven missing by the ABSENCE OF A ROW IN ANOTHER TABLE (points_ledger,
 * store_credit_ledger), and no predicate on `orders` can express that. The
 * previous shape — select the oldest N refunded orders, then decide in
 * JavaScript — made `limit` bound the rows READ rather than the rows to repair,
 * and the two are not interchangeable: fifty already-correct refunded orders at
 * the head of `ORDER BY updated_at ASC LIMIT 50` are returned again on every
 * tick, plan nothing, and the fifty-first order — the one whose points reversal
 * actually failed — is never selected. Not "eventually"; never. The narrowing
 * that was supposed to prevent that (`points_earned.gt.0,...`) is not changed
 * by any repair, so those rows never leave the set either.
 *
 * So the scan PAGES THROUGH THE WHOLE WINDOW and `limit` bounds the WRITES.
 * A page that yields no work costs one read and is left behind; the walk
 * continues until it has `limit` orders to repair, the window is exhausted, or
 * MAX_SCAN_ROWS is reached. Every row in the window is therefore reachable
 * within a single run, whatever sits in front of it.
 *
 * ORDERED BY updated_at, THEN order_id. Oldest neglect first, and the tiebreak
 * makes the page boundaries deterministic, so offset paging cannot skip or
 * repeat a row within a run. Candidates are collected BEFORE any repair runs,
 * so this run's own writes cannot shuffle the rows underneath its own scan.
 *
 * A CONCURRENT run can still move a row across a page boundary and cost this
 * run sight of it. That is a missed tick, not a missed repair: the row still
 * has its absence, and the next scan finds it. Nothing here is a claim, so two
 * runs never fight over one — every repair below is either a compare-and-set or
 * an insert guarded by an existing-row check.
 */
async function collectRepairablePages(input: {
  since: string;
  limit: number;
  monthStart: string;
}): Promise<{ planned: PlannedOrder[]; scanned: number; truncated: boolean }> {
  const planned: PlannedOrder[] = [];
  let scanned = 0;
  let offset = 0;
  let truncated = false;

  while (true) {
    const { data, error } = await supabaseAdmin
      .from("orders")
      .select(COLUMNS)
      .eq("payment_status", "refunded")
      .or(refundedWindow(input.since))
      .order("updated_at", { ascending: true })
      .order("order_id", { ascending: true })
      .range(offset, offset + SCAN_PAGE_SIZE - 1);

    // A sweep that cannot read is not a sweep that found nothing.
    if (error) throw error;

    const page = (data ?? []) as RefundCandidate[];
    scanned += page.length;

    // The ledgers are read once per page, and only for the orders on it that
    // could need a ledger effect at all.
    const needLedger = page.filter(mayNeedLedgerEffect).map((order) => order.order_id);
    let pointsByOrder = new Map<string, Set<string>>();
    let creditByOrder = new Map<string, Set<string>>();
    let refundableCredit = new Set<string>();
    if (needLedger.length > 0) {
      const [points, credit] = await Promise.all([
        supabaseAdmin.from("points_ledger").select("order_id, reason").in("order_id", needLedger),
        supabaseAdmin
          .from("store_credit_ledger")
          .select("order_id, reason, amount_cents, created_at")
          .in("order_id", needLedger),
      ]);
      if (points.error) throw points.error;
      if (credit.error) throw credit.error;

      pointsByOrder = reasonsByOrder(points.data as Array<{ order_id: unknown; reason: unknown }>);
      const creditRows = (credit.data ?? []) as Array<Record<string, unknown>>;
      creditByOrder = reasonsByOrder(creditRows as Array<{ order_id: unknown; reason: unknown }>);
      refundableCredit = new Set(
        creditRows
          .filter(
            (row) =>
              String(row.reason) === "membership_redemption"
              && isRefundableRedemption(row, input.monthStart),
          )
          .map((row) => String(row.order_id)),
      );
    }

    for (const order of page) {
      const effects = planRefundRepairs(
        order,
        pointsByOrder.get(order.order_id) ?? new Set(),
        creditByOrder.get(order.order_id) ?? new Set(),
        { storeCreditRefundable: refundableCredit.has(order.order_id) },
      );
      if (effects.length === 0) continue;
      planned.push({ order, effects });
      if (planned.length >= input.limit) return { planned, scanned, truncated };
    }

    // A short page is the end of the window.
    if (page.length < SCAN_PAGE_SIZE) break;
    offset += SCAN_PAGE_SIZE;
    if (offset >= MAX_SCAN_ROWS) {
      truncated = true;
      break;
    }
  }

  return { planned, scanned, truncated };
}

export async function repairIncompleteRefunds(options?: {
  lookbackDays?: number;
  limit?: number;
  now?: Date;
}): Promise<RefundRepairResult> {
  const now = options?.now ?? new Date();
  const lookbackDays = options?.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;
  const limit = options?.limit ?? DEFAULT_LIMIT;
  const since = new Date(now.getTime() - lookbackDays * 24 * 60 * 60 * 1000).toISOString();

  const result: RefundRepairResult = { scanned: 0, repaired: 0, failed: 0 };

  const { planned, scanned, truncated } = await collectRepairablePages({
    since,
    limit,
    monthStart: startOfCurrentMonthIso(now),
  });
  result.scanned = scanned;
  if (truncated) result.scanTruncated = true;
  if (planned.length === 0) return result;

  const failures: Array<{ orderId: string; effect: string; error: string }> = [];

  for (const { order, effects } of planned) {
    for (const effect of effects) {
      try {
        // WROTE SOMETHING, OR DID NOT. Each branch reports whether it actually
        // changed anything, and only a real write counts as a repair — a
        // `repaired` count that includes no-ops is what made the last storm
        // look like progress.
        let wrote: boolean;
        if (effect === "refund_amount") {
          // A refunded order with refund_amount 0 never had the reversal
          // recorded, so revenue was never reduced. The refunded amount is what
          // the customer paid — a processor-initiated full refund is the only
          // way this status is reached without an amount already written.
          //
          // refunded_at IS NOT WRITTEN HERE, DELIBERATELY. It records WHEN the
          // money went back, and admin-membership.ts attributes 30-day
          // membership refunds by it. Stamping it with now() moved a
          // months-old refund into the current month and deducted it from the
          // wrong one — this repair knows the AMOUNT that was missed, not the
          // DATE, and inventing the date corrupts a figure that was correct.
          //
          // NULL AND 0 ARE DIFFERENT FILTERS IN SQL. `.eq("refund_amount", 0)`
          // does not match NULL, so for a legacy NULL row the guarded update
          // matched nothing, returned no error, and `repaired` was incremented
          // anyway — the order was replanned and "repaired" on every tick
          // forever. Same hazard, same handling as the admin reimbursement
          // route (src/app/api/admin/orders/[orderId]/route.ts).
          const writtenAt = new Date().toISOString();
          const claim = supabaseAdmin
            .from("orders")
            .update({
              refund_amount: Number(order.amount_paid ?? 0),
              updated_at: writtenAt,
            })
            .eq("order_id", order.order_id);
          const { data: claimed, error: updateError } = await (order.refund_amount == null
            ? claim.is("refund_amount", null)
            : claim.eq("refund_amount", 0)
          ).select("id");
          if (updateError) throw updateError;
          // Nothing matched: another writer got there first, or the row moved
          // under us. That is not a repair, and counting it as one is what
          // made the storm self-sustaining.
          wrote = Boolean(claimed && claimed.length > 0);
        } else if (effect === "points_reversal") {
          wrote = await reverseOrderPoints(order.order_id);
        } else if (effect === "points_restore") {
          wrote = await restoreRedeemedPoints(order.order_id);
        } else {
          wrote = await refundStoreCreditForOrder(order.order_id);
        }
        if (wrote) result.repaired += 1;
      } catch (repairError) {
        result.failed += 1;
        failures.push({
          orderId: order.order_id,
          effect,
          error: repairError instanceof Error ? repairError.message : String(repairError),
        });
      }
    }
  }

  if (failures.length > 0) {
    await recordSystemAlert({
      type: "refund_effects_unrecovered",
      severity: "critical",
      message:
        `${failures.length} refund side-effect(s) could not be completed. `
        + "Revenue, loyalty points or store credit may not reflect these refunds.",
      context: { failures: failures.slice(0, 25), totalFailed: failures.length },
    }).catch((alertError) => {
      console.error("Unable to record a refund-effect repair alert", alertError);
    });
  }

  return result;
}
