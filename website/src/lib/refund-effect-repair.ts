import "server-only";

import { supabaseAdmin } from "@/lib/supabase-server";
import { reverseOrderPoints, restoreRedeemedPoints } from "@/lib/membership";
import { refundStoreCreditForOrder } from "@/lib/store-credit";
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
const DEFAULT_LIMIT = 50;

export type RefundRepairEffect =
  | "refund_amount"
  | "points_reversal"
  | "points_restore"
  | "store_credit_refund";

export interface RefundRepairResult {
  scanned: number;
  repaired: number;
  failed: number;
}

export interface RefundCandidate {
  order_id: string;
  payment_status: string | null;
  refund_amount: number | null;
  points_earned: number | null;
  points_redeemed: number | null;
  store_credit_redeemed_cents: number | null;
  amount_paid: number | null;
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
 *
 * The scan stays bounded: NULL-refunded_at rows are still constrained by
 * payment_status, by the absence conditions each pass adds, and by `limit`.
 */
function refundedWindow(since: string) {
  return `refunded_at.gte.${since},refunded_at.is.null`;
}

/**
 * Which refund effects are still missing for one order.
 *
 * An effect is only planned when the order actually incurred it: an order that
 * earned no points needs no reversal, and planning one would call a function
 * that correctly does nothing, every sweep, forever.
 *
 * `refund_amount` additionally requires that money was actually taken
 * (`amount_paid > 0`). A legitimately $0 refund — a 100%-discount order
 * marked `refunded` with nothing ever paid — has no refund amount to record.
 * Without this guard, the condition "refund_amount is 0" is permanently true
 * for such an order (the guarded UPDATE would keep matching and rewriting
 * 0 -> 0), so it would be replanned and "repaired" on every sweep tick
 * forever: an unbounded stream of pointless writes and a `repaired` count
 * that no longer means "something was actually fixed".
 */
export function planRefundRepairs(
  order: RefundCandidate,
  pointsLedgerReasons: Set<string>,
  storeCreditReasons: Set<string>,
): RefundRepairEffect[] {
  if (String(order.payment_status ?? "").toLowerCase() !== "refunded") return [];

  const planned: RefundRepairEffect[] = [];
  if (Number(order.amount_paid ?? 0) > 0 && Number(order.refund_amount ?? 0) <= 0) {
    planned.push("refund_amount");
  }
  if (Number(order.points_earned ?? 0) > 0 && !pointsLedgerReasons.has("order_refund_reversal")) {
    planned.push("points_reversal");
  }
  if (Number(order.points_redeemed ?? 0) > 0 && !pointsLedgerReasons.has("order_refund_points_restore")) {
    planned.push("points_restore");
  }
  if (
    Number(order.store_credit_redeemed_cents ?? 0) > 0
    && !storeCreditReasons.has("membership_redemption_refund")
  ) {
    planned.push("store_credit_refund");
  }
  return planned;
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

  const COLUMNS =
    "order_id, payment_status, refund_amount, points_earned, points_redeemed, store_credit_redeemed_cents, amount_paid";

  // ABSENCE BELONGS IN THE QUERY. Selecting the oldest N refunded orders and
  // THEN filtering in JavaScript meant `limit` bounded the rows SCANNED, not
  // the rows to repair: once the oldest N were fixed, every later tick re-read
  // those same N, found nothing to do, and never reached the orders behind
  // them. Each pass below carries its own absence condition, so `limit` bounds
  // CANDIDATES.
  //
  // ORDER ON A COLUMN THAT IS ALWAYS PRESENT. Paginating on refunded_at cannot
  // work now that NULL-refunded_at rows are in scope — NULLs sort to one end
  // and the window would never move past them. updated_at is written by every
  // path that touches an order, including the refund_amount repair below, so a
  // repaired order moves to the BACK of the queue as well as out of pass A's
  // filter.
  //
  // TWO PASSES, because the four effects are not detectable the same way.
  // refund_amount lives on the order and can be tested in SQL. The other three
  // are proven ABSENT by a missing ledger row in another table, which no
  // orders-table predicate can express — the closest available narrowing is
  // "this order actually incurred points or store credit at all". Running both
  // and de-duplicating keeps the primary case self-advancing without dropping
  // coverage of the other three.
  const [primary, ledgerEffects] = await Promise.all([
    // Pass A — revenue was never reduced. Self-advancing: the repair changes
    // the very column this filter tests, so a fixed order leaves the set.
    supabaseAdmin
      .from("orders")
      .select(COLUMNS)
      .eq("payment_status", "refunded")
      .or(refundedWindow(since))
      .or("refund_amount.is.null,refund_amount.eq.0")
      .order("updated_at", { ascending: true })
      .limit(limit),
    // Pass B — points and store credit. Only orders that actually earned,
    // redeemed or spent something can need one of these.
    supabaseAdmin
      .from("orders")
      .select(COLUMNS)
      .eq("payment_status", "refunded")
      .or(refundedWindow(since))
      .or("points_earned.gt.0,points_redeemed.gt.0,store_credit_redeemed_cents.gt.0")
      .order("updated_at", { ascending: true })
      .limit(limit),
  ]);

  if (primary.error) throw primary.error;
  if (ledgerEffects.error) throw ledgerEffects.error;

  const byId = new Map<string, RefundCandidate>();
  for (const row of [...(primary.data ?? []), ...(ledgerEffects.data ?? [])] as RefundCandidate[]) {
    if (!byId.has(row.order_id)) byId.set(row.order_id, row);
  }
  const candidates = [...byId.values()];
  result.scanned = candidates.length;
  if (candidates.length === 0) return result;

  const orderIds = candidates.map((order) => order.order_id);

  const [{ data: pointsRows, error: pointsError }, { data: creditRows, error: creditError }] =
    await Promise.all([
      supabaseAdmin.from("points_ledger").select("order_id, reason").in("order_id", orderIds),
      supabaseAdmin.from("store_credit_ledger").select("order_id, reason").in("order_id", orderIds),
    ]);
  if (pointsError) throw pointsError;
  if (creditError) throw creditError;

  const reasonsByOrder = (rows: Array<{ order_id: unknown; reason: unknown }> | null) => {
    const map = new Map<string, Set<string>>();
    for (const row of rows ?? []) {
      const key = String(row.order_id);
      if (!map.has(key)) map.set(key, new Set());
      map.get(key)!.add(String(row.reason));
    }
    return map;
  };
  const pointsByOrder = reasonsByOrder(pointsRows as Array<{ order_id: unknown; reason: unknown }>);
  const creditByOrder = reasonsByOrder(creditRows as Array<{ order_id: unknown; reason: unknown }>);

  const failures: Array<{ orderId: string; effect: string; error: string }> = [];

  for (const order of candidates) {
    const planned = planRefundRepairs(
      order,
      pointsByOrder.get(order.order_id) ?? new Set(),
      creditByOrder.get(order.order_id) ?? new Set(),
    );

    for (const effect of planned) {
      try {
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
          const now = new Date().toISOString();
          const claim = supabaseAdmin
            .from("orders")
            .update({
              refund_amount: Number(order.amount_paid ?? 0),
              updated_at: now,
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
          if (!claimed || claimed.length === 0) continue;
        } else if (effect === "points_reversal") {
          await reverseOrderPoints(order.order_id);
        } else if (effect === "points_restore") {
          await restoreRedeemedPoints(order.order_id);
        } else {
          await refundStoreCreditForOrder(order.order_id);
        }
        result.repaired += 1;
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
