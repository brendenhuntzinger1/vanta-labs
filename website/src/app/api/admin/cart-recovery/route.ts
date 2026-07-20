import { NextResponse } from "next/server";
import { verifyAdminSessionFromRequest } from "@/lib/admin-auth";
import { canManageCartRecovery } from "@/lib/admin-roles";
import { listAbandonedCarts, getCartRecoveryStats, getCartRecoveryTrend } from "@/lib/admin-cart-recovery";
import { getCartRecoveryControlConfig } from "@/lib/admin-control";

export async function GET(request: Request) {
  const session = await verifyAdminSessionFromRequest(request);
  if (!session) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  if (!canManageCartRecovery(session.role)) {
    return NextResponse.json({ success: false, error: "Your role does not have permission to manage cart recovery." }, { status: 403 });
  }

  try {
    const [carts, stats, weeklyTrend, monthlyTrend, config] = await Promise.all([
      listAbandonedCarts(),
      getCartRecoveryStats(),
      getCartRecoveryTrend(7),
      getCartRecoveryTrend(30),
      getCartRecoveryControlConfig(),
    ]);

    return NextResponse.json({ success: true, carts, stats, weeklyTrend, monthlyTrend, config });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load cart recovery data";
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}
