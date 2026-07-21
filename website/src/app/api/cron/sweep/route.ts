import { NextResponse } from "next/server";
import { grantMonthlyStoreCreditSweep, runMembershipBillingSweep } from "@/lib/membership-billing";
import { runAbandonedCartSweep } from "@/lib/cart-recovery";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Single scheduled entry point for every time-based job in the app
// (membership billing dates + the abandoned-cart-recovery email sequence).
// Protected by CRON_SECRET rather than a user session, since nothing
// human-driven calls this - see vercel.json for the schedule. Both sweeps
// are individually idempotent (see their own doc comments), so calling
// this more often than strictly necessary is always safe, and calling it
// less often than the "ideal" cadence just means coarser timing, not
// incorrect behavior.
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  const authHeader = request.headers.get("authorization");

  if (!secret || authHeader !== `Bearer ${secret}`) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  const [membershipResult, cartRecoveryResult, storeCreditResult] = await Promise.allSettled([
    runMembershipBillingSweep(),
    runAbandonedCartSweep(),
    grantMonthlyStoreCreditSweep(),
  ]);

  return NextResponse.json({
    success: true,
    membershipBilling: membershipResult.status === "fulfilled" ? membershipResult.value : { error: String(membershipResult.reason) },
    cartRecovery: cartRecoveryResult.status === "fulfilled" ? cartRecoveryResult.value : { error: String(cartRecoveryResult.reason) },
    storeCredit: storeCreditResult.status === "fulfilled" ? storeCreditResult.value : { error: String(storeCreditResult.reason) },
  });
}
