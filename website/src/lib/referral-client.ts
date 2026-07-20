import { supabase } from "@/lib/supabase";

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
      .select("id, name, referral_code, commission_percent, status")
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
      commissionPercent: Number(ambassador.commission_percent ?? 0),
      discountPercent: 10,
    };
  }

  if (!data?.valid) {
    return null;
  }

  return {
    referralCode: data.referral_code,
    ambassadorId: data.ambassador_id,
    ambassadorName: data.ambassador_name,
    commissionPercent: data.commission_percent,
    discountPercent: 10,
  };
}
