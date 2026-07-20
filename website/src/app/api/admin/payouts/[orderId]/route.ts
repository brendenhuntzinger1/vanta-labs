import { NextResponse } from "next/server";
import { verifyAdminSessionFromRequest } from "@/lib/admin-auth";
import { canManageRefunds } from "@/lib/admin-roles";
import { setPayoutStatus } from "@/lib/admin-payouts";

export async function PATCH(request: Request, context: { params: Promise<{ orderId: string }> }) {
  const session = await verifyAdminSessionFromRequest(request);
  if (!session) return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  if (!canManageRefunds(session.role)) {
    return NextResponse.json({ success: false, error: "Your role cannot manage payouts." }, { status: 403 });
  }

  const { orderId } = await context.params;
  try {
    const body = (await request.json()) as { status?: string; reference?: string };
    const status = String(body.status ?? "");
    if (!["pending", "paid", "failed"].includes(status)) {
      return NextResponse.json({ success: false, error: "Invalid payout status." }, { status: 400 });
    }
    await setPayoutStatus(orderId, status as "pending" | "paid" | "failed", body.reference);
    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to update payout";
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}
