/**
 * What the CART knows about an applied referral code.
 *
 * No commissionPercent. It used to be here, carried from the anonymous
 * validate_referral_code RPC, stored on referralDetails, and rendered by
 * nothing — while being readable by anyone with the public anon key. What
 * Vanta pays an ambassador is not the shopper's business and was never the
 * client's to hold.
 *
 * The commission that is actually paid is resolved server-side in
 * quote-order.ts, which re-reads it from the ambassadors table with the
 * service role. The client only ever supplies the code.
 */
export type ReferralCode = {
  code: string;
  /**
   * The percent the shopper is actually offered: this ambassador's own rate, or
   * the programme default when she inherits. Always resolved — never the raw
   * override — because every surface that prints or prices a referral reads it.
   */
  customerDiscountPercent: number;
  /**
   * The UNRESOLVED override as the validate endpoint returned it: a number when
   * she has her own rate, null when she inherits the programme default.
   *
   * Kept because the resolution depends on the programme default, and that
   * arrives asynchronously. Without the raw value the resolved percent is a
   * snapshot of whatever the default happened to be at the instant the code was
   * validated — and the cart validates before the promotions read lands, so an
   * inheriting ambassador's shopper was quoted whatever stale default was in
   * hand. Holding the raw value lets the resolution be redone when the real
   * default arrives, with no second network call.
   *
   * Typed `unknown` to match resolveAmbassadorCustomerDiscount's own parameter,
   * which is deliberately permissive: the validate endpoint can hand back a
   * number, a numeric string, an empty string or null, and that function owns
   * the rule for every one of them (an empty string is ABSENT, not zero —
   * Number("") is 0, and reading it as 0% would silently strip the discount).
   * Narrowing here would only move that decision somewhere with less context.
   */
  rawCustomerDiscountPercent?: unknown;
  ambassadorName: string;
  ambassadorId: string;
};
