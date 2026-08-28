import { supabaseAdmin } from "@/lib/supabase-server";

// Store credit is a dedicated, account-tied balance separate from loyalty
// points. It is granted monthly to active paying members and is
// use-it-or-lose-it: the spendable balance is only the CURRENT calendar
// month's ledger rows (grants positive, redemptions negative), so last
// month's unspent credit simply stops counting. This keeps the liability
// bounded and protects margin.

/**
 * The grant period key, "YYYY-MM" in UTC. Exported so the monthly sweep can ask
 * the ledger which members it has ALREADY granted this period and skip them,
 * rather than re-attempting an insert that the unique index will refuse. That
 * is what lets the sweep take a per-tick budget without the same handful of
 * members consuming it every half hour for the rest of the month.
 */
export function currentPeriodMonth(now = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * Start of the current month. The monthly membership grant does not roll
 * over, so this window IS the definition of spendable store credit. Exported so
 * admin reporting uses the same boundary the customer's balance uses — summing
 * the whole ledger made admin show $35.00 against a real balance of $5.00.
 */
export function startOfCurrentMonthIso(now = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
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

// Records a redemption (negative) against the buyer's account for an order.
// Capped to the LIVE remaining balance at redemption time, so two concurrent
// pending orders that each froze the same balance can never over-spend it.
export async function redeemStoreCredit(userId: string, amountCents: number, orderId: string): Promise<void> {
  if (amountCents <= 0) return;

  const liveBalance = await getStoreCreditBalanceCents(userId);
  const toRedeem = Math.min(Math.abs(Math.round(amountCents)), liveBalance);
  if (toRedeem <= 0) return;

  const { error } = await supabaseAdmin.from("store_credit_ledger").insert({
    user_id: userId,
    amount_cents: -toRedeem,
    reason: "membership_redemption",
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
    .eq("reason", "membership_redemption");

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
  const refundRows = (data ?? [])
    .filter((row) => isRefundableRedemption(row, monthStart))
    .map((row) => ({
      user_id: String(row.user_id),
      amount_cents: Math.abs(Number(row.amount_cents ?? 0)),
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
  if (insertError) throw insertError;

  return true;
}
