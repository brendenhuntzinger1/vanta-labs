import { NextResponse } from "next/server";
import { verifyAdminSessionFromRequest } from "@/lib/admin-auth";
import { exportProductsCsv } from "@/lib/admin-products-csv";

export async function GET(request: Request) {
  const session = await verifyAdminSessionFromRequest(request);
  if (!session) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  try {
    const csv = await exportProductsCsv();
    return new NextResponse(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename=products-export-${new Date().toISOString().slice(0, 10)}.csv`,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to export products";
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}
