import { NextResponse } from "next/server";
import { detectRoleFromUser } from "@/lib/auth-role";
import { getAuthenticatedUser } from "@/lib/auth-session";
import { getDefaultCustomerAddress } from "@/lib/customer-account";
import { getActivePointsMultiplier, getCustomerMembership, getMembershipPerks, getPointsBalance, isEligibleForBulkSavings } from "@/lib/membership";

export async function GET() {
  const user = await getAuthenticatedUser();
  if (!user || detectRoleFromUser(user) !== "customer") {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  const fullName = typeof user.user_metadata?.full_name === "string" ? user.user_metadata.full_name : "";

  let defaultAddress, pointsBalance, membership, pointsMultiplier, isEligibleForBulk, perks;
  try {
    [defaultAddress, pointsBalance, membership, pointsMultiplier, isEligibleForBulk, perks] = await Promise.all([
      getDefaultCustomerAddress(user.id),
      getPointsBalance(user.id),
      getCustomerMembership(user.id),
      getActivePointsMultiplier(),
      isEligibleForBulkSavings(user.id),
      getMembershipPerks(user.id),
    ]);
  } catch (error) {
    // The account dashboard's primary endpoint must degrade to a clean JSON
    // error, not a raw 500 + stack, if any one read hiccups.
    const message = error instanceof Error ? error.message : "Unable to load account";
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }

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
  });
}
