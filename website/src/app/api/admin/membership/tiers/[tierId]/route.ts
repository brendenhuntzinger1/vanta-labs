import { NextResponse } from "next/server";
import { getRequestIpAddress, getRequestUserAgent, verifyAdminSessionFromRequest } from "@/lib/admin-auth";
import { canManageMembership } from "@/lib/admin-roles";
import { updateMembershipTier, type MembershipTierInput } from "@/lib/admin-membership";
import { supabaseAdmin } from "@/lib/supabase-server";

export async function PATCH(request: Request, context: { params: Promise<{ tierId: string }> }) {
  const session = await verifyAdminSessionFromRequest(request);
  if (!session) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  if (!canManageMembership(session.role)) {
    return NextResponse.json({ success: false, error: "Your role does not have permission to manage membership tiers." }, { status: 403 });
  }

  const { tierId } = await context.params;

  try {
    const body = await request.json() as Partial<MembershipTierInput>;
    await updateMembershipTier(tierId, body);

    await supabaseAdmin.from("admin_audit_logs").insert({
      action: "membership_tier_update",
      target_table: "membership_tiers",
      target_id: tierId,
      metadata: {
        changes: body,
        performedAt: new Date().toISOString(),
        performedBy: session.username,
        ipAddress: getRequestIpAddress(request),
        userAgent: getRequestUserAgent(request),
      },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to update tier";
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}
