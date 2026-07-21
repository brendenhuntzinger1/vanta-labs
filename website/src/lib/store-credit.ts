import { supabaseAdmin } from "@/lib/supabase-server";

// Store credit is a dedicated, account-tied balance separate from loyalty
// points. It is granted monthly to active paying members and is
// use-it-or-lose-it: the spendable balance is only the CURRENT calendar
// month's ledger rows (grants positive, redemptions negative), so last
// month's unspent credit simply stops counting. This keeps the liability
// bounded and protects margin.

function currentPeriodMonth(now = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

function startOfCurrentMonthIso(now = new Date()): string {
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

// Reverses a redemption if an order is refunded, returning the credit to the
// buyer (only if still within the same month it was spent).
export async function refundStoreCreditForOrder(orderId: string): Promise<void> {
  const { data, error } = await supabaseAdmin
    .from("store_credit_ledger")
    .select("user_id, amount_cents, created_at")
    .eq("order_id", orderId)
    .eq("reason", "membership_redemption");

  if (error) {
    if (String(error.code) === "42P01") return;
    throw error;
  }

  const monthStart = startOfCurrentMonthIso();
  for (const row of data ?? []) {
    const returned = Math.abs(Number(row.amount_cents ?? 0));
    if (returned <= 0) continue;
    // Only re-credit if the credit was spent in the CURRENT month — credit
    // spent in a prior month has already expired, so refunding it would hand
    // back money that was no longer valid.
    if (String(row.created_at ?? "") < monthStart) continue;
    await supabaseAdmin.from("store_credit_ledger").insert({
      user_id: String(row.user_id),
      amount_cents: returned,
      reason: "membership_redemption_refund",
      order_id: orderId,
      created_at: new Date().toISOString(),
    });
  }
}
