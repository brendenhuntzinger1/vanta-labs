import { NextResponse } from "next/server";
import { getRequestIpAddress, getRequestUserAgent, verifyAdminSessionFromRequest } from "@/lib/admin-auth";
import { canManageProducts } from "@/lib/admin-roles";
import { importProductsCsv } from "@/lib/admin-products-csv";
import { supabaseAdmin } from "@/lib/supabase-server";

const MAX_IMPORT_SIZE_BYTES = 2 * 1024 * 1024;

export async function POST(request: Request) {
  const session = await verifyAdminSessionFromRequest(request);
  if (!session) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }
  if (!canManageProducts(session.role)) {
    return NextResponse.json({ success: false, error: "Only managers and super admins can manage products." }, { status: 403 });
  }

  try {
    const csvText = await request.text();

    if (!csvText.trim()) {
      return NextResponse.json({ success: false, error: "Upload a CSV file with at least a header row and one product." }, { status: 400 });
    }

    if (csvText.length > MAX_IMPORT_SIZE_BYTES) {
      return NextResponse.json({ success: false, error: "CSV file is too large (max 2MB)." }, { status: 400 });
    }

    const result = await importProductsCsv(csvText);

    await supabaseAdmin.from("admin_audit_logs").insert({
      action: "products_csv_import",
      target_table: "products",
      target_id: null,
      metadata: {
        created: result.created,
        updated: result.updated,
        errorCount: result.errors.length,
        performedAt: new Date().toISOString(),
        performedBy: session.username,
        ipAddress: getRequestIpAddress(request),
        userAgent: getRequestUserAgent(request),
      },
    });

    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to import products";
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}
