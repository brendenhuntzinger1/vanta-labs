import "server-only";

import { PAID_ORDER_STATUSES, isProductPurchaseOrder } from "@/lib/ledger";
import { syncOmnisendCatalog, type OmnisendCatalogSyncResult } from "@/lib/marketing/omnisend/catalog-sync";
import { omnisendActive } from "@/lib/marketing/omnisend/client";
import { omnisendLedger } from "@/lib/marketing/omnisend/ledger";
import { onOrderPaid } from "@/lib/marketing/omnisend/order-hooks";
import { reconcileOmnisendContacts, type OmnisendReconcileResult } from "@/lib/marketing/omnisend/reconcile";
import { emptyReconcileReport } from "@/lib/marketing/omnisend/reconcile-plan";
import { readSyncState, writeSyncState } from "@/lib/marketing/omnisend/sync-state";
import { supabaseAdmin } from "@/lib/supabase-server";

/**
 * The Omnisend cron jobs (design spec §4, `sweeps.ts`).
 *
 * Three jobs, all registered in /api/cron/sweep, all idempotent, none of
 * which may throw — a marketing sync that fails is a log line and a result,
 * never a cron alert at 2am for the operator to chase:
 *
 *   * omnisendOrderBackstop — a paid order whose `paid for order` never
 *     reached Omnisend is reported. The webhook reports on the request path
 *     inside after(), and an after() callback dies with the function; this is
 *     the retry. The event ledger (order-hooks.ts, ledger.ts) makes the retry
 *     exactly-once: the claim is an insert, so the sweep and a late callback
 *     cannot both send. A claim that is undelivered and old enough to be dead
 *     is handed back first, so an order Omnisend refused is retried rather
 *     than stranded behind its own claim.
 *
 *   * omnisendCatalogSyncJob — the catalogue push, at most once per six
 *     hours. The push is a full replace and cheap, but 48 pushes a day of a
 *     catalogue that changes weekly buys nothing.
 *
 *   * omnisendContactsReconcileJob — the contacts reconcile and write-back,
 *     at most once per twenty-four hours. It walks the whole audience, so it
 *     is the one job here that could use the sweep's entire budget.
 *
 * The two cadence jobs keep their "last ran" stamp in omnisend_sync_state,
 * under keys of their own so they cannot collide with the reconcile's
 * watermark, and decide with a pure function so the cadence can be tested
 * without a clock or a database. The stamp is written AFTER a run completes,
 * so a run the platform killed is retried on the next tick rather than
 * counted as done.
 *
 * Every job asks the gate before any database read. A preview deployment or
 * a build without a key returns having touched nothing.
 */

const LOG = "[omnisend/sweeps]";

// ---------------------------------------------------------------------------
// Order backstop
// ---------------------------------------------------------------------------

/** Orders older than this are not retried: the post-purchase flow has passed. */
export const OMNISEND_BACKSTOP_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
/**
 * An undelivered claim older than this belongs to nothing that is still
 * running. A webhook's after() callback lives at most as long as its
 * function (60s here); fifteen minutes is far past that, and short enough
 * that a refused send is retried on the next few ticks rather than tomorrow.
 */
export const OMNISEND_STALE_CLAIM_MS = 15 * 60 * 1000;
const DEFAULT_BACKSTOP_LIMIT = 50;
/** Rows read per tick; the window holds far fewer paid orders than this. */
const BACKSTOP_READ_LIMIT = 200;
const PAID_EVENT = "paid for order";
const ORDER_EVENTS = ["placed order", PAID_EVENT];

export type BackstopOrderRow = {
  order_id: string;
  payment_status?: string | null;
  order_type?: string | null;
  replacement_of?: string | null;
  paid_at?: string | null;
  created_at?: string | null;
};

export type BackstopLedgerRow = {
  entity_id: string;
  event_name: string;
  delivered: boolean;
  first_sent_at?: string | null;
};

export type OmnisendOrderBackstopResult = {
  /** Paid product orders in the window that had no delivered `paid for order`. */
  scanned: number;
  /** How many `paid for order` events this run delivered. */
  sent: number;
  skipped: string | null;
};

function paidAtMs(order: BackstopOrderRow): number {
  const stamp = order.paid_at ?? order.created_at;
  if (!stamp) return Number.NaN;
  return new Date(stamp).getTime();
}

/**
 * Pure: which of these orders still owe Omnisend a `paid for order`.
 *
 * Paid (any status the ledger calls paid), a purchase of product (not a
 * membership charge or a reship), paid inside the lookback, and without a
 * DELIVERED `paid for order` row. An undelivered row does not exclude the
 * order — that is the refused send the backstop exists to retry — and a
 * delivered `placed order` alone does not either, because the post-purchase
 * flows trigger on the paid event.
 */
export function ordersNeedingOmnisendPaid(
  orders: BackstopOrderRow[],
  ledgerRows: BackstopLedgerRow[],
  now: Date = new Date(),
  /**
   * THE FLOOR (AUDIT F-02). Orders paid before the integration went live are
   * never pushed: the first tick after the key is set must not enrol a week of
   * old orders into post-purchase, replenishment and win-back at once, and
   * the in-house post-purchase may already have mailed them. Milliseconds
   * since the epoch; absent means no floor (tests, and a run before the
   * record exists).
   */
  notBeforeMs?: number,
): BackstopOrderRow[] {
  const delivered = new Set(
    ledgerRows.filter((row) => row.event_name === PAID_EVENT && row.delivered).map((row) => row.entity_id),
  );
  const seen = new Set<string>();
  return orders.filter((order) => {
    if (!order.order_id || seen.has(order.order_id)) return false;
    if (!PAID_ORDER_STATUSES.has(String(order.payment_status ?? "").toLowerCase())) return false;
    if (!isProductPurchaseOrder(order)) return false;
    if (delivered.has(order.order_id)) return false;
    const paidAt = paidAtMs(order);
    if (!Number.isFinite(paidAt) || now.getTime() - paidAt > OMNISEND_BACKSTOP_LOOKBACK_MS) return false;
    if (typeof notBeforeMs === "number" && Number.isFinite(notBeforeMs) && paidAt < notBeforeMs) return false;
    seen.add(order.order_id);
    return true;
  });
}

/**
 * Pure: the undelivered claims old enough to be dead. The ledger's own
 * release deletes only an undelivered row, so handing one of these back can
 * never reopen a delivered event.
 */
export function staleOmnisendClaims(
  ledgerRows: BackstopLedgerRow[],
  now: Date = new Date(),
): Array<{ entityId: string; eventName: string }> {
  return ledgerRows
    .filter((row) => {
      if (row.delivered) return false;
      if (!row.first_sent_at) return false;
      const at = new Date(row.first_sent_at).getTime();
      return Number.isFinite(at) && now.getTime() - at > OMNISEND_STALE_CLAIM_MS;
    })
    .map((row) => ({ entityId: row.entity_id, eventName: row.event_name }));
}

export async function omnisendOrderBackstop(opts: { now?: Date; limit?: number } = {}): Promise<OmnisendOrderBackstopResult> {
  const gate = omnisendActive();
  if (!gate.active) return { scanned: 0, sent: 0, skipped: gate.reason };

  const now = opts.now ?? new Date();
  const limit = Math.max(0, Math.trunc(Number(opts.limit ?? DEFAULT_BACKSTOP_LIMIT) || 0));
  let scanned = 0;
  let sent = 0;
  try {
    // THE FLOOR, read before any order is: the first run stamps now and pushes
    // nothing older; every later run pushes only what was paid after that. A
    // stamp that cannot be written leaves no floor for THIS run, which would
    // report the week — so an unwritable stamp means the run does nothing.
    const record = await readSyncState<BackstopFloorRecord>(ORDER_BACKSTOP_KEY, LOG);
    let floor = Date.parse(String(record?.since ?? ""));
    if (!Number.isFinite(floor)) {
      const stamped = await writeSyncState(ORDER_BACKSTOP_KEY, { since: now.toISOString() }, LOG);
      if (!stamped) return { scanned, sent, skipped: "backstop floor could not be recorded; nothing pushed" };
      floor = now.getTime();
    }

    // paid_at is the moment that matters; a row from before the column was
    // stamped falls back to created_at, the same fallback the filter applies.
    const since = new Date(Math.max(now.getTime() - OMNISEND_BACKSTOP_LOOKBACK_MS, floor)).toISOString();
    const { data: orders, error: ordersError } = await supabaseAdmin
      .from("orders")
      .select("order_id, payment_status, order_type, replacement_of, paid_at, created_at")
      .in("payment_status", Array.from(PAID_ORDER_STATUSES))
      .or(`paid_at.gte.${since},and(paid_at.is.null,created_at.gte.${since})`)
      .order("created_at", { ascending: false })
      .limit(BACKSTOP_READ_LIMIT);
    if (ordersError) {
      console.error(LOG, "order read refused", ordersError.message);
      return { scanned, sent, skipped: `order read refused: ${ordersError.message}` };
    }
    const rows = (orders ?? []) as BackstopOrderRow[];
    if (rows.length === 0) return { scanned, sent, skipped: null };

    const { data: ledger, error: ledgerError } = await supabaseAdmin
      .from("omnisend_events_sent")
      .select("entity_id, event_name, delivered, first_sent_at")
      .in("entity_id", rows.map((row) => row.order_id))
      .in("event_name", ORDER_EVENTS);
    if (ledgerError) {
      // Without the ledger, "unsent" cannot be told from "sent": do nothing
      // rather than re-report every paid order in the window.
      console.error(LOG, "ledger read refused", ledgerError.message);
      return { scanned, sent, skipped: `ledger read refused: ${ledgerError.message}` };
    }
    const ledgerRows = (ledger ?? []) as BackstopLedgerRow[];

    const pending = ordersNeedingOmnisendPaid(rows, ledgerRows, now, floor);
    scanned = pending.length;
    if (pending.length === 0) return { scanned, sent, skipped: null };

    // Hand back the claims nothing is still holding, so the retry below can
    // take them. A claim younger than the threshold may belong to an after()
    // callback that is still running; it is left alone and seen next tick.
    const stale = staleOmnisendClaims(ledgerRows, now);
    for (const claim of stale) {
      await omnisendLedger(claim.entityId).releaseSend(claim.eventName);
    }

    const batch = pending.slice(0, limit);
    for (const candidate of batch) {
      const delivered = await onOrderPaid(candidate.order_id);
      if (delivered) sent += 1;
    }

    const notes: string[] = [];
    if (stale.length > 0) notes.push(`${stale.length} stale claim(s) released`);
    if (pending.length > batch.length) notes.push(`${pending.length - batch.length} left for the next run`);
    console.info(LOG, "order backstop", { scanned, sent, attempted: batch.length, stale: stale.length });
    return { scanned, sent, skipped: notes.length > 0 ? notes.join("; ") : null };
  } catch (error) {
    console.error(LOG, "order backstop threw", error);
    return { scanned, sent, skipped: `order backstop threw: ${error instanceof Error ? error.message : String(error)}` };
  }
}

// ---------------------------------------------------------------------------
// Cadence
// ---------------------------------------------------------------------------

/**
 * omnisend_sync_state row `{ since }`: the instant the backstop first ran with
 * the integration live. Orders paid before it are the in-house engine's and
 * are never reported (F-02). Written once; a later run only reads it.
 */
const ORDER_BACKSTOP_KEY = "order_backstop";
type BackstopFloorRecord = { since?: string };
const CATALOG_SYNC_KEY = "catalog_sync";
const CONTACTS_RECONCILE_KEY = "contacts_reconcile_cadence";
const CATALOG_SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000;
const CONTACTS_RECONCILE_INTERVAL_MS = 24 * 60 * 60 * 1000;

type CadenceRecord = { lastRunAt?: string | null };

export type CadenceDecision = { due: true; skipped: null } | { due: false; skipped: string };

/**
 * Pure: is a cadence-limited job due?
 *
 * Due when nothing is recorded, when the record cannot be read as a date, or
 * when the stamp is in the future — a bad record must make the job run, not
 * stall it until someone notices. Otherwise due once the interval has fully
 * elapsed, and the refusal says how long ago it ran in whole minutes, which
 * is what an operator reading the sweep output wants to know.
 */
export function cadenceDecision(input: { lastRunAt: string | null | undefined; now: number; intervalMs: number }): CadenceDecision {
  const stamp = String(input.lastRunAt ?? "").trim();
  if (!stamp) return { due: true, skipped: null };
  const last = new Date(stamp).getTime();
  if (!Number.isFinite(last)) return { due: true, skipped: null };
  const elapsed = input.now - last;
  if (elapsed < 0 || elapsed >= input.intervalMs) return { due: true, skipped: null };
  const minutes = Math.floor(elapsed / 60_000);
  return { due: false, skipped: `ran ${minutes} minute${minutes === 1 ? "" : "s"} ago` };
}

export async function omnisendCatalogSyncJob(): Promise<OmnisendCatalogSyncResult> {
  const gate = omnisendActive();
  if (!gate.active) return { products: 0, categories: 0, batches: 0, skipped: gate.reason };

  try {
    const startedAt = new Date();
    const record = await readSyncState<CadenceRecord>(CATALOG_SYNC_KEY, LOG);
    const decision = cadenceDecision({ lastRunAt: record?.lastRunAt, now: startedAt.getTime(), intervalMs: CATALOG_SYNC_INTERVAL_MS });
    if (!decision.due) return { products: 0, categories: 0, batches: 0, skipped: decision.skipped };

    const result = await syncOmnisendCatalog();
    // Stamped with the START of the run, so the next run is due six hours
    // after this one began rather than after it finished.
    await writeSyncState(CATALOG_SYNC_KEY, { lastRunAt: startedAt.toISOString() }, LOG);
    return result;
  } catch (error) {
    console.error(LOG, "catalog sync job threw", error);
    return { products: 0, categories: 0, batches: 0, skipped: `catalog sync job threw: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** A run that did nothing: zero counts and an empty report, built fresh so no caller shares one object. */
function emptyReconcile(): Omit<OmnisendReconcileResult, "skipped"> {
  return {
    pushed: 0,
    suppressed: 0,
    smsOptOuts: 0,
    formSubscribers: 0,
    winbackCodes: 0,
    dryRun: false,
    report: emptyReconcileReport(),
  };
}

export async function omnisendContactsReconcileJob(): Promise<OmnisendReconcileResult> {
  const gate = omnisendActive();
  if (!gate.active) return { ...emptyReconcile(), skipped: gate.reason };

  try {
    const startedAt = new Date();
    const record = await readSyncState<CadenceRecord>(CONTACTS_RECONCILE_KEY, LOG);
    const decision = cadenceDecision({ lastRunAt: record?.lastRunAt, now: startedAt.getTime(), intervalMs: CONTACTS_RECONCILE_INTERVAL_MS });
    if (!decision.due) return { ...emptyReconcile(), skipped: decision.skipped };

    const result = await reconcileOmnisendContacts();
    await writeSyncState(CONTACTS_RECONCILE_KEY, { lastRunAt: startedAt.toISOString() }, LOG);
    return result;
  } catch (error) {
    console.error(LOG, "contacts reconcile job threw", error);
    return { ...emptyReconcile(), skipped: `contacts reconcile job threw: ${error instanceof Error ? error.message : String(error)}` };
  }
}
