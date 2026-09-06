import { supabaseAdmin } from "@/lib/supabase-server";
import { isTransientAuthRejection } from "@/lib/inventory-reservation";
import {
  STORE_CREDIT_REDEMPTION_REASON,
  startOfCurrentMonthIso,
} from "@/lib/store-credit";
import { POINTS_REDEMPTION_REASON } from "@/lib/membership";
import { UNPAID_STATUSES } from "@/lib/order-status";
import { readAllRowsBounded } from "@/lib/supabase-page";

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
// HOW THE CLAIM IS ATOMIC: ONE LOCKED FUNCTION IN THE DATABASE.
//
// claim_store_credit_hold / claim_points_hold (src/lib/sql/tender-hold-claim.sql)
// take one advisory lock on the customer's ledger, sum the spendable window and
// write the debit — all inside one transaction. Two racing claims against the
// same balance serialise on that lock, so the second one counts the first.
//
// THIS REPLACED A PROOF THAT DID NOT HOLD, and the failure is worth stating
// because the argument was persuasive. PostgREST cannot express "check the
// balance and debit it" in one statement, so the debit used to be written FIRST
// and validated after: every writer summed the ledger in one fixed order
// (created_at, id) and kept its row only if the running balance was still
// solvent up to and including its own row. Two racing $50 claims against $50
// were supposed to agree on which came first, with the loser seeing its own row
// leave the balance negative and deleting it.
//
// Nothing made the loser SEE the winner. The insert and the validating read are
// two independent round trips under READ COMMITTED, so a claim that is LATER in
// the agreed order can finish its read before the earlier claim's insert has
// committed, sum a ledger that does not contain its rival, and approve itself.
// Reproduced against the real schema through this very function: one user with
// exactly 5000 cents, two concurrent claims of 5000 for two different orders,
// 250 rounds — 2 double spends. Both orders priced $50 off, both cards were
// charged the reduced amount, and the ledger netted to -$50 having given away
// $100 of discount. Exactly the VL-11 loss this module was written to close,
// narrowed from "as many copies as the shopper can start" to "as many as they
// can start SIMULTANEOUSLY", which is the easier one to do on purpose.
//
// The old algorithm is still here, and still correct as far as it goes: it is
// the fallback for a database where the functions have not been applied yet, so
// an un-migrated environment behaves exactly as it did before rather than
// failing checkout. It is not the primary path anywhere the SQL has run.
//
// A refusal is still the safe direction either way: a refused claim shows the
// shopper a refreshed total, an accepted one spends money that is not there.
// ---------------------------------------------------------------------------

/**
 * Where a balance lives. The two ledgers differ in table, column and expiry
 * rule; the claim algorithm does not, and is written once below.
 */
interface LedgerSpec {
  table: "store_credit_ledger" | "points_ledger";
  /** The atomic claim for this ledger. See src/lib/sql/tender-hold-claim.sql. */
  claimRpc: "claim_store_credit_hold" | "claim_points_hold";
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
  claimRpc: "claim_store_credit_hold",
  amountColumn: "amount_cents",
  reason: STORE_CREDIT_REDEMPTION_REASON,
  label: "store credit",
  windowStartIso: () => startOfCurrentMonthIso(),
};

const POINTS: LedgerSpec = {
  table: "points_ledger",
  claimRpc: "claim_points_hold",
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

// Ceiling on ONE customer's ledger read. Far above any real customer's
// lifetime row count, so it is never the binding limit in practice; it exists
// so a runaway ledger cannot be silently half-read into a spend authorisation.
const MAX_LEDGER_SCAN_ROWS = 100_000;

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

  // THE ATOMIC PATH. One locked function does the whole claim; see the header.
  const atomic = await claimAtomically(spec, userId, orderId, wanted);
  if (atomic !== "unavailable") return atomic;

  return claimByWriteThenValidate(spec, userId, orderId, wanted);
}

/**
 * A missing function, and nothing else.
 *
 * 42883 / 42P01 are Postgres saying the object does not exist. PGRST202 is
 * PostgREST's "could not find the function", which it also answers for a moment
 * after any migration or reload while its schema cache is stale — honoured for
 * THIS call only, exactly as bxgy-promotions.ts honours it, because latching on
 * a blip would switch the lock off for the rest of the process.
 *
 * CODES ONLY, DELIBERATELY. The sibling in bxgy-promotions.ts also matches the
 * function NAME in the message as a last resort against unknown codes. That is
 * affordable there, where the wrong answer over-runs a promotion cap; here the
 * wrong answer spends a customer's money on the algorithm that cannot see a
 * race. Every error mentioning this function — a timeout inside it, a
 * permission failure naming it — would have been read as "not deployed".
 */
function looksLikeMissingClaimFunction(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  return error.code === "42883" || error.code === "42P01" || error.code === "PGRST202";
}

let claimFunctionsReportedMissing = false;

/**
 * Claim through the database function.
 *
 * Answers "unavailable" only when the function is not there — an environment
 * where tender-hold-claim.sql has not been applied, which then falls back to
 * the pre-lock algorithm below. Any OTHER failure THROWS, exactly as the
 * fallback's own insert and read failures always have: a claim that cannot be
 * proved must not be granted.
 */
async function claimAtomically(
  spec: LedgerSpec,
  userId: string,
  orderId: string,
  wanted: number,
): Promise<boolean | "unavailable"> {
  const call = () => supabaseAdmin.rpc(spec.claimRpc, {
    p_user_id: userId,
    p_order_id: orderId,
    p_amount: wanted,
    p_reason: spec.reason,
    p_window_start: spec.windowStartIso(),
  });

  // Retried once on the rejection that provably never ran — production refuses
  // roughly 0.1% of this app's Supabase calls with a 401 "JWT issued at future".
  // A 401 is refused at the edge, so re-issuing it cannot debit twice; the
  // inventory RPCs retry the same class for the same reason.
  let { data, error } = await call();
  if (error && isTransientAuthRejection(error)) {
    await new Promise((resolve) => setTimeout(resolve, CLAIM_RETRY_DELAY_MS));
    ({ data, error } = await call());
  }

  if (!error) return data !== false;

  if (looksLikeMissingClaimFunction(error as { code?: string; message?: string })) {
    if (!claimFunctionsReportedMissing) {
      claimFunctionsReportedMissing = true;
      console.warn(
        `[tender] ${spec.claimRpc} is not available; holding ${spec.label} with the pre-lock algorithm, `
        + "which can double-spend a balance under concurrent checkouts. Apply src/lib/sql/tender-hold-claim.sql.",
      );
    }
    return "unavailable";
  }
  throw error;
}

/** Pause before the single retry of a claim refused at the edge. */
const CLAIM_RETRY_DELAY_MS = 250;

/**
 * The pre-lock algorithm, kept for a database without the claim functions.
 *
 * Correct except under concurrency, which is why it is not the primary path.
 * See the header for the race it cannot see.
 */
async function claimByWriteThenValidate(
  spec: LedgerSpec,
  userId: string,
  orderId: string,
  wanted: number,
): Promise<boolean> {
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
  // PAGED, and ordered in the QUERY so the pages join up.
  //
  // Points have no window at all (POINTS.windowStartIso returns null), so this
  // is the customer's whole lifetime ledger — and an unpaged read of it stops
  // at the server's row cap without saying so. That is not a slow read, it is a
  // wrong one: the rows come back in no particular order, so a truncated read
  // may not even contain OUR row, in which case the loop below never breaks and
  // sums an arbitrary subset of the ledger. The result is a solvency proof for
  // a balance nobody checked. A read that could not be completed is treated the
  // same way a failed one already is — the hold goes back.
  let ledger: LedgerRow[];
  let ledgerTruncated: boolean;
  try {
    const read = await readAllRowsBounded<LedgerRow>(
      (from, to) => {
        let query = supabaseAdmin
          .from(spec.table)
          .select(`id, created_at, ${spec.amountColumn}`)
          .eq("user_id", userId);
        if (windowStart) query = query.gte("created_at", windowStart);
        return query
          .order("created_at", { ascending: true })
          .order("id", { ascending: true })
          .range(from, to) as unknown as PromiseLike<{ data: LedgerRow[] | null; error: unknown }>;
      },
      { maxRows: MAX_LEDGER_SCAN_ROWS, label: `${spec.table} solvency read` },
    );
    ledger = read.rows;
    ledgerTruncated = read.truncated;
  } catch (readError) {
    // Cannot prove the claim is solvent. Take it back rather than assume.
    await releaseHold(spec, orderId);
    throw readError;
  }

  if (ledgerTruncated) {
    await releaseHold(spec, orderId);
    throw new Error(
      `${spec.table} exceeded ${MAX_LEDGER_SCAN_ROWS} rows for one customer; the ${spec.label} hold was released rather than granted on an incomplete balance.`,
    );
  }

  const rows = ledger.slice().sort(inLedgerOrder);
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
 *
 * THE MONEY DECIDES, NOT ONLY THE WORD. Refusing on the status string alone
 * makes this correct exactly as long as nothing ever moves a settled order to
 * another status — and an admin can set an order's payment status by hand
 * (admin-order-actions.tsx). `paid_at` is stamped once, when money actually
 * arrived, so an order that has ever settled is refused whatever its status
 * reads today. Deleting a redemption on a paid order would return credit the
 * customer really spent.
 */
export async function releaseOrderTender(orderId: string): Promise<number> {
  const { data: order, error } = await supabaseAdmin
    .from("orders")
    .select("payment_status, paid_at, amount_paid")
    .eq("order_id", orderId)
    .maybeSingle();
  if (error) throw error;

  const status = String(order?.payment_status ?? "").toLowerCase();
  if (status === "paid" || status === "refunded" || status === "partially_refunded") return 0;
  if (order?.paid_at && Number(order.amount_paid ?? 0) > 0) return 0;

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
        // EVERY unpaid status, not just the card lane's. A manual/off-platform
        // order moves to `awaiting_verification` while it waits for an admin
        // (checkout/submit-payment), and one that is never approved would
        // otherwise hold the shopper's own credit for good — the balance is
        // spendable nowhere while it sits against an order that never settles.
        .in("payment_status", UNPAID_STATUSES)
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
