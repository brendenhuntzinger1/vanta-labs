import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-server";
import { verifyCampaignRecipient } from "@/lib/email/campaign-links";

export const dynamic = "force-dynamic";

// 1x1 transparent GIF.
const PIXEL = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");

/**
 * Open-tracking pixel.
 *
 * Worth knowing what this number is worth before anyone optimises against it:
 * Apple Mail Privacy Protection pre-fetches images for a large share of
 * recipients regardless of whether the message was ever read, and other clients
 * block images entirely. So opens are inflated at the top and missing at the
 * bottom, and the rate is not comparable between audiences. It is recorded
 * because it is nearly free and directionally useful across sends to the SAME
 * list — clicks and attributed revenue are the numbers that mean something.
 *
 * Always returns the pixel, whatever happens. A broken image in a marketing
 * email looks like a broken email.
 */
export async function GET(request: NextRequest) {
  const campaignId = request.nextUrl.searchParams.get("c") ?? "";
  const email = (request.nextUrl.searchParams.get("e") ?? "").trim().toLowerCase();
  const token = request.nextUrl.searchParams.get("t") ?? "";

  if (campaignId && email && verifyCampaignRecipient(campaignId, email, token)) {
    try {
      // First open only, so the timestamp means "when they first saw it".
      await supabaseAdmin
        .from("email_campaign_recipients")
        .update({ opened_at: new Date().toISOString() })
        .eq("campaign_id", campaignId)
        .eq("email", email)
        .is("opened_at", null);
    } catch {
      // Never worth failing the image over.
    }
  }

  return new NextResponse(PIXEL, {
    status: 200,
    headers: {
      "Content-Type": "image/gif",
      "Content-Length": String(PIXEL.length),
      // Must not be cached: a cached pixel would record one open and then go
      // quiet, and proxies would serve it to other recipients.
      "Cache-Control": "no-store, no-cache, must-revalidate, private",
      Pragma: "no-cache",
    },
  });
}
