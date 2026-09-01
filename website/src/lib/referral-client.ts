
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

  // THROUGH THE APPLICATION, NOT STRAIGHT AT POSTGREST.
  //
  // This used to call the `validate_referral_code` RPC with the anon key. That
  // worked, but it meant every referral check bypassed the application's rate
  // limiter — so the codes, which are short and human-chosen, could be swept
  // for ambassador names by anyone holding the public anon key that ships in
  // the client bundle. referral-rpc-minimise.sql documented that as the
  // residual it could not close from the database.
  //
  // The route returns the same fields the RPC did, so nothing downstream
  // changes: `customerDiscountPercent` is still RAW, and its null still means
  // "inherits the programme rate".
  const response = await fetch("/api/catalog/referral/validate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: normalizedCode }),
  });

  if (!response.ok) {
    // A refusal is NOT "this code is invalid". Returning null here would
    // silently strip a real ambassador's discount from a real basket because
    // of a blip or a throttle, which is the failure mode this whole module has
    // been burned by before. Throwing lets the cart keep the code attached and
    // say something true.
    throw new Error(
      response.status === 429
        ? "Too many referral code attempts. Please wait a moment and try again."
        : "Could not check that referral code right now.",
    );
  }

  const data = (await response.json()) as {
    valid?: boolean;
    referralCode?: string;
    ambassadorId?: string;
    ambassadorName?: string;
    customerDiscountPercent?: number | string | null;
  };

  if (!data?.valid) {
    return null;
  }

  return {
    referralCode: String(data.referralCode ?? normalizedCode).toUpperCase(),
    ambassadorId: String(data.ambassadorId ?? ""),
    ambassadorName: String(data.ambassadorName ?? "Ambassador"),
    // Raw: a number, a numeric string, or null for "inherits the program rate".
    customerDiscountPercent: (data.customerDiscountPercent ?? null) as number | string | null,
  };
}
