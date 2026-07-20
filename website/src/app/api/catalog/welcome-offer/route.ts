import { NextResponse } from "next/server";
import { getWelcomeOffer } from "@/lib/admin-control";

export const dynamic = "force-dynamic";

// Public: the welcome banner reads the offer to display. Returns nothing when
// the offer is disabled.
export async function GET() {
  try {
    const offer = await getWelcomeOffer();
    if (!offer.enabled) {
      return NextResponse.json({ success: true, offer: null });
    }
    return NextResponse.json({
      success: true,
      offer: { code: offer.code, percent: offer.percent, headline: offer.headline, subtext: offer.subtext },
    });
  } catch {
    return NextResponse.json({ success: true, offer: null });
  }
}
