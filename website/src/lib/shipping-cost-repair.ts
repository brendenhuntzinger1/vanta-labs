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
  shippo_transaction_id: string | null;
  actual_shipping_cost_cents: number | null;
}

/**
 * Orders that bought a label and have no cost recorded.
 *
 * A recorded cost of 0 is NOT absence — zero postage is a real answer (a voided
 * label, a free carrier account) and re-deriving it every sweep would be a
 * pointless call to Shippo forever.
 */
export function findOrdersMissingShippingCost<T extends ShippingCostCandidate>(rows: T[]): T[] {
  return rows.filter(
    (row) =>
      Boolean(row.label_purchased_at)
      && Boolean(row.shippo_transaction_id)
      && row.actual_shipping_cost_cents == null,
  );
}

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
    .select("order_id, label_purchased_at, shippo_transaction_id, actual_shipping_cost_cents")
    .not("label_purchased_at", "is", null)
    .gte("label_purchased_at", since)
    .order("label_purchased_at", { ascending: true })
    .limit(limit);

  // A sweep that cannot read is not a sweep that found nothing.
  if (error) throw error;

  const candidates = findOrdersMissingShippingCost((data ?? []) as ShippingCostCandidate[]);
  result.scanned = (data ?? []).length;
  if (candidates.length === 0) return result;

  const failures: Array<{ orderId: string; error: string }> = [];

  for (const order of candidates) {
    try {
      const transaction = await getTransaction(String(order.shippo_transaction_id));
      if (!transaction.ok) {
        throw new Error(transaction.message ?? "Shippo transaction lookup failed");
      }
      // getTransaction returns the RAW Shippo transaction, whose postage lives
      // on `rate`. It is NOT the parsed label object purchaseLabel builds, so
      // there is no `postageCostCents` on it — settledCentsFromTransaction is
      // the one place that parses it, and returns null when `rate` came back as
      // a bare id reference rather than an expanded object.
      const amountCents = settledCentsFromTransaction(transaction.data.rate);
      if (amountCents == null) {
        throw new Error("Shippo returned no usable postage amount on the transaction rate");
      }
      const recorded = await recordActualShippingCost({
        orderId: order.order_id,
        amountCents,
        source: "shippo",
      });
      if (!recorded.ok) throw new Error(recorded.error ?? "recordActualShippingCost failed");
      result.repaired += 1;
    } catch (repairError) {
      result.failed += 1;
      failures.push({
        orderId: order.order_id,
        error: repairError instanceof Error ? repairError.message : String(repairError),
      });
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

  return result;
}
