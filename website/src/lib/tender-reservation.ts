import { supabaseAdmin } from "@/lib/supabase-server";
import {
  STORE_CREDIT_REDEMPTION_REASON,
  startOfCurrentMonthIso,
} from "@/lib/store-credit";
import { POINTS_REDEMPTION_REASON } from "@/lib/membership";

// ---------------------------------------------------------------------------
// NON-CASH TENDER IS HELD AT CHECKOUT, THE WAY STOCK IS.
//
// VL-11 / MPC-01. Store credit and loyalty points were READ at quote time and
// DEBITED at settlement, with nothing in between. Between those two moments the
// balance was unclaimed, so it funded as many orders as the shopper could start:
//
//   $50 credit, two tabs. Both quotes read $50 and both orders are written with
//   $50 off. Both cards are charged the reduced amount. At settlement
//   redeemStoreCredit clamps to the live balance, so the ledger debits $50 once
//   and declines the second — the balance never goes negative, and that is
//   exactly why nothing ever surfaced. The store simply gave away $100 of
//   discount for $50 of liability, quietly, and the more valuable the balance
//   the more copies of it a shopper could spend.
//
// The same shape as overselling stock, and the store already solved that one:
// inventory-reservation.ts holds the units atomically the instant a checkout
// begins, releases them on failure/cancel/expiry, and finalizes on the paid
// webhook. This module is that contract for money-like balances.
//
// THE HOLD *IS* THE REDEMPTION. There is no separate reservation table and no
// second source of truth: the hold is the ordinary ledger debit, written early
// and keyed to the order. So the balance the next quote reads is already net of
// it, refunds keep reading the same row they always did, and settlement has
// nothing left to do (redeemStoreCredit / redeemPoints both no-op when the
// order's debit is already standing). Releasing a hold DELETES that row rather
// than posting a compensating credit — a checkout that was abandoned is not an
// event in the customer's balance history, and a hold plus a reversal would
// double-count on any later refund that sums the debits.
//
// HOW THE CLAIM IS ATOMIC WITHOUT A LOCK. PostgREST cannot express
// "check the balance and debit it" in one statement, and a read-then-write is a
// race by construction — the very bug being fixed. So the debit is written
// FIRST and validated after: every writer then sums the ledger in one fixed
// order (created_at, id) and keeps its row only if the running balance is still
// solvent up to and including its own row. Two racing $50 claims against $50
// therefore agree on which of them came first — the loser sees its own row
// leave the balance negative and deletes it. The claim can be refused when it
// did not have to be (a claim that raced and lost is refused even if the winner
// is later released), and that is the safe direction: a refused claim shows the
// shopper a refreshed total, an accepted one spends money that is not there.
// ---------------------------------------------------------------------------

/**
 * Where a balance lives. The two ledgers differ in table, column and expiry
 * rule; the claim algorithm does not, and is written once below.
 */
interface LedgerSpec {
  table: "store_credit_ledger" | "points_ledger";
  /** Signed amount column: negative rows are spends. */
  amountColumn: "amount_cents" | "amount";
  /** The debit reason this ledger already uses for an order redemption. */
  reason: string;
  /** Human name, for the message a refused claim shows the shopper. */
  label: string;
  /**
   * Rows before this instant do not count toward the spendable balance, or null
   * when the whole ledger counts. Store credit is use-it-or-lose-it monthly, so
   * its window has to match getStoreCreditBalanceCents exactly — a claim
   * validated against a wider window would authorise spending expired credit.
   */
  windowStartIso: () => string | null;
}

const STORE_CREDIT: LedgerSpec = {
  table: "store_credit_ledger",
  amountColumn: "amount_cents",
  reason: STORE_CREDIT_REDEMPTION_REASON,
  label: "store credit",
  windowStartIso: () => startOfCurrentMonthIso(),
};

const POINTS: LedgerSpec = {
  table: "points_ledger",
  amountColumn: "amount",
  reason: POINTS_REDEMPTION_REASON,
  label: "rewards points",
  windowStartIso: () => null,
};

/** A missing table means the migration has not run — never a checkout failure. */
function isMissingTable(error: unknown): boolean {
  return String((error as { code?: unknown } | null)?.code ?? "") === "42P01";
}

interface LedgerRow {
  id: unknown;
  created_at: unknown;
  [column: string]: unknown;
}

/** The one ordering every writer agrees on, so exactly one of them wins a race. */
function inLedgerOrder(a: LedgerRow, b: LedgerRow): number {
  const byTime = String(a.created_at ?? "").localeCompare(String(b.created_at ?? ""));
  return byTime !== 0 ? byTime : String(a.id ?? "").localeCompare(String(b.id ?? ""));
}

/** Rows already debited against this order, if any. */
async function existingHold(spec: LedgerSpec, orderId: string): Promise<number | null> {
  const { data, error } = await supabaseAdmin
    .from(spec.table)
    .select(`id, ${spec.amountColumn}`)
    .eq("order_id", orderId)
    .eq("reason", spec.reason);

  if (error) {
    if (isMissingTable(error)) return null;
    throw error;
  }
  if (!data || data.length === 0) return null;
  return data.reduce(
    (sum, row) => sum + Math.abs(Number((row as Record<string, unknown>)[spec.amountColumn] ?? 0)),
    0,
  );
}

/**
 * Claim `amount` of a balance for one order, or refuse.
 *
 * Idempotent per order: a retried checkout submit finds its own hold and keeps
 * it rather than debiting twice.
 */
async function claim(
  spec: LedgerSpec,
  userId: string,
  orderId: string,
  amount: number,
): Promise<boolean> {
  const wanted = Math.round(amount);
  if (!userId || !Number.isFinite(wanted) || wanted <= 0) return true;

  const held = await existingHold(spec, orderId);
  if (held !== null) return held >= wanted;

  const nowIso = new Date().toISOString();
  const { data: inserted, error: insertError } = await supabaseAdmin
    .from(spec.table)
    .insert({
      user_id: userId,
      [spec.amountColumn]: -wanted,
      reason: spec.reason,
      order_id: orderId,
      created_at: nowIso,
    })
    .select("id, created_at");

  if (insertError) {
    // No ledger table means no balance was ever offered, so there is nothing to
    // hold and nothing to refuse — the quote read 0 from the same absence.
    if (isMissingTable(insertError)) return true;
    throw insertError;
  }

  const ours = (inserted ?? [])[0] as LedgerRow | undefined;
  if (!ours) return true;

  // Was the balance actually there? Sum the ledger in the agreed order and stop
  // at our own row: everything ahead of us has a prior claim on it.
  const windowStart = spec.windowStartIso();
  let query = supabaseAdmin
    .from(spec.table)
    .select(`id, created_at, ${spec.amountColumn}`)
    .eq("user_id", userId);
  if (windowStart) query = query.gte("created_at", windowStart);
  const { data: ledger, error: readError } = await query;
  if (readError) {
    // Cannot prove the claim is solvent. Take it back rather than assume.
    await releaseHold(spec, orderId);
    throw readError;
  }

  const rows = ((ledger ?? []) as LedgerRow[]).slice().sort(inLedgerOrder);
  let running = 0;
  for (const row of rows) {
    running += Number(row[spec.amountColumn] ?? 0);
    if (String(row.id) === String(ours.id)) break;
  }

  if (running < 0) {
    await releaseHold(spec, orderId);
    return false;
  }
  return true;
}

/** Delete this order's hold rows. Returns how many were returned to the balance. */
async function releaseHold(spec: LedgerSpec, orderId: string): Promise<number> {
  const held = await existingHold(spec, orderId);
  if (held === null || held <= 0) return 0;

  const { error } = await supabaseAdmin
    .from(spec.table)
    .delete()
    .eq("order_id", orderId)
    .eq("reason", spec.reason);

  if (error) {
    if (isMissingTable(error)) return 0;
    throw error;
  }
  return held;
}

export interface TenderReservation {
  ok: boolean;
  /** Which balance came up short, for the message and the alert. */
  shortOf: string | null;
}

/**
 * Hold the store credit and points an order was quoted with, all-or-nothing.
 *
 * Called once the order row exists and before the shopper is sent to the
 * processor: from here on the balance belongs to this order and every other
 * quote sees it gone. A refusal means the balance moved under the shopper
 * between quoting and submitting, which is exactly the case the old code
 * settled by silently giving the discount away twice.
 */
export async function reserveOrderTender(input: {
  orderId: string;
  userId: string | null;
  storeCreditCents: number;
  pointsRedeemed: number;
}): Promise<TenderReservation> {
  const userId = input.userId ?? "";
  const credit = Math.round(Number(input.storeCreditCents ?? 0));
  const points = Math.round(Number(input.pointsRedeemed ?? 0));
  if (!userId || (credit <= 0 && points <= 0)) return { ok: true, shortOf: null };

  if (!(await claim(STORE_CREDIT, userId, input.orderId, credit))) {
    return { ok: false, shortOf: STORE_CREDIT.label };
  }

  if (!(await claim(POINTS, userId, input.orderId, points))) {
    // All-or-nothing: an order that cannot hold every balance it was priced
    // with holds none of them, mirroring reserveInventoryForOrder.
    await releaseHold(STORE_CREDIT, input.orderId);
    return { ok: false, shortOf: POINTS.label };
  }

  return { ok: true, shortOf: null };
}

/** What the shopper is told when a balance moved out from under their checkout. */
export function describeTenderShortfall(shortOf: string | null): string {
  const balance = shortOf ?? "balance";
  return `Your ${balance} balance changed while you were checking out, so your total is out of date. Please refresh and try again — no charge was made.`;
}

/**
 * Hand an order's held balances back.
 *
 * Refuses on an order that has been paid: its hold is a real redemption, and
 * deleting it would hand back money the customer has already spent. Every other
 * state is fair game — the caller (a cancelled checkout, a declined wallet
 * charge, the sweep below) knows the order will never settle.
 */
export async function releaseOrderTender(orderId: string): Promise<number> {
  const { data: order, error } = await supabaseAdmin
    .from("orders")
    .select("payment_status")
    .eq("order_id", orderId)
    .maybeSingle();
  if (error) throw error;

  const status = String(order?.payment_status ?? "").toLowerCase();
  if (status === "paid" || status === "refunded" || status === "partially_refunded") return 0;

  const credit = await releaseHold(STORE_CREDIT, orderId);
  const points = await releaseHold(POINTS, orderId);
  return credit + points;
}

/** Orders whose held balance is never coming back on its own. */
const DEAD_ORDER_STATUSES = ["canceled", "cancelled", "payment_failed", "failed", "expired"];

/**
 * How long a still-pending order may keep holding a balance.
 *
 * Longer than the longest inventory hold (manual payments, 24h) on purpose: a
 * released hold is re-taken at settlement if the order does eventually pay
 * (redeemStoreCredit / redeemPoints still clamp to the live balance), but a
 * shopper whose credit is locked up cannot spend it anywhere in the meantime.
 * 48h is the point at which an unpaid checkout is abandoned rather than slow.
 */
const ABANDONED_HOLD_HOURS = 48;

const HELD_ORDER_COLUMNS = "order_id, payment_status, store_credit_redeemed_cents, points_redeemed";

/** The two order columns that say a hold may exist. */
const HOLD_COLUMNS = ["store_credit_redeemed_cents", "points_redeemed"] as const;

/**
 * Orders examined per tick, per (state, balance) pair.
 *
 * The queries below are filtered on the balance columns and read NEWEST FIRST,
 * which is what keeps the sweep from starving: an order that has already been
 * released still matches (its order row is unchanged), so a batch ordered the
 * other way would re-examine the same ancient rows forever and never reach the
 * live ones. A hold is taken at checkout and this runs on the cron sweep, so the
 * orders that still hold anything are always among the most recent.
 */
const HOLD_SWEEP_BATCH = 200;

/**
 * Return the balances held by checkouts that will never settle.
 *
 * The safety net behind the explicit releases on the checkout paths: an admin
 * cancellation, a lost processor session, a browser closed at the payment
 * screen. Idempotent — an order with nothing held is a no-op — so it is safe on
 * every tick, and releaseOrderTender refuses anything that has been paid.
 */
export async function releaseAbandonedTenderHolds(): Promise<number> {
  const cutoff = new Date(Date.now() - ABANDONED_HOLD_HOURS * 3_600_000).toISOString();

  const batches = await Promise.all(
    HOLD_COLUMNS.flatMap((column) => [
      supabaseAdmin
        .from("orders")
        .select(HELD_ORDER_COLUMNS)
        .in("payment_status", DEAD_ORDER_STATUSES)
        .gt(column, 0)
        .order("created_at", { ascending: false })
        .limit(HOLD_SWEEP_BATCH),
      supabaseAdmin
        .from("orders")
        .select(HELD_ORDER_COLUMNS)
        .eq("payment_status", "pending_payment")
        .lt("created_at", cutoff)
        .gt(column, 0)
        .order("created_at", { ascending: false })
        .limit(HOLD_SWEEP_BATCH),
    ]),
  );

  const orderIds = new Set<string>();
  for (const batch of batches) {
    if (batch.error) throw batch.error;
    for (const row of batch.data ?? []) {
      const orderId = String((row as Record<string, unknown>).order_id ?? "");
      if (orderId) orderIds.add(orderId);
    }
  }

  let released = 0;
  for (const orderId of orderIds) {
    if ((await releaseOrderTender(orderId)) > 0) released += 1;
  }
  return released;
}
