import { supabaseAdmin } from "@/lib/supabase-server";

// Ambassador store-credit wallet: a dedicated, NON-EXPIRING balance separate
// from the membership store_credit_ledger. Balance = sum of all ledger rows
// (grants +, redemptions -). It never expires because it represents earned
// money (a payout taken as credit, or a monthly bonus).

const MISSING_TABLE = "42P01";
const UNIQUE_VIOLATION = "23505";

export type AmbassadorWalletReason =
  | "payout"
  | "bonus"
  | "redemption"
  | "redemption_refund"
  | "admin_adjustment";

export interface AmbassadorWalletEntry {
  id: string;
  amountCents: number;
  reason: string;
  orderId: string | null;
  note: string | null;
  createdBy: string | null;
  createdAt: string;
}

// Spendable balance = sum of every row for the user (non-expiring), clamped at
// 0. A missing table (migration not yet run) reads as 0 and never throws.
export async function getAmbassadorWalletBalanceCents(userId: string): Promise<number> {
  if (!userId) return 0;
  const { data, error } = await supabaseAdmin
    .from("ambassador_wallet_ledger")
    .select("amount_cents")
    .eq("user_id", userId);

  if (error) {
    if (String(error.code) === MISSING_TABLE) return 0;
    throw error;
  }

  const balance = (data ?? []).reduce((sum, row) => sum + Number(row.amount_cents ?? 0), 0);
  return Math.max(0, balance);
}

export async function getAmbassadorWalletHistory(userId: string, limit = 100): Promise<AmbassadorWalletEntry[]> {
  if (!userId) return [];
  const { data, error } = await supabaseAdmin
    .from("ambassador_wallet_ledger")
    .select("id, amount_cents, reason, order_id, note, created_by, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    if (String(error.code) === MISSING_TABLE) return [];
    throw error;
  }

  return (data ?? []).map((row) => ({
    id: String(row.id),
    amountCents: Number(row.amount_cents ?? 0),
    reason: String(row.reason ?? ""),
    orderId: row.order_id ? String(row.order_id) : null,
    note: row.note ? String(row.note) : null,
    createdBy: row.created_by ? String(row.created_by) : null,
    createdAt: String(row.created_at),
  }));
}

// Add credit to a wallet (payout taken as store credit, monthly bonus). Amount
// must be positive. Returns the cents actually granted (0 on no-op/missing table).
export async function grantAmbassadorCredit(input: {
  userId: string;
  amountCents: number;
  reason: Extract<AmbassadorWalletReason, "payout" | "bonus">;
  note?: string | null;
  createdBy?: string | null;
  orderId?: string | null;
}): Promise<number> {
  const amount = Math.round(input.amountCents);
  if (!input.userId || amount <= 0) return 0;

  const { error } = await supabaseAdmin.from("ambassador_wallet_ledger").insert({
    user_id: input.userId,
    amount_cents: amount,
    reason: input.reason,
    order_id: input.orderId ?? null,
    note: input.note ?? null,
    created_by: input.createdBy ?? null,
    created_at: new Date().toISOString(),
  });

  if (error) {
    if (String(error.code) === MISSING_TABLE) return 0;
    throw error;
  }
  return amount;
}

// Admin manual adjustment (signed). A negative adjustment is clamped so the
// wallet can never go below zero. Returns the applied cents (may be smaller in
// magnitude than requested if clamped).
export async function adminAdjustAmbassadorCredit(input: {
  userId: string;
  amountCents: number;
  note?: string | null;
  createdBy?: string | null;
}): Promise<number> {
  let amount = Math.round(input.amountCents);
  if (!input.userId || amount === 0) return 0;

  if (amount < 0) {
    const balance = await getAmbassadorWalletBalanceCents(input.userId);
    amount = Math.max(amount, -balance); // never claw back more than the balance
    if (amount === 0) return 0;
  }

  const { error } = await supabaseAdmin.from("ambassador_wallet_ledger").insert({
    user_id: input.userId,
    amount_cents: amount,
    reason: "admin_adjustment",
    note: input.note ?? null,
    created_by: input.createdBy ?? null,
    created_at: new Date().toISOString(),
  });

  if (error) {
    if (String(error.code) === MISSING_TABLE) return 0;
    throw error;
  }
  return amount;
}

// Redeem wallet credit against an order. Capped to the LIVE balance so it can
// never go negative, and idempotent per order via the partial unique index so a
// webhook retry can't double-redeem. Returns cents actually redeemed.
export async function redeemAmbassadorCredit(userId: string, amountCents: number, orderId: string): Promise<number> {
  if (!userId || !orderId) return 0;
  const requested = Math.abs(Math.round(amountCents));
  if (requested <= 0) return 0;

  const liveBalance = await getAmbassadorWalletBalanceCents(userId);
  const toRedeem = Math.min(requested, liveBalance);
  if (toRedeem <= 0) return 0;

  const { error } = await supabaseAdmin.from("ambassador_wallet_ledger").insert({
    user_id: userId,
    amount_cents: -toRedeem,
    reason: "redemption",
    order_id: orderId,
    created_at: new Date().toISOString(),
  });

  if (error) {
    // Already redeemed for this order (unique index) or table missing — either
    // way, do not throw and do not double-count.
    if (String(error.code) === UNIQUE_VIOLATION || String(error.code) === MISSING_TABLE) return 0;
    throw error;
  }
  return toRedeem;
}

// Reverse a wallet redemption when its order is refunded, returning the exact
// redeemed amount to the wallet (idempotent: skips if already refunded).
export async function refundAmbassadorRedemption(orderId: string): Promise<void> {
  if (!orderId) return;

  const { data, error } = await supabaseAdmin
    .from("ambassador_wallet_ledger")
    .select("user_id, amount_cents, reason")
    .eq("order_id", orderId);

  if (error) {
    if (String(error.code) === MISSING_TABLE) return;
    throw error;
  }

  const rows = data ?? [];
  const redemption = rows.find((row) => row.reason === "redemption");
  const alreadyRefunded = rows.some((row) => row.reason === "redemption_refund");
  if (!redemption || alreadyRefunded) return;

  const returned = Math.abs(Number(redemption.amount_cents ?? 0));
  if (returned <= 0) return;

  const { error: insertError } = await supabaseAdmin.from("ambassador_wallet_ledger").insert({
    user_id: String(redemption.user_id),
    amount_cents: returned,
    reason: "redemption_refund",
    order_id: orderId,
    created_at: new Date().toISOString(),
  });

  if (insertError && String(insertError.code) !== MISSING_TABLE) {
    throw insertError;
  }
}
