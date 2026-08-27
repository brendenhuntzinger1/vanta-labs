import "server-only";

import { supabaseAdmin } from "@/lib/supabase-server";
import { getTransaction, settledCentsFromTransaction } from "@/lib/shippo/client";
import { recordActualShippingCost } from "@/lib/admin-profit";
import { recordSystemAlert } from "@/lib/monitoring";

/**
 * RECORD THE POSTAGE THE STORE ACTUALLY PAID.
 *
 * purchaseLabel writes postage_cost_cents and calls recordActualShippingCost,
 * but that landed after labels had already been bought, and its failure return
 * was discarded. The result on production: two real Shippo labels, zero
 * recorded postage, and a profit report charging a flat $6.00 model instead.
 *
 * IDEMPOTENT BY CONSTRUCTION. The sweep looks for ABSENCE — a label with no
 * recorded cost — so a second run finds nothing to do. getTransaction is a GET
 * on /transactions/<id>; it reads an existing label and cannot buy one.
 *
 * THIS ALSO REPAIRS THE PAST: it clears the existing backlog, not only orders
 * shipped from here on.
 *
 * A VOIDED LABEL IS NOT A MISSING COST. voidLabelForOrder deliberately KEEPS
 * label_purchased_at and shippo_transaction_id (they are facts about a label
 * that really was bought) while clearing postage_cost_cents and nulling
 * actual_shipping_cost_cents. Without the label_voided_at condition below that
 * post-void row matched this sweep EXACTLY, so the next tick re-read the still
 * present Shippo rate, re-charged the refunded postage, and flipped
 * profit_finalized back to true — and the audit dedup then suppressed the row
 * that would have shown it, because that amount was already in the history.
 * Silent. The condition is enforced in three places on purpose: in the query
 * (so a voided row is never fetched), in the pure predicate (so it is correct
 * on its own), and inside recordActualShippingCost (so no caller can bypass it).
 */

const DEFAULT_LOOKBACK_DAYS = 90;
const DEFAULT_LIMIT = 50;

export interface ShippingCostRepairResult {
  scanned: number;
  repaired: number;
  failed: number;
}

export interface ShippingCostCandidate {
  order_id: string;
  label_purchased_at: string | null;
  /** Set by voidLabelForOrder. Non-null means the postage was REFUNDED. */
  label_voided_at: string | null;
  shippo_transaction_id: string | null;
  actual_shipping_cost_cents: number | null;
  /** The label cost this order already holds, written when the label landed. */
  postage_cost_cents: number | null;
}

/**
 * Orders that bought a label and have no cost recorded.
 *
 * A recorded cost of 0 is NOT absence — zero postage is a real answer (a free
 * carrier account) and re-deriving it every sweep would be a pointless call to
 * Shippo forever.
 *
 * A VOIDED label is not absence either: its postage was refunded, so there is
 * no cost to record and re-recording one charges the store for a parcel that
 * never shipped.
 */
export function findOrdersMissingShippingCost<T extends ShippingCostCandidate>(rows: T[]): T[] {
  return rows.filter(
    (row) =>
      Boolean(row.label_purchased_at)
      && !row.label_voided_at
      && Boolean(row.shippo_transaction_id)
      && row.actual_shipping_cost_cents == null,
  );
}

/**
 * A failure this sweep can never fix by running again.
 *
 * order-sync deliberately leaves postage_cost_cents NULL when a label adopted
 * from the Shippo dashboard has no readable rate, so a human enters the figure
 * by hand. That row matches this sweep's predicate forever, and treating it as
 * a CRITICAL failure emailed the operator every thirty minutes about a state
 * that is working as designed. It is reported once per run at WARNING level
 * instead: still durable and visible in admin, no longer an alert storm.
 */
class ManualEntryRequired extends Error {}

export async function repairMissingShippingCosts(options?: {
  lookbackDays?: number;
  limit?: number;
  now?: Date;
}): Promise<ShippingCostRepairResult> {
  const now = options?.now ?? new Date();
  const lookbackDays = options?.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;
  const limit = options?.limit ?? DEFAULT_LIMIT;
  const since = new Date(now.getTime() - lookbackDays * 24 * 60 * 60 * 1000).toISOString();

  const result: ShippingCostRepairResult = { scanned: 0, repaired: 0, failed: 0 };

  const { data, error } = await supabaseAdmin
    .from("orders")
    .select(
      "order_id, label_purchased_at, label_voided_at, shippo_transaction_id, actual_shipping_cost_cents, postage_cost_cents",
    )
    .not("label_purchased_at", "is", null)
    .gte("label_purchased_at", since)
    // A voided label's postage was refunded — never re-charge it.
    .is("label_voided_at", null)
    // ABSENCE BELONGS IN THE QUERY, NOT IN JAVASCRIPT. Selecting the oldest N
    // labels and THEN filtering for a missing cost meant `limit` bounded the
    // rows SCANNED, not the rows to repair: once the oldest N were fixed every
    // later tick re-read those same N, found nothing to do, and never reached
    // the orders behind them. With the condition pushed down, `limit` bounds
    // CANDIDATES and the sweep advances.
    .is("actual_shipping_cost_cents", null)
    .order("label_purchased_at", { ascending: true })
    .limit(limit);

  // A sweep that cannot read is not a sweep that found nothing.
  if (error) throw error;

  // Second line of defence: the same rule as a pure predicate, so the sweep is
  // still correct if the query above is ever loosened.
  const candidates = findOrdersMissingShippingCost((data ?? []) as ShippingCostCandidate[]);
  result.scanned = (data ?? []).length;
  if (candidates.length === 0) return result;

  const failures: Array<{ orderId: string; error: string }> = [];
  const manual: Array<{ orderId: string; error: string }> = [];

  for (const order of candidates) {
    try {
      const amountCents = await resolveSettledCents(order);
      const recorded = await recordActualShippingCost({
        orderId: order.order_id,
        amountCents,
        source: "shippo",
      });
      if (!recorded.ok) throw new Error(recorded.error ?? "recordActualShippingCost failed");
      result.repaired += 1;
    } catch (repairError) {
      result.failed += 1;
      const entry = {
        orderId: order.order_id,
        error: repairError instanceof Error ? repairError.message : String(repairError),
      };
      if (repairError instanceof ManualEntryRequired) manual.push(entry);
      else failures.push(entry);
    }
  }

  if (failures.length > 0) {
    await recordSystemAlert({
      type: "shipping_cost_unrecorded",
      severity: "critical",
      message:
        `${failures.length} order(s) bought a shipping label but still have no recorded postage. `
        + "Profit for these orders is charging the flat shipping estimate instead of the real label cost.",
      context: { failures: failures.slice(0, 25), totalFailed: failures.length },
    }).catch((alertError) => {
      console.error("Unable to record a shipping-cost repair alert", alertError);
    });
  }

  if (manual.length > 0) {
    await recordSystemAlert({
      type: "shipping_cost_manual_entry_required",
      severity: "warning",
      message:
        `${manual.length} order(s) have a label whose postage cannot be read back from Shippo. `
        + "Enter the cost by hand in Admin -> Orders; no automatic repair is possible.",
      context: { orders: manual.slice(0, 25), total: manual.length },
    }).catch((alertError) => {
      console.error("Unable to record a shipping-cost manual-entry alert", alertError);
    });
  }

  return result;
}

/**
 * What this label actually cost, in cents.
 *
 * PREFER THE COST WE ALREADY HOLD. postage_cost_cents is written from the same
 * Shippo rate the moment a label lands (purchaseLabel, and order-sync for a
 * label adopted from the dashboard), so when it is present it is the answer —
 * no network call, and nothing to go wrong. Shippo is only consulted when the
 * order carries no figure at all.
 */
async function resolveSettledCents(order: ShippingCostCandidate): Promise<number> {
  const held = Number(order.postage_cost_cents ?? 0);
  if (order.postage_cost_cents != null && held > 0) return held;

  const transaction = await getTransaction(String(order.shippo_transaction_id));
  if (!transaction.ok) {
    throw new Error(transaction.message ?? "Shippo transaction lookup failed");
  }

  // ONLY A SUCCESSFUL LABEL HAS A COST TO RECORD. REFUNDED means the postage
  // was given back (a void raised outside this app never sets label_voided_at
  // here, so this is the only place that catches it); ERROR means no label was
  // ever produced; QUEUED / WAITING mean the purchase has not settled. Charging
  // profit for any of those invents a cost the store did not pay.
  const status = String(transaction.data.status ?? "");
  if (status !== "SUCCESS") {
    throw new ManualEntryRequired(
      `Shippo reports this transaction as ${status || "an unknown status"}, not SUCCESS — no postage to record`,
    );
  }

  // getTransaction returns the RAW Shippo transaction, whose postage lives on
  // `rate`. It is NOT the parsed label object purchaseLabel builds, so there is
  // no `postageCostCents` on it — settledCentsFromTransaction is the one place
  // that parses it, and returns null when `rate` came back as a bare id
  // reference rather than an expanded object.
  const amountCents = settledCentsFromTransaction(transaction.data.rate);
  if (amountCents == null) {
    throw new ManualEntryRequired("Shippo returned no usable postage amount on the transaction rate");
  }
  return amountCents;
}
