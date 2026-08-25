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
  customerDiscountPercent: number;
  ambassadorName: string;
  ambassadorId: string;
};
