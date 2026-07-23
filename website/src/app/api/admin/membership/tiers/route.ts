import { NextResponse } from "next/server";
import { getRequestIpAddress, getRequestUserAgent, verifyAdminSessionFromRequest } from "@/lib/admin-auth";
import { canManageMembership } from "@/lib/admin-roles";
import { createMembershipTier, type MembershipTierInput } from "@/lib/admin-membership";
import { supabaseAdmin } from "@/lib/supabase-server";

export async function POST(request: Request) {
  const session = await verifyAdminSessionFromRequest(request);
  if (!session) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  if (!canManageMembership(session.role)) {
    return NextResponse.json({ success: false, error: "Your role does not have permission to manage membership tiers." }, { status: 403 });
  }

  try {
    const body = await request.json() as { name?: string } & Partial<MembershipTierInput>;
    const name = String(body.name ?? "").trim();
    if (!name) {
      return NextResponse.json({ success: false, error: "Tier name is required." }, { status: 400 });
    }

    const result = await createMembershipTier({ ...body, name });

    await supabaseAdmin.from("admin_audit_logs").insert({
      action: "membership_tier_create",
      target_table: "membership_tiers",
      target_id: result.id,
      metadata: {
        name,
        slug: result.slug,
        performedAt: new Date().toISOString(),
        performedBy: session.username,
        ipAddress: getRequestIpAddress(request),
        userAgent: getRequestUserAgent(request),
      },
    });

    return NextResponse.json({ success: true, id: result.id, slug: result.slug });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to create tier";
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}
