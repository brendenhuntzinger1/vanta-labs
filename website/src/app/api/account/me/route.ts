import { NextResponse } from "next/server";
import { detectRoleFromUser } from "@/lib/auth-role";
import { getAuthenticatedUser } from "@/lib/auth-session";
import { getDefaultCustomerAddress } from "@/lib/customer-account";
import { getActivePointsMultiplier, getPointsBalance, getPointsRate } from "@/lib/rewards";
import { getStoreCreditBalanceCents } from "@/lib/store-credit";
import { customerSafeMessage } from "@/lib/safe-error";

export async function GET() {
  const user = await getAuthenticatedUser();
  if (!user || detectRoleFromUser(user) !== "customer") {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  const fullName = typeof user.user_metadata?.full_name === "string" ? user.user_metadata.full_name : "";

  let defaultAddress, pointsBalance, pointsPerDollar, pointsMultiplier, storeCreditBalanceCents;
  try {
    [defaultAddress, pointsBalance, pointsPerDollar, pointsMultiplier, storeCreditBalanceCents] = await Promise.all([
      getDefaultCustomerAddress(user.id),
      getPointsBalance(user.id),
      getPointsRate(),
      getActivePointsMultiplier(),
      // Still read, and still spendable: the paid membership feature was
      // removed on 2026-09-12 but credit customers already hold was not.
      getStoreCreditBalanceCents(user.id),
    ]);
  } catch (error) {
    // The account dashboard's primary endpoint must degrade to a clean JSON
    // error, not a raw 500 + stack, if any one read hiccups.
    const message = customerSafeMessage(error, "Unable to load account");
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
    pointsPerDollar,
    pointsMultiplier: pointsMultiplier.multiplier,
    storeCreditBalanceCents,
    // The redemption minimum was a per-tier setting; with no tiers there is no
    // minimum. Mirrors quote-order.ts, which resolves the same 0 server-side.
    storeCreditMinOrderCents: 0,
  });
}
