import { supabase } from "@/lib/supabase";

/**
 * Confirm a referral code is real and active, for the cart's benefit.
 *
 * DELIBERATELY RETURNS NO DISCOUNT PERCENTAGE. It used to return a hardcoded
 * `discountPercent: 10`, which neither caller ever read — both take the figure
 * from /api/catalog/promotions instead. A constant that looks authoritative,
 * is wrong for any ambassador with a personal rate, and happens to be ignored
 * is a trap for whoever wires it up next, so it is gone rather than corrected.
 *
 * THE SERVER OWNS THE NUMBER regardless. quoteOrder resolves the per-ambassador
 * override against the program default and then picks the single best discount
 * available to that basket, so what the cart shows is an estimate of the
 * referral line and the order is authoritative. That is also why a referred
 * order can legitimately record a zero referral discount: quantity-bundle
 * pricing is already inside the subtotal, and when it beats the referral the
 * customer keeps the larger saving.
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
    };
  }

  if (!data?.valid) {
    return null;
  }

  return {
    referralCode: data.referral_code,
    ambassadorId: data.ambassador_id,
    ambassadorName: data.ambassador_name,
  };
}
