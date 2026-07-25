import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-server";
import { getRequestIpAddress } from "@/lib/admin-auth";
import { checkRateLimit } from "@/lib/rate-limit";
import { resolveReferralCode } from "@/lib/referral-code-service";

const REFERRAL_COOKIE_NAME = "vl_referral_code";
const REFERRAL_COOKIE_MAX_AGE = 60 * 60 * 24 * 30;

export async function GET(request: Request, context: { params: Promise<{ code: string }> }) {
  const { code } = await context.params;
  const url = new URL(request.url);
  const redirectTarget = url.searchParams.get("next") || "/products";
  const destination = new URL(redirectTarget, url.origin);
  const response = NextResponse.redirect(destination);

  // Resolve to the ambassador: a live code, OR an aliased OLD code that redirects
  // to their CURRENT code (per the admin redirect policy). Unknown/expired/
  // disabled codes just fall through to the destination with no attribution.
  const resolved = await resolveReferralCode(code);
  if (!resolved) {
    return response;
  }

  const ipAddress = getRequestIpAddress(request);

  // Throttle click writes per IP so a known code can't be looped to inflate an
  // ambassador's click/conversion stats or hammer the DB. Over the limit we
  // still redirect + set the cookie, we just skip recording the click.
  const clickLimit = await checkRateLimit(`referral-click:${ipAddress ?? "unknown"}`, 60, 60);
  if (clickLimit.allowed) {
    await Promise.all([
      supabaseAdmin.from("partner_clicks").insert({
        ambassador_id: resolved.ambassadorId,
        referral_code: resolved.currentCode,
        landing_path: destination.pathname,
        utm_source: url.searchParams.get("utm_source"),
        utm_medium: url.searchParams.get("utm_medium"),
        utm_campaign: url.searchParams.get("utm_campaign"),
        referrer: request.headers.get("referer"),
        user_agent: request.headers.get("user-agent"),
        ip_address: ipAddress,
      }),
      supabaseAdmin.from("referrals").insert({
        partner_id: resolved.ambassadorId,
        referral_code: resolved.currentCode,
        event_type: "click",
        landing_path: destination.pathname,
        utm_source: url.searchParams.get("utm_source"),
        utm_medium: url.searchParams.get("utm_medium"),
        utm_campaign: url.searchParams.get("utm_campaign"),
        referrer: request.headers.get("referer"),
        user_agent: request.headers.get("user-agent"),
        ip_address: ipAddress,
      }),
    ]);
  }

  // Attribute to the CURRENT code so an old link credits the live code.
  response.cookies.set(REFERRAL_COOKIE_NAME, resolved.currentCode, {
    path: "/",
    maxAge: REFERRAL_COOKIE_MAX_AGE,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    httpOnly: false,
  });

  return response;
}
