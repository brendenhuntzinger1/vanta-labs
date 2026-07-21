import { NextResponse } from "next/server";
import { getRequestIpAddress, getRequestUserAgent, verifyAdminSessionFromRequest } from "@/lib/admin-auth";
import { canManageRefunds } from "@/lib/admin-roles";
import { bulkUpdateAdminOrders, type AdminOrderBulkAction } from "@/lib/admin-orders";
import { supabaseAdmin } from "@/lib/supabase-server";

function unauthorizedResponse() {
  return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
}

export async function PATCH(request: Request) {
  const session = await verifyAdminSessionFromRequest(request);
  if (!session) {
    return unauthorizedResponse();
  }

  try {
    const body = await request.json() as { orderIds?: string[]; action?: AdminOrderBulkAction };
    const orderIds = Array.isArray(body.orderIds) ? body.orderIds.filter((id) => typeof id === "string" && id.length > 0) : [];
    const action = body.action;

    if (!action || orderIds.length === 0) {
      return NextResponse.json({ success: false, error: "Bulk action and orderIds are required" }, { status: 400 });
    }

    // Mass-cancel is destructive and money-adjacent, so it is gated to
    // manager+. Bulk mark-shipped/delivered are routine fulfillment and stay
    // available to all admins (matching the single-order fulfillment update).
    if (action === "cancel" && !canManageRefunds(session.role)) {
      return NextResponse.json(
        { success: false, error: "Your role does not have permission to cancel orders." },
        { status: 403 },
      );
    }

    await bulkUpdateAdminOrders({ orderIds, action });

    await supabaseAdmin.from("admin_audit_logs").insert({
      action: `order_bulk_${action}`,
      target_table: "orders",
      target_id: orderIds.join(","),
      metadata: {
        orderIds,
        count: orderIds.length,
        performedAt: new Date().toISOString(),
        performedBy: session.username,
        ipAddress: getRequestIpAddress(request),
        userAgent: getRequestUserAgent(request),
      },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to update orders";
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}
