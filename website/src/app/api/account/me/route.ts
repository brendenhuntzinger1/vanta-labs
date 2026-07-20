import { NextResponse } from "next/server";
import { detectRoleFromUser } from "@/lib/auth-role";
import { getAuthenticatedUser } from "@/lib/auth-session";
import { getDefaultCustomerAddress } from "@/lib/customer-account";
import { getActivePointsMultiplier, getCustomerMembership, getPointsBalance, isEligibleForBulkSavings } from "@/lib/membership";

export async function GET() {
  const user = await getAuthenticatedUser();
  if (!user || detectRoleFromUser(user) !== "customer") {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  const fullName = typeof user.user_metadata?.full_name === "string" ? user.user_metadata.full_name : "";

  const [defaultAddress, pointsBalance, membership, pointsMultiplier, isEligibleForBulk] = await Promise.all([
    getDefaultCustomerAddress(user.id),
    getPointsBalance(user.id),
    getCustomerMembership(user.id),
    getActivePointsMultiplier(),
    isEligibleForBulkSavings(user.id),
  ]);

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
  });
}
