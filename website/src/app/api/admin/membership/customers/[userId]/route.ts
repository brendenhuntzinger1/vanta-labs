import { NextResponse } from "next/server";
import { getRequestIpAddress, getRequestUserAgent, verifyAdminSessionFromRequest } from "@/lib/admin-auth";
import { canManageMembership } from "@/lib/admin-roles";
import { adminAdjustPoints, setMembershipStatus } from "@/lib/admin-membership";
import { supabaseAdmin } from "@/lib/supabase-server";

export async function PATCH(request: Request, context: { params: Promise<{ userId: string }> }) {
  const session = await verifyAdminSessionFromRequest(request);
  if (!session) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  if (!canManageMembership(session.role)) {
    return NextResponse.json({ success: false, error: "Your role does not have permission to manage memberships." }, { status: 403 });
  }

  const { userId } = await context.params;

  try {
    const body = await request.json() as {
      action?: "adjust_points" | "set_status";
      amount?: number;
      note?: string;
      status?: "active" | "paused" | "cancelled";
    };

    if (body.action === "adjust_points") {
      const amount = Number(body.amount ?? 0);
      const note = String(body.note ?? "").trim();
      if (!amount || !note) {
        return NextResponse.json({ success: false, error: "A non-zero amount and a note are required." }, { status: 400 });
      }

      await adminAdjustPoints({ userId, amount, note });

      await supabaseAdmin.from("admin_audit_logs").insert({
        action: "membership_points_adjust",
        target_table: "points_ledger",
        target_id: userId,
        metadata: {
          amount,
          note,
          performedAt: new Date().toISOString(),
          performedBy: session.username,
          ipAddress: getRequestIpAddress(request),
          userAgent: getRequestUserAgent(request),
        },
      });

      return NextResponse.json({ success: true });
    }

    if (body.action === "set_status") {
      if (!body.status) {
        return NextResponse.json({ success: false, error: "status is required" }, { status: 400 });
      }

      await setMembershipStatus(userId, body.status);

      await supabaseAdmin.from("admin_audit_logs").insert({
        action: "membership_status_update",
        target_table: "customer_memberships",
        target_id: userId,
        metadata: {
          status: body.status,
          performedAt: new Date().toISOString(),
          performedBy: session.username,
          ipAddress: getRequestIpAddress(request),
          userAgent: getRequestUserAgent(request),
        },
      });

      return NextResponse.json({ success: true });
    }

    return NextResponse.json({ success: false, error: "Unknown action" }, { status: 400 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to update membership";
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}
