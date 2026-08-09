import { NextResponse } from "next/server";
import { verifyAdminSessionFromCookie } from "@/lib/admin-auth";
import { fetchCampaignPerformance, readAdsCredentials, writesEnabled } from "@/lib/ads/tiktok-ads-api";

/**
 * Real campaign performance, or an honest account of why there is none.
 *
 * Fetched from the browser rather than during the admin page's render on
 * purpose: an outage or a slow response at TikTok would otherwise take the
 * whole advertising page down, and a reporting call has no business being able
 * to do that.
 *
 * It never invents a row. Not connected returns not connected; a rejection
 * returns TikTok's own code and message.
 */
export async function GET(request: Request) {
  const session = await verifyAdminSessionFromCookie();
  if (!session) return NextResponse.json({ error: "admin session required" }, { status: 401 });

  const credentials = readAdsCredentials();
  if (!credentials) {
    return NextResponse.json(
      {
        connected: false,
        reason:
          "The Ads Management API is not connected. This is a different credential from the Events API token that reports conversions.",
        missing: [
          !process.env.TIKTOK_ADS_ACCESS_TOKEN?.trim() ? "TIKTOK_ADS_ACCESS_TOKEN" : null,
          !process.env.TIKTOK_ADVERTISER_ID?.trim() ? "TIKTOK_ADVERTISER_ID" : null,
        ].filter(Boolean),
      },
      { status: 200 },
    );
  }

  const url = new URL(request.url);
  const days = Math.min(90, Math.max(1, Number(url.searchParams.get("days") ?? 30)));
  const until = new Date();
  const since = new Date(until.getTime() - (days - 1) * 86_400_000);
  const iso = (date: Date) => date.toISOString().slice(0, 10);

  const result = await fetchCampaignPerformance({ credentials, since: iso(since), until: iso(until) });

  if (!result.ok) {
    return NextResponse.json(
      {
        connected: true,
        ok: false,
        // TikTok's own words. A reporting failure that paraphrases itself is
        // impossible to take to their support desk.
        code: result.code,
        message: result.message,
        requestId: result.requestId,
      },
      { status: 200, headers: { "cache-control": "no-store" } },
    );
  }

  return NextResponse.json(
    {
      connected: true,
      ok: true,
      writesEnabled: writesEnabled(),
      range: { since: iso(since), until: iso(until) },
      rows: result.data,
    },
    { status: 200, headers: { "cache-control": "no-store" } },
  );
}
