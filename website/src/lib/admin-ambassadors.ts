import { supabaseAdmin } from "@/lib/supabase-server";

// Count of an ambassador's referral orders that were refunded/voided or pulled
// into manual review - i.e. orders that no longer earn (or clawed back) a
// commission. Used on the admin ambassador profile.
export async function getAmbassadorRefundedOrderCount(partnerId: string): Promise<number> {
  const { data, error } = await supabaseAdmin
    .from("referral_orders")
    .select("id")
    .eq("ambassador_id", partnerId)
    .in("payment_status", ["reversed", "voided", "manual_review"]);

  if (error) {
    throw error;
  }

  return (data ?? []).length;
}

export interface FraudReviewRow {
  id: string;
  orderId: string;
  ambassadorId: string;
  ambassadorName: string;
  referralCode: string;
  commissionAmount: number;
  paymentStatus: string;
  fraudFlag: boolean;
  fraudReason: string | null;
  ineligibleReason: string | null;
  createdAt: string;
}

export async function getFraudReviewRows(): Promise<FraudReviewRow[]> {
  const { data: referralOrders, error } = await supabaseAdmin
    .from("referral_orders")
    .select("id, order_id, ambassador_id, referral_code, commission_amount, payment_status, fraud_flag, fraud_reason, ineligible_reason, created_at")
    .order("created_at", { ascending: false })
    .limit(200);

  if (error) {
    throw error;
  }

  const flagged = (referralOrders ?? []).filter((row) => row.fraud_flag || row.ineligible_reason || row.payment_status === "manual_review");

  if (flagged.length === 0) {
    return [];
  }

  const ambassadorIds = Array.from(new Set(flagged.map((row) => row.ambassador_id).filter(Boolean)));
  const { data: ambassadors, error: ambassadorError } = await supabaseAdmin
    .from("partners")
    .select("id, name")
    .in("id", ambassadorIds);

  if (ambassadorError) {
    throw ambassadorError;
  }

  const nameById = new Map((ambassadors ?? []).map((row) => [row.id, row.name]));

  return flagged.map((row) => ({
    id: String(row.id),
    orderId: String(row.order_id),
    ambassadorId: String(row.ambassador_id ?? ""),
    ambassadorName: nameById.get(row.ambassador_id) ?? "Unknown ambassador",
    referralCode: String(row.referral_code ?? ""),
    commissionAmount: Number(row.commission_amount ?? 0),
    paymentStatus: String(row.payment_status ?? "pending"),
    fraudFlag: Boolean(row.fraud_flag),
    fraudReason: row.fraud_reason ? String(row.fraud_reason) : null,
    ineligibleReason: row.ineligible_reason ? String(row.ineligible_reason) : null,
    createdAt: String(row.created_at),
  }));
}

export async function clearFraudFlag(referralOrderId: string) {
  const { data: row, error: lookupError } = await supabaseAdmin
    .from("referral_orders")
    .select("order_id")
    .eq("id", referralOrderId)
    .maybeSingle();

  if (lookupError) {
    throw lookupError;
  }

  if (!row) {
    throw new Error("Referral order not found");
  }

  const { error } = await supabaseAdmin
    .from("referral_orders")
    .update({ fraud_flag: false, fraud_reason: null, updated_at: new Date().toISOString() })
    .eq("id", referralOrderId);

  if (error) {
    throw error;
  }

  const { error: mirrorError } = await supabaseAdmin
    .from("commissions")
    .update({ fraud_flag: false, fraud_reason: null, updated_at: new Date().toISOString() })
    .eq("order_id", row.order_id);

  if (mirrorError) {
    throw mirrorError;
  }
}

export interface PayoutHistoryRow {
  id: string;
  ambassadorId: string;
  ambassadorName: string;
  amount: number;
  note: string | null;
  createdAt: string;
}

export async function getPayoutHistory(limit = 50): Promise<PayoutHistoryRow[]> {
  const { data: payouts, error } = await supabaseAdmin
    .from("partner_payouts")
    .select("id, ambassador_id, amount, note, created_at")
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    throw error;
  }

  if (!payouts || payouts.length === 0) {
    return [];
  }

  const ambassadorIds = Array.from(new Set(payouts.map((row) => row.ambassador_id).filter(Boolean)));
  const { data: ambassadors, error: ambassadorError } = await supabaseAdmin
    .from("partners")
    .select("id, name")
    .in("id", ambassadorIds);

  if (ambassadorError) {
    throw ambassadorError;
  }

  const nameById = new Map((ambassadors ?? []).map((row) => [row.id, row.name]));

  return payouts.map((row) => ({
    id: String(row.id),
    ambassadorId: String(row.ambassador_id),
    ambassadorName: nameById.get(row.ambassador_id) ?? "Unknown ambassador",
    amount: Number(row.amount ?? 0),
    note: row.note ? String(row.note) : null,
    createdAt: String(row.created_at),
  }));
}
