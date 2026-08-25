import { supabase } from "@/lib/supabase";

/**
 * Confirm a referral code is real and active, for the cart's benefit.
 *
 * RETURNS THE AMBASSADOR'S OWN CUSTOMER DISCOUNT, or null when they have no
 * override and inherit the program rate. Never their commission.
 *
 * It used to return a hardcoded `discountPercent: 10`. That was removed as a
 * lie — it is wrong for any ambassador with a personal rate — but nothing
 * replaced it, so the cart fell back to the program-wide default and a 15%
 * ambassador's customers were offered 10%. Removing the wrong number was
 * right; leaving the cart with no number at all is what caused the incident.
 *
 * `customerDiscountPercent` is deliberately RAW: the value as stored, or null.
 * Resolving null against the program default is the caller's job, through the
 * same resolveAmbassadorCustomerDiscount the server uses, so both sides apply
 * one rule. Coercing null to 0 here would give every inheriting ambassador a
 * 0% discount.
 *
 * THE SERVER STILL OWNS THE CHARGE. quoteOrder re-resolves the rate and picks
 * the single best discount for the basket, so the cart remains a preview — it
 * just no longer contradicts the price that gets charged. A referred order can
 * still legitimately record a zero referral discount when quantity-bundle
 * pricing inside the subtotal beats it and the customer keeps the larger
 * saving.
 */
export async function validateReferralCodeClient(code: string) {
  const normalizedCode = code.trim().toUpperCase();

  if (!normalizedCode) {
    return null;
  }

  const { data, error } = await supabase.rpc("validate_referral_code", {
    input_code: normalizedCode,
  });

  if (error) {
    const message = String(error.message ?? "").toLowerCase();
    const isMissingRpc = error.code === "PGRST202" || message.includes("could not find the function") || message.includes("does not exist");

    if (!isMissingRpc) {
      throw error;
    }

    const { data: ambassador, error: fallbackError } = await supabase
      .from("ambassadors")
      .select("id, name, referral_code, status")
      .eq("referral_code", normalizedCode)
      .maybeSingle();

    if (fallbackError) {
      throw fallbackError;
    }

    if (!ambassador || String(ambassador.status ?? "").toLowerCase() !== "approved") {
      return null;
    }

    return {
      referralCode: String(ambassador.referral_code ?? normalizedCode).toUpperCase(),
      ambassadorId: String(ambassador.id),
      ambassadorName: String(ambassador.name ?? "Ambassador"),
      // The legacy fallback path cannot see the column (the table select above
      // is deliberately narrow), so it inherits the program rate rather than
      // guessing. This runs only when the RPC is missing entirely.
      customerDiscountPercent: null,
    };
  }

  if (!data?.valid) {
    return null;
  }

  return {
    referralCode: data.referral_code,
    ambassadorId: data.ambassador_id,
    ambassadorName: data.ambassador_name,
    // Raw: a number, a numeric string, or null for "inherits the program rate".
    customerDiscountPercent: (data.customer_discount_percent ?? null) as number | string | null,
  };
}
