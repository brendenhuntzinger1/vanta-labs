import { NextResponse } from "next/server";
import { getRequestIpAddress, getRequestUserAgent, verifyAdminSessionFromRequest } from "@/lib/admin-auth";
import { canManageTeam, normalizeAdminRole } from "@/lib/admin-roles";
import { updateAdminAccount } from "@/lib/admin-team";
import { supabaseAdmin } from "@/lib/supabase-server";

export async function PATCH(request: Request, context: { params: Promise<{ username: string }> }) {
  const session = await verifyAdminSessionFromRequest(request);
  if (!session) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  if (!canManageTeam(session.role)) {
    return NextResponse.json({ success: false, error: "Only super admins can manage the team." }, { status: 403 });
  }

  const { username } = await context.params;

  try {
    const body = await request.json() as { role?: string; isActive?: boolean };

    if (body.isActive === false && username.trim().toLowerCase() === session.username.trim().toLowerCase()) {
      return NextResponse.json({ success: false, error: "You cannot deactivate your own account." }, { status: 400 });
    }

    await updateAdminAccount(username, {
      role: body.role !== undefined ? normalizeAdminRole(body.role) : undefined,
      isActive: body.isActive,
    });

    await supabaseAdmin.from("admin_audit_logs").insert({
      action: "admin_account_update",
      target_table: "admin_credentials",
      target_id: username.toLowerCase(),
      metadata: {
        role: body.role ?? null,
        isActive: body.isActive ?? null,
        performedAt: new Date().toISOString(),
        performedBy: session.username,
        ipAddress: getRequestIpAddress(request),
        userAgent: getRequestUserAgent(request),
      },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to update account";
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}
