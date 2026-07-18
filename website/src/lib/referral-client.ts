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
    throw error;
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
