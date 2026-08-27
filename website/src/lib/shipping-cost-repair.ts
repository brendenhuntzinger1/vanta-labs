import "server-only";

import { supabaseAdmin } from "@/lib/supabase-server";
import { getTransaction, settledCentsForTransaction } from "@/lib/shippo/client";
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

/**
 * Rows read per page of the CANDIDATE SELECT. The select is cheap (one indexed
 * read, no third party); it is the Shippo GET per candidate that costs, and
 * that is what `limit` bounds. Keeping the two budgets separate is the whole
 * design — see selectProbeOrder.
 */
const CANDIDATE_PAGE_SIZE = 200;

/**
 * Ceiling on candidate rows READ per run, so scan cost cannot grow without
 * bound as the orders table does. Reaching it is reported, never silent.
 */
const MAX_CANDIDATE_SCAN = 5000;

export interface ShippingCostRepairResult {
  scanned: number;
  repaired: number;
  failed: number;
  /**
   * The window held more candidates than MAX_CANDIDATE_SCAN, so this run did
   * not see all of it. Surfaced rather than swallowed: it is the only condition
   * under which the scan can fail to SEE a repairable row.
   */
  scanTruncated?: boolean;
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
 * that is working as designed.
 */
class ManualEntryRequired extends Error {}

/**
 * How many order ids one backlog alert carries.
 *
 * DELIBERATELY EQUAL TO THE SCAN CEILING, so the backlog can always name every
 * candidate this run could possibly have seen. A cap BELOW it churns: the rows
 * that do not fit drop out, become "unknown" again on the next tick, are
 * re-probed at one Shippo call each, and push others out in their place — the
 * backlog then changes every tick, so the state-change dedup writes an alert
 * every tick, which is the storm it exists to prevent. The remaining bound is
 * the scan ceiling itself, and that one is reported.
 */
const MAX_BACKLOG_IDS = MAX_CANDIDATE_SCAN;

const MANUAL_ENTRY_ALERT = "shipping_cost_manual_entry_required";
const UNRECORDED_ALERT = "shipping_cost_unrecorded";
const SCAN_TRUNCATED_ALERT = "shipping_cost_scan_truncated";

/**
 * WHICH ROWS THIS RUN SPENDS ITS SHIPPO BUDGET ON, AND WHY THAT IS THE WHOLE
 * FIX.
 *
 * History, because the shape of this function is a direct answer to two
 * successive live defects:
 *
 *   v1  oldest-first, one `.limit(n)` page. A row that can never be repaired
 *       (a dashboard label with a bare rate reference) matches the candidate
 *       predicate FOREVER, so `limit` such rows at the oldest end held the
 *       entire page on every tick and NOTHING behind them was ever reached.
 *   v2  split the budget oldest-half / newest-half, so today's orders were
 *       always reachable. That moved the starvation instead of removing it:
 *       with arrivals at or above the newest half's slice (25/tick), the newest
 *       half is consumed by brand-new rows and the oldest half by the stuck
 *       ones, and the MIDDLE of the window is never scanned again. Measured:
 *       40 perfectly repairable middle rows unrepaired after 12 ticks, where v1
 *       drained the same 40 in 2.
 *
 * The lesson both versions missed: `limit` was deciding which rows are VISIBLE.
 * It must only decide which rows are PROBED. The candidate SELECT is cheap and
 * pageable, so this run reads the WHOLE window (up to MAX_CANDIDATE_SCAN) and
 * then chooses, from all of it, where to spend the Shippo calls.
 *
 * Two tiers, oldest-first within each:
 *
 *   FRESH   candidates with no recorded probe outcome. They get the budget
 *           first.
 *   RETRY   candidates already known to have failed a probe — hand-entry cases
 *           and errored lookups, carried in the alert backlogs this sweep
 *           already persists (see loadProbeBacklog). They get only the budget
 *           the fresh tier did not use.
 *
 * THE PROPERTY THIS GUARANTEES, and the arithmetic behind it:
 *
 *  (a) Arrival rate is irrelevant. A newly bought label has a LATER
 *      label_purchased_at than every row already in the window, so it sorts
 *      BEHIND them. Arrivals can never get in front of a row that is already
 *      waiting, at any rate. (This is exactly what v2 broke by giving the
 *      newest end a reserved slice.)
 *  (b) The fresh tier strictly drains. Every probed row LEAVES it: repaired
 *      (it stops being a candidate at all) or classified (it joins the
 *      backlog). So min(limit, |fresh|) rows leave per tick and none are added
 *      ahead of the rest.
 *  (c) Therefore a repairable row with P fresh rows ahead of it is probed
 *      within ceil((P + 1) / limit) ticks — a bound fixed when it arrives, not
 *      a function of what happens afterwards.
 *  (d) A row that cannot be repaired cannot hold the budget: it is in RETRY
 *      from its first probe onward, and RETRY only ever gets leftovers.
 *  (e) No row is excluded permanently, so a TRANSIENT failure is not a life
 *      sentence — it is retried whenever the fresh tier leaves room, and a
 *      success removes it from the backlog on the spot.
 *
 * The one dependency worth naming: the backlog lives in `system_alerts.context`
 * because no per-row column exists to hold it. If that read fails the run
 * degrades to plain oldest-first for one tick (property (a) and (c) still hold
 * for everything ahead of the stuck rows; only (d) lapses) and recovers on the
 * next. If the alert WRITE fails the backlog is not persisted and the same
 * degradation applies. Both are logged.
 */
export function selectProbeOrder<T extends { order_id: string }>(
  candidates: T[],
  deferred: ReadonlySet<string>,
  limit: number,
  rotation = 0,
): T[] {
  const fresh: T[] = [];
  const retry: T[] = [];
  for (const row of candidates) {
    if (deferred.has(row.order_id)) retry.push(row);
    else fresh.push(row);
  }
  const budget = Math.max(0, limit);
  const picked = fresh.slice(0, budget);
  const spare = budget - picked.length;
  if (spare <= 0 || retry.length === 0) return picked;

  // AND THE RETRY TIER ROTATES, or it grows its own starvation class.
  //
  // Taking the leftover budget from the HEAD of the retry tier every tick is
  // the v1 bug again one level down: with more known-failing rows than there is
  // spare budget, the same head rows are retried for ever and a row further
  // back — a genuinely transient failure that would succeed on its next
  // attempt — is never tried again. Starting at an offset that advances once
  // per cron tick, by the size of the slice, walks the whole tier in
  // ceil(retry.length / slice) ticks whatever its size, and keeps the choice a
  // pure function of (rows, clock) so it can be asserted directly.
  //
  // The slice is a FRACTION of the budget, not all the leftovers. Retrying a
  // known-failing row is a real Shippo GET spent on a row that probably will not
  // settle; a large permanently-unrepairable backlog would otherwise burn the
  // full budget on it every thirty minutes, for ever. A quarter keeps the
  // recovery path open (a QUEUED transaction does settle, and a transient
  // outage does end) at a quarter of the cost.
  const slice = Math.max(1, Math.ceil(budget / 4));
  const retryBudget = Math.min(spare, slice);
  const start = (((rotation * retryBudget) % retry.length) + retry.length) % retry.length;
  for (let i = 0; i < retry.length && i < retryBudget; i++) {
    picked.push(retry[(start + i) % retry.length]);
  }
  return picked;
}

/**
 * The cron cadence (vercel.json), so the retry rotation advances by exactly one
 * SLICE per scheduled run and the whole retry tier is walked in
 * ceil(tier / slice) ticks.
 */
const RETRY_ROTATION_MS = 30 * 60 * 1000;

/** The order ids one alert's context is carrying, as a set. */
function backlogIdsFrom(context: unknown): Set<string> {
  const ids = new Set<string>();
  const bag = (context ?? {}) as Record<string, unknown>;
  // `orderIds` is the complete list; `orders` / `failures` are the human-readable
  // detail, capped at 25 for the operator's benefit. Read all three so an alert
  // written by an older build is still understood.
  for (const value of [bag.orderIds, bag.orders, bag.failures]) {
    if (!Array.isArray(value)) continue;
    for (const entry of value) {
      if (typeof entry === "string") ids.add(entry);
      else if (entry && typeof entry === "object") {
        const id = (entry as { orderId?: unknown }).orderId;
        if (id != null) ids.add(String(id));
      }
    }
  }
  return ids;
}

interface StoredBacklog {
  ids: Set<string>;
  /** The exact set already on file, for the state-change dedup. */
  reported: Set<string> | null;
  resolved: boolean;
}

/**
 * What the last UNRESOLVED alert of this type says is still outstanding.
 *
 * A RESOLVED alert is deliberately ignored: a human marking it resolved is a
 * statement that the backlog was dealt with, so those rows go back into the
 * fresh tier and are re-probed rather than being deferred for ever on the
 * strength of a stale row. That is what keeps this backlog from becoming the
 * next starvation class in its own right.
 */
async function loadBacklog(type: string): Promise<StoredBacklog> {
  const { data, error } = await supabaseAdmin
    .from("system_alerts")
    .select("context, resolved_at, created_at")
    .eq("type", type)
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) throw error;

  const latest = (data ?? [])[0] as
    | { context?: unknown; resolved_at?: string | null }
    | undefined;
  if (!latest) return { ids: new Set(), reported: null, resolved: false };
  const reported = backlogIdsFrom(latest.context);
  if (latest.resolved_at) return { ids: new Set(), reported, resolved: true };
  return { ids: reported, reported, resolved: false };
}

/** Both probe backlogs, or empty ones if they cannot be read. */
async function loadProbeBacklog(): Promise<{ manual: StoredBacklog; failed: StoredBacklog }> {
  const empty = (): StoredBacklog => ({ ids: new Set(), reported: null, resolved: false });
  try {
    const [manual, failed] = await Promise.all([
      loadBacklog(MANUAL_ENTRY_ALERT),
      loadBacklog(UNRECORDED_ALERT),
    ]);
    return { manual, failed };
  } catch (error) {
    // Degraded, not fatal: this run falls back to plain oldest-first, which is
    // still strictly better than not running. Never silent.
    console.error("Unable to read the shipping-cost probe backlog; this run is not deprioritising known failures", error);
    return { manual: empty(), failed: empty() };
  }
}

/**
 * Has this backlog CHANGED since it was last reported?
 *
 * These alerts describe a STANDING CONDITION, not an event: an order whose
 * postage cannot be read back stays that way until a human acts.
 * recordSystemAlert has no dedup of any kind, so re-reporting on every tick
 * wrote a row every thirty minutes for ever — roughly 48 a day, burying the
 * alerts that ARE events. The row is still written the moment the set changes,
 * so nothing new goes unreported.
 */
function backlogStateChanged(stored: StoredBacklog, current: Set<string>): boolean {
  if (stored.reported === null || stored.resolved) return true;
  if (stored.reported.size !== current.size) return true;
  for (const id of current) if (!stored.reported.has(id)) return true;
  return false;
}

/**
 * Every candidate in the window, oldest label first, read in cheap pages.
 *
 * `limit` deliberately does NOT appear here. Bounding the SELECT is what let a
 * handful of unrepairable rows decide which orders the sweep could even see.
 */
async function collectCandidates(since: string): Promise<{
  rows: ShippingCostCandidate[];
  truncated: boolean;
}> {
  // EVERY CONDITION THAT DEFINES A CANDIDATE BELONGS IN THE QUERY.
  //
  // `shippo_transaction_id IS NOT NULL` lived only in the JavaScript predicate,
  // so a thin transaction_created delivery (label_purchased_at with no
  // transaction id) filled the page forever and the run reported
  // {scanned:50, repaired:0, failed:0} — indistinguishable from "nothing to do".
  const page = (offset: number) =>
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
      // ABSENCE BELONGS IN THE QUERY, NOT IN JAVASCRIPT, or `limit` bounds the
      // rows SCANNED rather than the rows to repair.
      .is("actual_shipping_cost_cents", null)
      // order_id IS A TIEBREAK, NOT DECORATION. Labels bought in the same batch
      // share a label_purchased_at to the second, and without a total order the
      // page boundaries are not stable, so offset paging could skip a row.
      .order("label_purchased_at", { ascending: true })
      .order("order_id", { ascending: true })
      .range(offset, offset + CANDIDATE_PAGE_SIZE - 1);

  const rows: ShippingCostCandidate[] = [];
  let offset = 0;
  for (;;) {
    const { data, error } = await page(offset);
    // A sweep that cannot read is not a sweep that found nothing.
    if (error) throw error;
    const batch = (data ?? []) as ShippingCostCandidate[];
    rows.push(...batch);
    if (batch.length < CANDIDATE_PAGE_SIZE) return { rows, truncated: false };
    offset += CANDIDATE_PAGE_SIZE;
    if (offset >= MAX_CANDIDATE_SCAN) {
      // TRUNCATION IS A CLAIM ABOUT ROWS WE DID NOT READ, SO PROVE IT: a window
      // of exactly MAX_CANDIDATE_SCAN has in fact been read in full.
      const probe = await page(offset);
      if (probe.error) throw probe.error;
      return { rows, truncated: (probe.data ?? []).length > 0 };
    }
  }
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

  const { rows, truncated } = await collectCandidates(since);
  // Second line of defence: the same rule as a pure predicate, so the sweep is
  // still correct if the query above is ever loosened.
  const candidates = findOrdersMissingShippingCost(rows);
  result.scanned = rows.length;
  if (truncated) result.scanTruncated = true;

  const backlog = await loadProbeBacklog();
  const liveIds = new Set(candidates.map((row) => row.order_id));
  // PRUNE THE BACKLOG AGAINST WHAT IS ACTUALLY STILL OUTSTANDING. A row a human
  // finally typed a cost into is no longer a candidate, so it must leave the
  // backlog — otherwise the alert grows for ever and its `total` lies. Only
  // safe when the whole window was read: with a truncated scan, "not among the
  // candidates" may just mean "beyond the ceiling".
  const prune = (ids: Set<string>) =>
    truncated ? new Set(ids) : new Set([...ids].filter((id) => liveIds.has(id)));
  const carriedManual = prune(backlog.manual.ids);
  const carriedFailed = prune(backlog.failed.ids);

  const deferred = new Set([...carriedManual, ...carriedFailed]);
  const selected = selectProbeOrder(
    candidates,
    deferred,
    limit,
    Math.floor(now.getTime() / RETRY_ROTATION_MS),
  );

  const failures: Array<{ orderId: string; error: string }> = [];
  const manual: Array<{ orderId: string; error: string }> = [];
  const repaired = new Set<string>();

  for (const order of selected) {
    try {
      const amountCents = await resolveSettledCents(order);
      const recorded = await recordActualShippingCost({
        orderId: order.order_id,
        amountCents,
        source: "shippo",
      });
      if (!recorded.ok) throw new Error(recorded.error ?? "recordActualShippingCost failed");
      result.repaired += 1;
      repaired.add(order.order_id);
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

  // THE BACKLOG IS WHAT THIS RUN LEARNED, PLUS WHAT IT DID NOT RE-EXAMINE.
  //
  // A row probed this run is classified by THIS run's outcome (so a hand-entry
  // case that has since errored moves sides, and a repaired one leaves
  // altogether). A row this run had no budget for keeps the classification it
  // already had. That is what makes the next run's fresh tier exactly "rows
  // whose outcome is unknown".
  const probed = new Set(selected.map((row) => row.order_id));
  const nextManual = new Set(manual.map((entry) => entry.orderId));
  const nextFailed = new Set(failures.map((entry) => entry.orderId));
  for (const id of carriedManual) {
    if (!probed.has(id) && !nextFailed.has(id)) nextManual.add(id);
  }
  for (const id of carriedFailed) {
    if (!probed.has(id) && !nextManual.has(id)) nextFailed.add(id);
  }
  for (const id of repaired) {
    nextManual.delete(id);
    nextFailed.delete(id);
  }

  await reportBacklog({
    type: UNRECORDED_ALERT,
    stored: backlog.failed,
    current: nextFailed,
    detail: failures,
    detailKey: "failures",
    severity: "critical",
    message:
      `${nextFailed.size} order(s) bought a shipping label but still have no recorded postage. `
      + "Profit for these orders is charging the flat shipping estimate instead of the real label cost.",
  });

  await reportBacklog({
    type: MANUAL_ENTRY_ALERT,
    stored: backlog.manual,
    current: nextManual,
    detail: manual,
    detailKey: "orders",
    // A BACKLOG THE SWEEP CANNOT SHRINK IS NOT A WARNING once it is large.
    // It no longer halts the sweep — unrepairable rows only ever get leftover
    // budget now — but a pile of orders needing hand entry still has to reach a
    // person. Below the per-run budget it stays a standing warning.
    severity: nextManual.size >= limit ? "critical" : "warning",
    message:
      `${nextManual.size} order(s) have a label whose postage cannot be read back from Shippo. `
      + "Enter the cost by hand in Admin -> Orders; no automatic repair is possible. "
      + "These orders no longer consume the sweep's Shippo budget ahead of repairable ones.",
  });

  if (truncated) {
    await reportBacklog({
      type: SCAN_TRUNCATED_ALERT,
      stored: await loadTruncationState(),
      current: new Set(["truncated"]),
      detail: [],
      detailKey: "orders",
      severity: "critical",
      message:
        `The shipping-cost sweep hit its ${MAX_CANDIDATE_SCAN}-row candidate ceiling with rows still unread, `
        + "so labels behind that point cannot be reached and their postage will not be recorded automatically.",
      extraContext: { scanned: result.scanned, maxCandidateScan: MAX_CANDIDATE_SCAN },
    });
  }

  return result;
}

async function loadTruncationState(): Promise<StoredBacklog> {
  try {
    return await loadBacklog(SCAN_TRUNCATED_ALERT);
  } catch {
    return { ids: new Set(), reported: null, resolved: false };
  }
}

/**
 * Write one backlog alert, but only when the backlog actually changed.
 *
 * `orderIds` carries the COMPLETE set — the previous shape stored only the
 * capped 25-entry detail list and a `total`, so anything past the cap silently
 * dropped out of the reported backlog and out of anything reading it back.
 */
async function reportBacklog(input: {
  type: string;
  stored: StoredBacklog;
  current: Set<string>;
  detail: Array<{ orderId: string; error: string }>;
  detailKey: "orders" | "failures";
  severity: "critical" | "warning";
  message: string;
  extraContext?: Record<string, unknown>;
}): Promise<void> {
  if (input.current.size === 0) return;
  // BOUNDED, because this list is a JSONB column and not a table. Past the cap
  // the sweep degrades gracefully rather than incorrectly: the dropped rows go
  // back into the fresh tier and cost one Shippo call each to re-learn.
  //
  // THE DEDUP COMPARES WHAT IS ACTUALLY WRITTEN. Comparing the uncapped set
  // against a capped stored list would report a size mismatch on every single
  // tick once the backlog passed the cap — a storm built out of the very check
  // meant to prevent one.
  const orderIds = [...input.current].slice(0, MAX_BACKLOG_IDS);
  if (!backlogStateChanged(input.stored, new Set(orderIds))) return;
  await recordSystemAlert({
    type: input.type,
    severity: input.severity,
    message: input.message,
    context: {
      [input.detailKey]: input.detail.slice(0, 25),
      orderIds,
      total: orderIds.length,
      ...(input.type === UNRECORDED_ALERT ? { totalFailed: orderIds.length } : {}),
      ...(input.extraContext ?? {}),
    },
  }).catch((alertError) => {
    // The backlog is persisted BY this row. A write failure means the next run
    // treats these rows as unknown again and spends budget re-learning what it
    // already knew — degraded, not incorrect, and never silent.
    console.error(`Unable to record a ${input.type} alert`, alertError);
  });
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
  // no `postageCostCents` on it.
  //
  // A DASHBOARD LABEL IS NOT A HAND-ENTRY CASE. When the label was bought in
  // Shippo's dashboard the transaction comes back with `rate` as a bare
  // object_id string, which carries no price — and that shape was declared
  // unrecoverable here, so every such label raised ManualEntryRequired and sat
  // in the manual-entry backlog permanently, re-alerting the operator about a
  // figure Shippo would have answered on request. settledCentsForTransaction
  // resolves the reference with a GET on /rates/<id> (which cannot buy
  // anything) and only gives up when the price truly cannot be established.
  const amountCents = await settledCentsForTransaction(transaction.data);
  if (amountCents == null) {
    throw new ManualEntryRequired("Shippo returned no usable postage amount on the transaction rate");
  }
  return amountCents;
}
