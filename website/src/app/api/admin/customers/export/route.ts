import { NextResponse } from "next/server";
import { verifyAdminSessionFromRequest } from "@/lib/admin-auth";
import { canManageSettings } from "@/lib/admin-roles";
import { exportCustomersCsv } from "@/lib/admin-customers";

export async function GET(request: Request) {
  const session = await verifyAdminSessionFromRequest(request);
  if (!session) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }
  // Bulk PII export is manager+ only.
  if (!canManageSettings(session.role)) {
    return NextResponse.json({ success: false, error: "Your role cannot export customer data." }, { status: 403 });
  }

  try {
    const csv = await exportCustomersCsv();
    return new NextResponse(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename=customers-export-${new Date().toISOString().slice(0, 10)}.csv`,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to export customers";
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}
