import { supabaseAdmin } from "@/lib/supabase-server";

// Is this shopper an APPROVED ambassador? Used to grant the personal ambassador
// discount on their own purchase (no commission is earned on it). A
// deactivated/removed ambassador (status not "approved") returns false, so the
// personal discount is revoked immediately.
//
// Shared by the authoritative checkout total (payment-service.ts) AND the
// account endpoint that drives the checkout preview, so the preview and the
// real charge can never disagree (which would otherwise trip the "Altered
// total detected" guard).
//
// -------------------------------------------------------------------------
// WHY THE EMAIL IS NOT TAKEN FROM THE CALLER ANY MORE.
//
// This used to match "by account first, then by email — so it works whether
// they shop with their ambassador account or a customer account on the same
// email". The intent is right; the second half had nothing behind it. Nothing
// established that the caller controlled the address it named, and quote-order
// passes the address straight off the checkout form:
//
//     isApprovedAmbassadorCustomer(input.customerUserId, input.customer.email)
//
// At guest checkout there is no account id, so ONLY the email branch ran. Type
// an approved ambassador's address into the form and the order took their
// personal discount — 20% by default, against nine approved ambassadors in the
// production project, whose addresses a referral programme tends to publish.
//
// So the address is now read from the ACCOUNT, never from the caller. A guest
// reaches only the account branch, which without an id does nothing.
//
// Reading the account's address rather than merely requiring that an id be
// present is what keeps the two callers in step. Trusting a supplied address
// whenever an id happened to exist would let the preview endpoint (which uses
// the session's own address) and the authoritative charge answer differently
// for a signed-in customer who typed a different delivery address — preview
// granting the discount, charge withholding it, and the "Altered total
// detected" guard meeting them at the till.
//
// The `email` parameter is kept because both callers already pass one and it
// documents intent at the call site, but it is deliberately NOT consulted.
// -------------------------------------------------------------------------
export async function isApprovedAmbassadorCustomer(
  customerUserId: string | undefined | null,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- see above: an
  // address supplied by the caller is exactly what must not be trusted here.
  _email?: string | undefined | null,
): Promise<boolean> {
  if (!customerUserId) {
    // A guest has proven nothing about who they are, so there is no identity to
    // match an ambassador against.
    return false;
  }

  const { data: byAccount } = await supabaseAdmin
    .from("ambassadors")
    .select("id")
    .eq("auth_user_id", customerUserId)
    .eq("status", "approved")
    .maybeSingle();
  if (byAccount) {
    return true;
  }

  // The documented case: an approved ambassador row that is not linked to the
  // account being shopped with. Matched on the ACCOUNT's own address, which the
  // caller cannot choose.
  const { data: account } = await supabaseAdmin.auth.admin.getUserById(customerUserId);
  const accountEmail = (account?.user?.email ?? "").trim().toLowerCase();
  if (!accountEmail) {
    // An id the auth store does not know. Fail closed rather than falling back
    // to the caller's address, which is the leak this function just closed.
    return false;
  }

  const { data: byEmail } = await supabaseAdmin
    .from("ambassadors")
    .select("id")
    .eq("email", accountEmail)
    .eq("status", "approved")
    .maybeSingle();

  return Boolean(byEmail);
}
