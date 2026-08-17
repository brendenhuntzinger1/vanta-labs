import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-server";
import {
  ATTRIBUTION_WINDOW_MS,
  CAMPAIGN_COOKIE,
  encodeAttributionCookie,
  safeCampaignDestination,
  verifyCampaignRecipient,
} from "@/lib/email/campaign-links";
import { hashIpAddress } from "@/lib/ip-hash";

export const dynamic = "force-dynamic";

/**
 * Campaign click tracker.
 *
 * Records the click, stamps the attribution cookie, and forwards the customer
 * to the campaign's own destination.
 *
 * THE REDIRECT TARGET COMES FROM THE DATABASE, NOT THE REQUEST. Nothing in the
 * query string can influence where someone ends up — the campaign row's stored
 * `cta_path` is the only source, and it is normalised to a same-origin URL on
 * the way out. This is the difference between a tracking link and an open
 * redirect on a domain customers trust because it arrived in our email.
 *
 * A tracking failure must never strand a customer on an error page: every
 * failure path below still redirects. Losing one click from a report is a
 * rounding error; losing the click-through is a lost sale.
 */
export async function GET(request: NextRequest) {
  const campaignId = request.nextUrl.searchParams.get("c") ?? "";
  const email = (request.nextUrl.searchParams.get("e") ?? "").trim().toLowerCase();
  const token = request.nextUrl.searchParams.get("t") ?? "";

  const fallback = safeCampaignDestination(null);

  if (!campaignId || !email || !verifyCampaignRecipient(campaignId, email, token)) {
    // Unsigned or tampered link: send them to the store rather than showing an
    // error, but record nothing.
    return NextResponse.redirect(fallback, { status: 302 });
  }

  let destination = fallback;
  try {
    const { data: campaign } = await supabaseAdmin
      .from("email_campaigns")
      .select("id, cta_path")
      .eq("id", campaignId)
      .maybeSingle();
    if (!campaign) {
      return NextResponse.redirect(fallback, { status: 302 });
    }
    destination = safeCampaignDestination(campaign.cta_path as string | null);
  } catch {
    return NextResponse.redirect(fallback, { status: 302 });
  }

  const clickedAt = new Date();

  // Recording is best-effort and deliberately not awaited as a barrier to the
  // redirect's correctness — but it IS awaited, because a serverless function
  // can be frozen the moment it responds, and a fire-and-forget insert here
  // would be lost more often than not.
  try {
    await supabaseAdmin.from("email_campaign_clicks").insert({
      campaign_id: campaignId,
      email,
      clicked_at: clickedAt.toISOString(),
      user_agent: request.headers.get("user-agent")?.slice(0, 300) ?? null,
      ip_hash: hashIpAddress(
        request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
          ?? request.headers.get("x-real-ip"),
      ),
    });

    // First click only — `clicked_at` on the recipient row is "did this person
    // ever click", and overwriting it on every click would lose that.
    await supabaseAdmin
      .from("email_campaign_recipients")
      .update({ clicked_at: clickedAt.toISOString() })
      .eq("campaign_id", campaignId)
      .eq("email", email)
      .is("clicked_at", null);
  } catch {
    // Metrics are not worth failing a customer's click over.
  }

  const response = NextResponse.redirect(destination, { status: 302 });
  response.cookies.set({
    name: CAMPAIGN_COOKIE,
    value: encodeAttributionCookie(campaignId, clickedAt.getTime()),
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: Math.floor(ATTRIBUTION_WINDOW_MS / 1000),
  });
  return response;
}
