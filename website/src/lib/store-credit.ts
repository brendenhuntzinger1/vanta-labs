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

// Records a redemption (negative) against the buyer's account for an order.
export async function redeemStoreCredit(userId: string, amountCents: number, orderId: string): Promise<void> {
  if (amountCents <= 0) return;

  const { error } = await supabaseAdmin.from("store_credit_ledger").insert({
    user_id: userId,
    amount_cents: -Math.abs(Math.round(amountCents)),
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
    .select("user_id, amount_cents")
    .eq("order_id", orderId)
    .eq("reason", "membership_redemption");

  if (error) {
    if (String(error.code) === "42P01") return;
    throw error;
  }

  for (const row of data ?? []) {
    const returned = Math.abs(Number(row.amount_cents ?? 0));
    if (returned <= 0) continue;
    await supabaseAdmin.from("store_credit_ledger").insert({
      user_id: String(row.user_id),
      amount_cents: returned,
      reason: "membership_redemption_refund",
      order_id: orderId,
      created_at: new Date().toISOString(),
    });
  }
}
