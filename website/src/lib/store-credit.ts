import { supabaseAdmin } from "@/lib/supabase-server";
import { businessMonthKey, startOfBusinessMonthIso } from "@/lib/business-day";

// BOTH HALVES OF THE PERIOD MOVE TOGETHER, and they have to. `period_month` is
// the unique-index key that stops a member being granted twice, and
// `startOfCurrentMonthIso` is the window that decides what they can still
// spend; if one said August while the other said September, a member would
// either be granted twice or hold credit the balance could not see. On UTC the
// month turned at 8pm ET on the last evening, which is exactly how the one
// grant in production dated 2026-09-01T00:01Z came to be issued at 8:01pm ET on
// August 31st.
//
// Store credit is a dedicated, account-tied balance separate from loyalty
// points. It is granted monthly to active paying members and is
// use-it-or-lose-it: the spendable balance is only the CURRENT calendar
// month's ledger rows (grants positive, redemptions negative), so last
// month's unspent credit simply stops counting. This keeps the liability
// bounded and protects margin.

/**
 * The grant period key, "YYYY-MM" in the STORE'S zone. Exported so the monthly sweep can ask
 * the ledger which members it has ALREADY granted this period and skip them,
 * rather than re-attempting an insert that the unique index will refuse. That
 * is what lets the sweep take a per-tick budget without the same handful of
 * members consuming it every half hour for the rest of the month.
 */
export function currentPeriodMonth(now = new Date()): string {
  return businessMonthKey(now);
}

/**
 * Start of the current month. The monthly membership grant does not roll
 * over, so this window IS the definition of spendable store credit. Exported so
 * admin reporting uses the same boundary the customer's balance uses — summing
 * the whole ledger made admin show $35.00 against a real balance of $5.00.
 */
export function startOfCurrentMonthIso(now = new Date()): string {
  return startOfBusinessMonthIso(now);
}

// Spendable balance = sum of THIS month's ledger rows for the user (grants +,
// redemptions -). Prior months are expired and excluded.
export async function getStoreCreditBalanceCents(userId: string): Promise<number> {
  const { data, error } = await supabaseAdmin
    .from("store_credit_ledger")
    .select("amount_cents")
    .eq("user_id", userId)
    .gte("created_at", startOfCurrentMonthIso());

  if (error) {
    // A missing table (migration not run yet) must never break checkout.
    if (String(error.code) === "42P01") return 0;
    throw error;
  }

  const balance = (data ?? []).reduce((sum, row) => sum + Number(row.amount_cents ?? 0), 0);
  return Math.max(0, balance);
}

// Grants this month's store credit once per member per month (idempotent via a
// unique index on (user_id, period_month) for the grant reason).
export async function grantMonthlyStoreCredit(userId: string, amountCents: number): Promise<boolean> {
  if (amountCents <= 0) return false;

  const { error } = await supabaseAdmin.from("store_credit_ledger").insert({
    user_id: userId,
    amount_cents: Math.round(amountCents),
    reason: "membership_monthly_grant",
    period_month: currentPeriodMonth(),
    created_at: new Date().toISOString(),
  });

  if (error) {
    // 23505 = unique violation => already granted this month (fine). 42P01 =
    // table missing (migration pending). Neither should throw.
    if (String(error.code) === "23505" || String(error.code) === "42P01") return false;
    throw error;
  }

  return true;
}

// On a tier change, brings THIS month's net store-credit grant in line with
// the new tier's monthly amount: tops up on an upgrade, claws back the unspent
// portion on a downgrade (never below what's already been redeemed this month).
export async function reconcileMonthlyStoreCredit(userId: string, newTierMonthlyCents: number): Promise<void> {
  const monthStart = startOfCurrentMonthIso();
  const { data, error } = await supabaseAdmin
    .from("store_credit_ledger")
    .select("amount_cents, reason")
    .eq("user_id", userId)
    .gte("created_at", monthStart);

  if (error) {
    if (String(error.code) === "42P01") return;
    throw error;
  }

  const rows = data ?? [];
  const grantedThisMonth = rows
    .filter((r) => Number(r.amount_cents ?? 0) > 0 && (r.reason === "membership_monthly_grant" || r.reason === "membership_grant_adjustment"))
    .reduce((sum, r) => sum + Number(r.amount_cents ?? 0), 0);
  const balance = Math.max(0, rows.reduce((sum, r) => sum + Number(r.amount_cents ?? 0), 0));

  let adjustment = Math.round(newTierMonthlyCents) - grantedThisMonth;
  if (adjustment < 0) {
    adjustment = Math.max(adjustment, -balance); // never claw back already-spent credit
  }
  if (adjustment === 0) return;

  await supabaseAdmin.from("store_credit_ledger").insert({
    user_id: userId,
    amount_cents: adjustment,
    reason: "membership_grant_adjustment",
    created_at: new Date().toISOString(),
  });
}

/**
 * The ledger reason a spend against an order is written under.
 *
 * Exported because the checkout-time HOLD (tender-reservation.ts) writes the
 * same row this function writes: the hold IS the redemption, taken earlier. A
 * second copy of the string in the reservation module would be a second source
 * of truth for which rows count as spent.
 */
export const STORE_CREDIT_REDEMPTION_REASON = "membership_redemption";

/** Is this order's spend already recorded (held at checkout, or a webhook retry)? */
async function redemptionExistsForOrder(orderId: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from("store_credit_ledger")
    .select("id")
    .eq("order_id", orderId)
    .eq("reason", STORE_CREDIT_REDEMPTION_REASON)
    .limit(1);

  if (error) {
    if (String(error.code) === "42P01") return false;
    // "I could not tell" is never "no": guessing here debits the customer twice.
    throw error;
  }
  return Boolean(data && data.length > 0);
}

// Records a redemption (negative) against the buyer's account for an order.
// Capped to the LIVE remaining balance at redemption time, so two concurrent
// pending orders that each froze the same balance can never over-spend it.
//
// IDEMPOTENT PER ORDER. Checkout now HOLDS the credit when the order is created
// (tender-reservation.ts), so by settlement the row this function would write
// usually already exists — and a webhook retry would otherwise debit a second
// time. An order whose hold was released (abandoned, then paid late) has no row
// and is debited here exactly as it always was.
export async function redeemStoreCredit(userId: string, amountCents: number, orderId: string): Promise<void> {
  if (amountCents <= 0) return;

  if (await redemptionExistsForOrder(orderId)) return;

  const liveBalance = await getStoreCreditBalanceCents(userId);
  const toRedeem = Math.min(Math.abs(Math.round(amountCents)), liveBalance);
  if (toRedeem <= 0) return;

  const { error } = await supabaseAdmin.from("store_credit_ledger").insert({
    user_id: userId,
    amount_cents: -toRedeem,
    reason: STORE_CREDIT_REDEMPTION_REASON,
    order_id: orderId,
    created_at: new Date().toISOString(),
  });

  if (error && String(error.code) !== "42P01") {
    throw error;
  }
}

/**
 * Is this recorded redemption one a refund can actually return?
 *
 * Store credit is use-it-or-lose-it, so credit spent in a PRIOR month has
 * already expired and returning it would hand back money that is no longer
 * valid. A zero-value row has nothing to return either.
 *
 * EXPORTED BECAUSE THE REFUND SWEEP HAS TO ASK THE SAME QUESTION. An order
 * whose only redemption is expired is one this function will correctly decline
 * to refund — forever. A caller that selects work by "store_credit_redeemed_cents
 * > 0 and no refund row exists" would therefore replan that order on every tick
 * and count a repair that wrote nothing. One rule, one place, both readers.
 */
export function isRefundableRedemption(
  row: { amount_cents?: unknown; created_at?: unknown },
  monthStartIso: string,
): boolean {
  return (
    Math.abs(Number(row.amount_cents ?? 0)) > 0
    && String(row.created_at ?? "") >= monthStartIso
  );
}

/**
 * Reverses a redemption if an order is refunded, returning the credit to the
 * buyer (only if still within the same month it was spent).
 *
 * RETURNS WHETHER IT ACTUALLY RETURNED ANYTHING. "Refund considered and
 * declined" (expired credit, no redemption on file, already refunded) is not
 * the same event as "credit returned", and a caller that treats the two alike
 * reports repairs that never happened.
 */
export async function refundStoreCreditForOrder(orderId: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from("store_credit_ledger")
    .select("user_id, amount_cents, created_at")
    .eq("order_id", orderId)
    .eq("reason", STORE_CREDIT_REDEMPTION_REASON);

  if (error) {
    if (String(error.code) === "42P01") return false;
    throw error;
  }

  // Idempotent: a repeated refund/chargeback event for the same order must not
  // re-credit the customer twice. If we've already recorded a refund for this
  // order, stop.
  //
  // THE READ'S ERROR IS THE WHOLE GUARD. `{ data: null, error }` — a statement
  // timeout, a pooler blip — used to be indistinguishable from "no refund row
  // exists", so one transient failure re-credited an order that had already
  // been refunded. No concurrency required, and no unique index to catch it.
  // Refusing to guess makes the caller (the webhook) log it and the sweep count
  // `failed` and alert, which is recoverable; a double credit is not.
  const { data: alreadyRefunded, error: alreadyRefundedError } = await supabaseAdmin
    .from("store_credit_ledger")
    .select("id")
    .eq("order_id", orderId)
    .eq("reason", "membership_redemption_refund")
    .limit(1);

  if (alreadyRefundedError) throw alreadyRefundedError;

  if (alreadyRefunded && alreadyRefunded.length > 0) {
    return false;
  }

  const monthStart = startOfCurrentMonthIso();
  // Only re-credit redemptions that are still refundable — see
  // isRefundableRedemption.
  //
  // ONE REFUND ROW PER (ORDER, ACCOUNT), NOT ONE PER REDEMPTION ROW. The
  // amount returned is identical — the redemptions are summed — but the shape
  // is now something a unique index can hold: an order with two redemption
  // rows used to produce two refund rows, so "one refund row per order" was not
  // a rule the database could enforce, and the read-then-insert guard above was
  // the ONLY thing standing between a concurrent webhook and sweep and a
  // double credit. See idx_store_credit_ledger_order_refund_once
  // (sql/refund-exactly-once-indexes.sql). Grouped by user_id rather than
  // flattened outright: the index is per account, and an order's redemptions
  // all belong to one buyer, so this is one row in every real case.
  const refundableTotals = new Map<string, number>();
  for (const row of data ?? []) {
    if (!isRefundableRedemption(row, monthStart)) continue;
    const userId = String(row.user_id);
    refundableTotals.set(userId, (refundableTotals.get(userId) ?? 0) + Math.abs(Number(row.amount_cents ?? 0)));
  }

  const refundRows = [...refundableTotals.entries()]
    .filter(([, amountCents]) => amountCents > 0)
    .map(([userId, amountCents]) => ({
      user_id: userId,
      amount_cents: amountCents,
      reason: "membership_redemption_refund",
      order_id: orderId,
      created_at: new Date().toISOString(),
    }));

  if (refundRows.length === 0) return false;

  // ONE INSERT, AND ITS ERROR IS THE RESULT.
  //
  // This used to discard the insert's return value entirely and set
  // returnedAny = true regardless, so a rejected insert (a user_id that no
  // longer resolves against auth.users, a constraint violation, a transient
  // failure) reported the customer's credit as returned when nothing was
  // written: the sweep counted `repaired`, `failed` stayed 0 so no alert fired,
  // and — because the row it looks for still did not exist — it replanned the
  // identical repair on every tick, forever.
  //
  // Writing all the rows in a SINGLE statement also makes a partial return
  // impossible: previously a failure on the second of two redemptions left the
  // first refunded, and the already-refunded guard above then declined to ever
  // finish the job.
  const { error: insertError } = await supabaseAdmin.from("store_credit_ledger").insert(refundRows);
  // THE ALREADY-REFUNDED READ ABOVE IS NOT EXACTLY-ONCE ON ITS OWN. Two
  // callers — the webhook's refund branch and the half-hourly refund sweep —
  // can both read "no refund row yet" and both insert, returning the
  // customer's credit twice for one refund. `idx_store_credit_ledger_order_refund_once`
  // (sql/refund-exactly-once-indexes.sql) makes the database refuse the second
  // one; 23505 here therefore means the credit HAS been returned, by somebody
  // else, so this call returned nothing and must say so rather than throwing.
  // Reporting it as an error would have the sweep counting a failure and
  // alerting on a refund that is correctly applied.
  if (insertError) {
    if (String((insertError as { code?: unknown }).code ?? "") === "23505") return false;
    throw insertError;
  }

  return true;
}
