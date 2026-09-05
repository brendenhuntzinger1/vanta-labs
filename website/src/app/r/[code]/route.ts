import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-server";
import { getRequestIpAddress } from "@/lib/admin-auth";
import { checkRateLimit } from "@/lib/rate-limit";
import { resolveReferralCode } from "@/lib/referral-code-service";
import { hasAnalyticsConsent } from "@/lib/cookie-consent-server";
import { safeInternalPath } from "@/lib/internal-path";

const REFERRAL_COOKIE_NAME = "vl_referral_code";
const REFERRAL_COOKIE_MAX_AGE = 60 * 60 * 24 * 30;

export async function GET(request: Request, context: { params: Promise<{ code: string }> }) {
  const { code } = await context.params;
  const url = new URL(request.url);
  // Only ever redirect to a same-origin, absolute internal path. An attacker
  // could otherwise pass ?next=https://evil.example (or //evil.example) and turn
  // this public, widely-shared referral link into an open redirect / phishing
  // primitive on the trusted brand domain.
  const rawNext = url.searchParams.get("next") || "/products";
  const safeNext = safeInternalPath(rawNext, "/products");
  const destination = new URL(safeNext, url.origin);
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
    // WHAT MAY BE RECORDED WITHOUT CONSENT, AND WHAT MAY NOT.
    //
    // This block used to write utm_source, utm_medium, utm_campaign, the
    // referrer, the user agent and the raw IP of every click, before the
    // visitor had answered the banner and regardless of what they answered.
    // The published Cookie Policy itemises "any campaign parameters from the
    // link you arrived through" under "Analytics — only if you accept", and
    // says "choosing Decline on the banner stops all non-essential storage".
    //
    // The reason it could not honour that was architectural: the choice lived
    // in localStorage, which a route handler cannot read. It is now mirrored
    // into a cookie, so this can ask. `unset` counts as no.
    //
    // The attribution itself — which ambassador, which code, where the click
    // landed — is still recorded either way. It is what pays the ambassador,
    // and whether THAT is essential storage is the owner's call, not a
    // decision to make silently inside a bug fix. Flagged, not changed.
    const analyticsConsented = hasAnalyticsConsent(request);
    const tracking = analyticsConsented
      ? {
          utm_source: url.searchParams.get("utm_source"),
          utm_medium: url.searchParams.get("utm_medium"),
          utm_campaign: url.searchParams.get("utm_campaign"),
          referrer: request.headers.get("referer"),
          user_agent: request.headers.get("user-agent"),
          ip_address: ipAddress,
        }
      : {};

    await Promise.all([
      supabaseAdmin.from("partner_clicks").insert({
        ambassador_id: resolved.ambassadorId,
        referral_code: resolved.currentCode,
        landing_path: destination.pathname,
        ...tracking,
      }),
      supabaseAdmin.from("referrals").insert({
        partner_id: resolved.ambassadorId,
        referral_code: resolved.currentCode,
        event_type: "click",
        landing_path: destination.pathname,
        ...tracking,
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
