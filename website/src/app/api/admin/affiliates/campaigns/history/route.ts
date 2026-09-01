import { NextResponse } from "next/server";
import { verifyAdminSessionFromRequest } from "@/lib/admin-auth";
import { canManageEmailCampaigns } from "@/lib/admin-roles";
import { getAffiliateEmailDashboard } from "@/lib/admin-affiliate-email";

/**
 * Refresh the campaign history without reloading the page.
 *
 * A static segment, so it is matched before the [campaignId] route beside it —
 * "history" is never read as a campaign id.
 */
export async function GET(request: Request) {
  const session = await verifyAdminSessionFromRequest(request);
  if (!session) return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  if (!canManageEmailCampaigns(session.role)) {
    return NextResponse.json({ success: false, error: "Forbidden" }, { status: 403 });
  }

  try {
    const dashboard = await getAffiliateEmailDashboard();
    return NextResponse.json({ success: true, campaigns: dashboard.campaigns, activeAffiliates: dashboard.activeAffiliates });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Unable to load history" },
      { status: 400 },
    );
  }
}
