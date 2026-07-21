import { NextResponse } from "next/server";
import { verifyAdminSessionFromRequest } from "@/lib/admin-auth";
import { canManageRefunds } from "@/lib/admin-roles";
import { getPayoutHistory } from "@/lib/admin-ambassadors";

export async function GET(request: Request) {
  const session = await verifyAdminSessionFromRequest(request);
  if (!session) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }
  if (!canManageRefunds(session.role)) {
    return NextResponse.json({ success: false, error: "Forbidden" }, { status: 403 });
  }

  const rows = await getPayoutHistory();
  return NextResponse.json({ success: true, rows });
}
