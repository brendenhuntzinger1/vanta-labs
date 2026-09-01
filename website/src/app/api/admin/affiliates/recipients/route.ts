import { NextResponse } from "next/server";
import { verifyAdminSessionFromRequest } from "@/lib/admin-auth";
import { canManageEmailCampaigns } from "@/lib/admin-roles";
import { listAffiliateDirectory } from "@/lib/email/affiliate-audience";

/**
 * The affiliate directory behind the recipient picker.
 *
 * Returns a name, an address, a code and a rate — never payout details or
 * anything else on the ambassador row. The email screen has no business
 * handling those, and an endpoint that returns them is one XSS away from
 * leaking them.
 */
export async function GET(request: Request) {
  const session = await verifyAdminSessionFromRequest(request);
  if (!session) return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  if (!canManageEmailCampaigns(session.role)) {
    return NextResponse.json({ success: false, error: "Forbidden" }, { status: 403 });
  }

  try {
    const affiliates = await listAffiliateDirectory();
    return NextResponse.json({ success: true, affiliates });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Unable to load affiliates" },
      { status: 400 },
    );
  }
}
