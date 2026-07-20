import { NextResponse } from "next/server";
import { detectRoleFromUser } from "@/lib/auth-role";
import { getAuthenticatedUser } from "@/lib/auth-session";
import { getSiteUrl } from "@/lib/env";
import { getApprovedPartnerByAuthUserId, getPartnerSummary } from "@/lib/partner-portal";

export async function GET() {
  const user = await getAuthenticatedUser();
  if (!user) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  const role = detectRoleFromUser(user);
  if (role !== "partner" && role !== "admin") {
    return NextResponse.json({ success: false, error: "Forbidden" }, { status: 403 });
  }

  try {
    const partner = await getApprovedPartnerByAuthUserId(user.id);
    if (!partner) {
      return NextResponse.json({ success: false, error: "Partner account not approved yet" }, { status: 403 });
    }

    const siteUrl = getSiteUrl();
    const summary = await getPartnerSummary(partner.id, siteUrl);
    return NextResponse.json({ success: true, summary });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load partner summary";
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}
