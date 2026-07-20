import "server-only";

import { supabaseAdmin } from "@/lib/supabase-server";

export interface CouponValidationResult {
  code: string;
  discountType: "percent" | "fixed";
  discountValue: number;
  discountAmount: number;
}

export function normalizeCouponCode(code: string) {
  return code.trim().toUpperCase().replace(/[^A-Z0-9-]/g, "");
}

function roundMoney(value: number) {
  return Math.round(value * 100) / 100;
}

export function calculateCouponDiscount(subtotal: number, discountType: string, discountValue: number) {
  if (subtotal <= 0 || discountValue <= 0) {
    return 0;
  }

  const amount = discountType === "fixed"
    ? discountValue
    : subtotal * (discountValue / 100);

  return roundMoney(Math.min(Math.max(amount, 0), subtotal));
}

// Mirrors validateReferralCode's contract: null for "no code supplied",
// throws a user-facing Error for an invalid/expired/exhausted code so the
// checkout API can surface a clear message instead of silently ignoring it.
export async function validateCoupon(code: string | undefined, subtotal: number): Promise<CouponValidationResult | null> {
  const normalizedCode = normalizeCouponCode(code ?? "");

  if (!normalizedCode) {
    return null;
  }

  const { data, error } = await supabaseAdmin
    .from("coupons")
    .select("code, discount_type, discount_value, starts_at, ends_at, max_redemptions, redemptions_count, active")
    .eq("code", normalizedCode)
    .maybeSingle();

  if (error) {
    console.error("Coupon lookup failed:", error);
    throw new Error("Unable to verify coupon code");
  }

  if (!data || !data.active) {
    throw new Error("Invalid coupon code");
  }

  const now = Date.now();
  if (data.starts_at && new Date(data.starts_at).getTime() > now) {
    throw new Error("This coupon is not active yet");
  }

  if (data.ends_at && new Date(data.ends_at).getTime() < now) {
    throw new Error("This coupon has expired");
  }

  if (typeof data.max_redemptions === "number" && data.redemptions_count >= data.max_redemptions) {
    throw new Error("This coupon has reached its redemption limit");
  }

  const discountType = data.discount_type === "fixed" ? "fixed" : "percent";
  const discountValue = Number(data.discount_value ?? 0);

  return {
    code: data.code.toUpperCase(),
    discountType,
    discountValue,
    discountAmount: calculateCouponDiscount(subtotal, discountType, discountValue),
  };
}

// Called once a coupon's order is confirmed paid (see payment-webhook.ts) so
// abandoned/failed checkouts never consume redemption slots.
export async function redeemCoupon(code: string) {
  const normalizedCode = normalizeCouponCode(code);
  if (!normalizedCode) {
    return;
  }

  const { data, error } = await supabaseAdmin
    .from("coupons")
    .select("id, redemptions_count")
    .eq("code", normalizedCode)
    .maybeSingle();

  if (error) {
    console.error("Unable to load coupon for redemption:", error);
    return;
  }

  if (!data) {
    return;
  }

  const { error: updateError } = await supabaseAdmin
    .from("coupons")
    .update({ redemptions_count: Number(data.redemptions_count ?? 0) + 1 })
    .eq("id", data.id);

  if (updateError) {
    console.error("Unable to record coupon redemption:", updateError);
  }
}
