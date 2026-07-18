import { DEFAULT_DISCOUNT_PERCENT, DEFAULT_COMMISSION_PERCENT } from "@/lib/referral-config";
import { supabaseAdmin } from "@/lib/supabase-server";

export interface ReferralRecord {
  id: string;
  referral_code: string;
  ambassador_id: string;
  ambassador_name: string;
  commission_percent: number;
  status: string;
}

export interface ReferralValidationResult {
  referralCode: string;
  ambassadorId: string;
  ambassadorName: string;
  commissionPercent: number;
  discountPercent: number;
}

export function normalizeReferralCode(code: string) {
  return code.trim().toUpperCase().replace(/[^A-Z0-9-]/g, "");
}

export function calculateDiscountAmount(subtotal: number, discountPercent: number = DEFAULT_DISCOUNT_PERCENT) {
  return Math.round(subtotal * (discountPercent / 100) * 100) / 100;
}

export function calculateCommissionAmount(total: number, commissionPercent: number = DEFAULT_COMMISSION_PERCENT) {
  return Math.round(total * (commissionPercent / 100) * 100) / 100;
}

export async function validateReferralCode(code?: string): Promise<ReferralValidationResult | null> {
  const normalizedCode = normalizeReferralCode(code ?? "");

  if (!normalizedCode) {
    return null;
  }

  const { data, error } = await supabaseAdmin
    .from("ambassadors")
    .select("id, name, referral_code, commission_percent, status")
    .eq("referral_code", normalizedCode)
    .maybeSingle();

  if (error) {
    console.error("Referral lookup failed:", error);
    throw new Error("Unable to verify referral code");
  }

  if (!data) {
    throw new Error("Invalid referral code");
  }

  if (data.status !== "approved") {
    throw new Error("That referral code is not active");
  }

  return {
    referralCode: data.referral_code.toUpperCase(),
    ambassadorId: data.id,
    ambassadorName: data.name,
    commissionPercent: Number(data.commission_percent ?? DEFAULT_COMMISSION_PERCENT),
    discountPercent: DEFAULT_DISCOUNT_PERCENT,
  };
}

export async function createReferralOrderRecord(input: {
  orderId: string;
  ambassadorId: string;
  referralCode: string;
  customerEmail: string;
  commissionPercent: number;
  subtotal: number;
  shipping: number;
  discountAmount: number;
  total: number;
  paymentId?: string;
  status?: string;
}) {
  const { data, error } = await supabaseAdmin
    .from("referral_orders")
    .insert({
      order_id: input.orderId,
      ambassador_id: input.ambassadorId,
      referral_code: input.referralCode,
      commission_percent: input.commissionPercent,
      commission_amount: calculateCommissionAmount(input.total, input.commissionPercent),
      amount_paid: input.total,
      payment_id: input.paymentId ?? null,
      payment_status: input.status ?? "pending",
      created_at: new Date().toISOString(),
    })
    .select("id")
    .single();

  if (error) {
    console.error("Unable to record referral order:", error);
    throw new Error("Unable to record referral order");
  }

  return data;
}
