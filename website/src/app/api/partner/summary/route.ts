import { NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth-session";
import { getSiteUrl } from "@/lib/env";
import { getApprovedPartnerByAuthUserId, getPartnerSummary } from "@/lib/partner-portal";

export async function GET() {
  const user = await getAuthenticatedUser();
  if (!user) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  // Authorization is by APPROVED ambassador profile keyed to this auth user —
  // not by role — because an ambassador is now a normal customer account with
  // an approved partner profile. A user can only ever load their own summary.
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
