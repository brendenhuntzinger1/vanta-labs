import { NextResponse } from "next/server";
import { businessDayKey } from "@/lib/business-day";
import { verifyAdminSessionFromRequest } from "@/lib/admin-auth";
import { canManageProducts } from "@/lib/admin-roles";
import { exportProductsCsv } from "@/lib/admin-products-csv";

export async function GET(request: Request) {
  const session = await verifyAdminSessionFromRequest(request);
  if (!session) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }
  // Consistency with every other product route (import/update are manager+).
  if (!canManageProducts(session.role)) {
    return NextResponse.json({ success: false, error: "Forbidden" }, { status: 403 });
  }

  try {
    const csv = await exportProductsCsv();
    return new NextResponse(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename=products-export-${businessDayKey(new Date())}.csv`,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to export products";
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}
