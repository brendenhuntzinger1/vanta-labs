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
}

/**
 * Which refund effects are still missing for one order.
 *
 * An effect is only planned when the order actually incurred it: an order that
 * earned no points needs no reversal, and planning one would call a function
 * that correctly does nothing, every sweep, forever.
 */
export function planRefundRepairs(
  order: RefundCandidate,
  pointsLedgerReasons: Set<string>,
  storeCreditReasons: Set<string>,
): RefundRepairEffect[] {
  if (String(order.payment_status ?? "").toLowerCase() !== "refunded") return [];

  const planned: RefundRepairEffect[] = [];
  if (Number(order.refund_amount ?? 0) <= 0) planned.push("refund_amount");
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

  const { data, error } = await supabaseAdmin
    .from("orders")
    .select(
      "order_id, payment_status, refund_amount, points_earned, points_redeemed, store_credit_redeemed_cents, amount_paid",
    )
    .eq("payment_status", "refunded")
    .gte("refunded_at", since)
    .order("refunded_at", { ascending: true })
    .limit(limit);

  if (error) throw error;

  const candidates = (data ?? []) as Array<RefundCandidate & { amount_paid: number | null }>;
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
          const { error: updateError } = await supabaseAdmin
            .from("orders")
            .update({
              refund_amount: Number(order.amount_paid ?? 0),
              refunded_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            })
            .eq("order_id", order.order_id)
            .eq("refund_amount", 0);
          if (updateError) throw updateError;
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
