import { NextResponse } from "next/server";
import { getRequestIpAddress, getRequestUserAgent, verifyAdminSessionFromRequest } from "@/lib/admin-auth";
import { canManageInventory } from "@/lib/admin-roles";
import { adjustInventoryLine, getInventoryRows } from "@/lib/admin-inventory";
import { supabaseAdmin } from "@/lib/supabase-server";

function unauthorizedResponse() {
  return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
}

export async function GET(request: Request) {
  const session = await verifyAdminSessionFromRequest(request);
  if (!session) {
    return unauthorizedResponse();
  }

  try {
    const rows = await getInventoryRows();
    return NextResponse.json({ success: true, rows });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load inventory";
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}

export async function PATCH(request: Request) {
  const session = await verifyAdminSessionFromRequest(request);
  if (!session) {
    return unauthorizedResponse();
  }

  if (!canManageInventory(session.role)) {
    return NextResponse.json({ success: false, error: "Your role does not have permission to manage inventory." }, { status: 403 });
  }

  try {
    const body = await request.json() as { productId?: string; doseId?: string | null; quantity?: number; lowStockThreshold?: number };

    if (!body.productId) {
      return NextResponse.json({ success: false, error: "productId is required" }, { status: 400 });
    }

    await adjustInventoryLine({
      productId: body.productId,
      doseId: body.doseId ?? null,
      quantity: body.quantity,
      lowStockThreshold: body.lowStockThreshold,
    });

    await supabaseAdmin.from("admin_audit_logs").insert({
      action: "inventory_adjust",
      target_table: body.doseId ? "product_doses" : "products",
      target_id: body.doseId ?? body.productId,
      metadata: {
        quantity: body.quantity ?? null,
        lowStockThreshold: body.lowStockThreshold ?? null,
        performedAt: new Date().toISOString(),
        performedBy: session.username,
        ipAddress: getRequestIpAddress(request),
        userAgent: getRequestUserAgent(request),
      },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to update inventory";
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}
