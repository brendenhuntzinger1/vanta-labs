import { NextResponse } from "next/server";
import { detectRoleFromUser } from "@/lib/auth-role";
import { getAuthenticatedUser } from "@/lib/auth-session";
import { getDefaultCustomerAddress } from "@/lib/customer-account";
import { getActivePointsMultiplier, getCustomerMembership, getMembershipPerks, getPointsBalance, isEligibleForBulkSavings } from "@/lib/membership";
import { getApprovedPartnerByAuthUserId } from "@/lib/partner-portal";
import { getAmbassadorProgramSettings } from "@/lib/ambassador-settings";
import { getAmbassadorWalletBalanceCents } from "@/lib/ambassador-wallet";

export async function GET() {
  const user = await getAuthenticatedUser();
  if (!user || detectRoleFromUser(user) !== "customer") {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  const fullName = typeof user.user_metadata?.full_name === "string" ? user.user_metadata.full_name : "";

  const [defaultAddress, pointsBalance, membership, pointsMultiplier, isEligibleForBulk, perks, approvedPartner, ambassadorSettings] = await Promise.all([
    getDefaultCustomerAddress(user.id),
    getPointsBalance(user.id),
    getCustomerMembership(user.id),
    getActivePointsMultiplier(),
    isEligibleForBulkSavings(user.id),
    getMembershipPerks(user.id),
    getApprovedPartnerByAuthUserId(user.id).catch(() => null),
    getAmbassadorProgramSettings().catch(() => null),
  ]);

  // Approved ambassadors get this discount on their own orders (0 otherwise).
  const ambassadorDiscountPercent = approvedPartner ? (ambassadorSettings?.ambassadorDiscountPercent ?? 0) : 0;
  // Non-expiring ambassador store-credit wallet balance, spendable at checkout.
  const ambassadorWalletBalanceCents = approvedPartner
    ? await getAmbassadorWalletBalanceCents(user.id).catch(() => 0)
    : 0;

  return NextResponse.json({
    success: true,
    email: user.email ?? "",
    fullName,
    address: defaultAddress
      ? {
          fullName: defaultAddress.fullName,
          address: defaultAddress.address,
          city: defaultAddress.city,
          postalCode: defaultAddress.postalCode,
        }
      : null,
    pointsBalance,
    pointsPerDollar: membership.tier.pointsPerDollar,
    pointsMultiplier: pointsMultiplier.multiplier,
    tierName: membership.tier.name,
    isEligibleForBulkSavings: isEligibleForBulk,
    // Active-membership perks the checkout applies. All zero/false for
    // non-members and for members whose plan is no longer active.
    memberDiscountPercent: perks.memberDiscountPercent,
    memberFreeShipping: perks.freeShipping,
    storeCreditBalanceCents: perks.storeCreditBalanceCents,
    storeCreditMinOrderCents: perks.storeCreditMinOrderCents,
    ambassadorDiscountPercent,
    ambassadorWalletBalanceCents,
  });
}
