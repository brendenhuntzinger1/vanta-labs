import { supabaseAdmin } from "@/lib/supabase-server";
import { getWelcomeOffer } from "@/lib/admin-control";

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
// customerEmail is required to redeem a coupon assigned to a single
// recipient (e.g. an abandoned-cart-recovery code - see
// mintCartRecoveryCoupon in src/lib/cart-recovery.ts); store-wide coupons
// ignore it.
export async function validateCoupon(code: string | undefined, subtotal: number, customerEmail?: string): Promise<CouponValidationResult | null> {
  const normalizedCode = normalizeCouponCode(code ?? "");

  if (!normalizedCode) {
    return null;
  }

  // Welcome offer acts as a virtual coupon (no DB row) when enabled, so the
  // owner can promote a first-order code without managing a coupon record.
  // Enforced as first-order-only: once the customer's email has a paid order,
  // the code stops working (checked server-side where the email is known).
  try {
    const welcome = await getWelcomeOffer();
    if (welcome.enabled && welcome.percent > 0 && normalizeCouponCode(welcome.code) === normalizedCode) {
      const email = (customerEmail ?? "").trim().toLowerCase();
      if (email) {
        const { data: priorPaid } = await supabaseAdmin
          .from("orders")
          .select("id")
          .eq("customer_email", email)
          .eq("payment_status", "paid")
          .limit(1)
          .maybeSingle();
        if (priorPaid) {
          throw new Error("This welcome offer is for first orders only.");
        }
      }
      return {
        code: normalizedCode,
        discountType: "percent",
        discountValue: welcome.percent,
        discountAmount: calculateCouponDiscount(subtotal, "percent", welcome.percent),
      };
    }
  } catch (e) {
    // Re-throw the user-facing first-order error; otherwise fall through to the
    // normal coupon lookup.
    if (e instanceof Error && e.message.includes("first orders only")) {
      throw e;
    }
  }

  const { data, error } = await supabaseAdmin
    .from("coupons")
    .select("code, discount_type, discount_value, starts_at, ends_at, max_redemptions, redemptions_count, active, assigned_email")
    .eq("code", normalizedCode)
    .maybeSingle();

  if (error) {
    console.error("Coupon lookup failed:", error);
    throw new Error("Unable to verify coupon code");
  }

  if (!data || !data.active) {
    throw new Error("Invalid coupon code");
  }

  if (data.assigned_email && data.assigned_email.toLowerCase() !== (customerEmail ?? "").trim().toLowerCase()) {
    throw new Error("This coupon code is tied to a different email address");
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

export interface ActiveCouponSummary {
  code: string;
  discountType: "percent" | "fixed";
  discountValue: number;
  endsAt: string | null;
}

// Customer-facing listing (account dashboard, checkout hints) - only the
// fields a shopper needs to decide whether to use a code, not redemption
// counts or internal limits.
export async function getActiveCouponsForDisplay(): Promise<ActiveCouponSummary[]> {
  const nowIso = new Date().toISOString();

  const { data, error } = await supabaseAdmin
    .from("coupons")
    .select("code, discount_type, discount_value, starts_at, ends_at, active")
    .eq("active", true)
    .or(`starts_at.is.null,starts_at.lte.${nowIso}`)
    .or(`ends_at.is.null,ends_at.gte.${nowIso}`)
    .order("created_at", { ascending: false })
    .limit(10);

  if (error) {
    throw error;
  }

  return (data ?? []).map((row) => ({
    code: String(row.code),
    discountType: row.discount_type === "fixed" ? "fixed" : "percent",
    discountValue: Number(row.discount_value ?? 0),
    endsAt: row.ends_at ? String(row.ends_at) : null,
  }));
}
