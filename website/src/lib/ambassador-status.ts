import { supabaseAdmin } from "@/lib/supabase-server";

// Is this shopper an APPROVED ambassador? Used to grant the personal ambassador
// discount on their own purchase (no commission is earned on it). Matched by
// account first, then by email — so it works whether they shop with their
// ambassador account or a customer account on the same email. A
// deactivated/removed ambassador (status not "approved") returns false, so the
// personal discount is revoked immediately.
//
// Shared by the authoritative checkout total (payment-service.ts) AND the
// account endpoint that drives the checkout preview, so the preview and the
// real charge can never disagree (which would otherwise trip the "Altered
// total detected" guard).
export async function isApprovedAmbassadorCustomer(
  customerUserId: string | undefined | null,
  email: string | undefined | null,
): Promise<boolean> {
  if (customerUserId) {
    const { data } = await supabaseAdmin
      .from("ambassadors")
      .select("id")
      .eq("auth_user_id", customerUserId)
      .eq("status", "approved")
      .maybeSingle();
    if (data) {
      return true;
    }
  }

  const normalizedEmail = (email ?? "").trim().toLowerCase();
  if (normalizedEmail) {
    const { data } = await supabaseAdmin
      .from("ambassadors")
      .select("id")
      .eq("email", normalizedEmail)
      .eq("status", "approved")
      .maybeSingle();
    if (data) {
      return true;
    }
  }

  return false;
}
