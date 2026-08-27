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

  // EVERY CONDITION THAT DEFINES A CANDIDATE BELONGS IN THE QUERY.
  //
  // `shippo_transaction_id IS NOT NULL` lived only in the JavaScript predicate,
  // so `limit` bounded the rows SCANNED rather than the candidates: fifty orders
  // with a label_purchased_at and no transaction id (a thin transaction_created
  // delivery produces exactly that) filled the page forever, nothing was ever
  // repaired behind them, and the run reported {scanned:50, repaired:0,
  // failed:0} — indistinguishable from "nothing to do", with no alert at all.
  const candidateQuery = () =>
    supabaseAdmin
      .from("orders")
      .select(
        "order_id, label_purchased_at, label_voided_at, shippo_transaction_id, actual_shipping_cost_cents, postage_cost_cents",
      )
      .not("label_purchased_at", "is", null)
      .not("shippo_transaction_id", "is", null)
      .gte("label_purchased_at", since)
      // A voided label's postage was refunded — never re-charge it.
      .is("label_voided_at", null)
      // ABSENCE BELONGS IN THE QUERY, NOT IN JAVASCRIPT. Selecting the oldest N
      // labels and THEN filtering for a missing cost meant `limit` bounded the
      // rows SCANNED, not the rows to repair: once the oldest N were fixed every
      // later tick re-read those same N, found nothing to do, and never reached
      // the orders behind them. With the condition pushed down, `limit` bounds
      // CANDIDATES and the sweep advances.
      .is("actual_shipping_cost_cents", null);

  // BOTH ENDS OF THE WINDOW, BECAUSE A PERMANENTLY UNREPAIRABLE ROW MUST NOT BE
  // ABLE TO HIDE EVERY LABEL BOUGHT SINCE.
  //
  // Whether a row can be repaired is only knowable by asking Shippo, so it
  // cannot be expressed as a query condition the way absence can: a label whose
  // transaction never settles (status not SUCCESS, or a bare rate reference)
  // matches the predicate above forever. Ordered oldest-first alone, `limit` of
  // those squatters is enough to halt the sweep permanently, and the only signal
  // was a deduped warning. Oldest neglect still leads — it is the most likely to
  // age out of the lookback — but half the budget is spent on the NEWEST
  // candidates, so today's orders are always reachable and the backlog drains
  // from both ends towards whatever core is genuinely unrepairable.
  const oldestLimit = Math.max(1, Math.ceil(limit / 2));
  const newestLimit = Math.max(0, limit - oldestLimit);

  // order_id IS A TIEBREAK, NOT DECORATION. Labels bought in the same batch
  // share a label_purchased_at to the second, and with ties the two ends of the
  // scan can return the SAME rows — which would quietly halve the budget and
  // hide the newest orders behind a tie at the oldest end.
  const [oldest, newest] = await Promise.all([
    candidateQuery()
      .order("label_purchased_at", { ascending: true })
      .order("order_id", { ascending: true })
      .limit(oldestLimit),
    newestLimit > 0
      ? candidateQuery()
        .order("label_purchased_at", { ascending: false })
        .order("order_id", { ascending: false })
        .limit(newestLimit)
      : Promise.resolve({ data: [], error: null }),
  ]);

  // A sweep that cannot read is not a sweep that found nothing.
  if (oldest.error) throw oldest.error;
  if (newest.error) throw newest.error;

  const seen = new Set<string>();
  const rows: ShippingCostCandidate[] = [];
  for (const row of [...(oldest.data ?? []), ...(newest.data ?? [])] as ShippingCostCandidate[]) {
    if (seen.has(row.order_id)) continue;
    seen.add(row.order_id);
    rows.push(row);
  }

  // Second line of defence: the same rule as a pure predicate, so the sweep is
  // still correct if the query above is ever loosened.
  const candidates = findOrdersMissingShippingCost(rows);
  result.scanned = rows.length;
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

  if (manual.length > 0 && await manualEntryStateChanged(manual)) {
    // A HALTED SWEEP IS NOT A WARNING.
    //
    // Severity here used to be flat `warning` — no email — for a condition that
    // includes "every slot this run had is held by a row that can never be
    // repaired, so nothing behind them will ever be reached". Two-ended
    // scanning means newer orders still get through, but a backlog that fills
    // the whole budget is still the sweep telling the operator it has stopped
    // making progress, and that has to reach a person. A smaller backlog is
    // still a standing condition rather than an event, so it stays a warning.
    //
    // Both are deduped on the backlog's state (see manualEntryStateChanged), so
    // neither can storm: the row is written when the backlog CHANGES, not on
    // every tick.
    const halted = manual.length >= limit;
    await recordSystemAlert({
      type: MANUAL_ENTRY_ALERT,
      severity: halted ? "critical" : "warning",
      message: halted
        ? `${manual.length} order(s) have a label whose postage cannot be read back from Shippo — `
          + "enough to consume this sweep's entire per-run budget, so it is no longer making progress "
          + "on the oldest end of the backlog. Enter these costs by hand in Admin -> Orders."
        : `${manual.length} order(s) have a label whose postage cannot be read back from Shippo. `
          + "Enter the cost by hand in Admin -> Orders; no automatic repair is possible.",
      context: { orders: manual.slice(0, 25), total: manual.length, sweepBudgetExhausted: halted },
    }).catch((alertError) => {
      console.error("Unable to record a shipping-cost manual-entry alert", alertError);
    });
  }

  return result;
}

const MANUAL_ENTRY_ALERT = "shipping_cost_manual_entry_required";

/**
 * Has the manual-entry backlog CHANGED since the last time it was reported?
 *
 * This alert describes a STANDING CONDITION, not an event: an order whose
 * postage cannot be read back from Shippo stays that way until a human types
 * the figure in. recordSystemAlert has no dedup of any kind, so re-reporting it
 * on every tick wrote a `system_alerts` row every thirty minutes, forever, for
 * a state the sweep itself calls working-as-designed — roughly 48 rows a day
 * burying the alerts that ARE events.
 *
 * The row is still written the moment the backlog changes: a new order joining
 * it, or the count moving. So nothing new goes unreported, and an operator
 * looking at admin still sees the standing condition — once.
 *
 * Best-effort by design. If the check cannot be made, the alert is raised: a
 * missed alert is worse than a duplicate one.
 */
async function manualEntryStateChanged(manual: Array<{ orderId: string }>): Promise<boolean> {
  try {
    const { data, error } = await supabaseAdmin
      .from("system_alerts")
      .select("context, resolved_at, created_at")
      .eq("type", MANUAL_ENTRY_ALERT)
      .order("created_at", { ascending: false })
      .limit(1);
    if (error) return true;

    const latest = (data ?? [])[0] as
      | { context?: { orders?: Array<{ orderId?: unknown }>; total?: unknown } | null; resolved_at?: string | null }
      | undefined;
    // Never reported, or reported and cleared by a human: report it again.
    if (!latest || latest.resolved_at) return true;

    // The stored list is capped at 25 entries, so the COUNT is what carries the
    // rest of it. Either moving means the backlog is not the one already on
    // file.
    if (Number(latest.context?.total ?? -1) !== manual.length) return true;
    const reported = new Set((latest.context?.orders ?? []).map((row) => String(row.orderId)));
    return manual.slice(0, 25).some((entry) => !reported.has(entry.orderId));
  } catch {
    return true;
  }
}

/**
 * What this label actually cost, in cents — or nothing, if it is not a label
 * the store still owes money for.
 *
 * ASK WHETHER THE LABEL IS STILL LIVE BEFORE DECIDING WHAT IT COST. The status
 * check below used to sit AFTER a short-circuit that returned
 * postage_cost_cents without ever contacting Shippo, which made it unreachable
 * for every order the app or order-sync had bought a label for — precisely the
 * orders that HAVE a postage figure. Its own comment claimed it was "the only
 * place that catches" a void raised outside this app, and it caught none of
 * them: an order with postage_cost_cents = 742 whose label was voided in the
 * Shippo dashboard (so label_voided_at is NULL here) had that refunded postage
 * charged straight to profit on the next tick. The lookup is a GET on an
 * existing transaction, it cannot buy anything, and this sweep only ever runs
 * for orders with no recorded cost — a rare row — so the round-trip is worth
 * what it proves.
 *
 * THE HELD FIGURE IS STILL THE AMOUNT. postage_cost_cents is written from the
 * same Shippo rate the moment a label lands, so once the label is confirmed
 * live there is no reason to re-parse the rate — which is also the shape that
 * cannot be read back for a dashboard label with a bare rate reference.
 */
async function resolveSettledCents(order: ShippingCostCandidate): Promise<number> {
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
      `Shippo reports this transaction as ${status || "an unknown status"}, not SUCCESS — no postage to record`
      + (status === "REFUNDED"
        // NAME THE ONE CASE WHERE HAND-ENTERING A COST IS WRONG. A REFUNDED
        // transaction is a label voided outside this app, so label_voided_at is
        // NULL locally and the admin screen will ACCEPT a hand-entered figure
        // with no override — charging profit for postage the carrier gave back.
        ? ". This label was VOIDED and its postage refunded: do NOT enter a cost by hand unless the carrier "
          + "declined the refund, in which case the entry needs overrideVoidedLabel."
        : status === "QUEUED" || status === "WAITING"
          // Nor is an unsettled purchase a permanent condition.
          ? ". The purchase has not settled yet; the next sweep will record it once it does."
          : ""),
    );
  }

  const held = Number(order.postage_cost_cents ?? 0);
  if (order.postage_cost_cents != null && held > 0) return held;

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
