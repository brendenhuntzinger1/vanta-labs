import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-server";

const REFERRAL_COOKIE_NAME = "vl_referral_code";
const REFERRAL_COOKIE_MAX_AGE = 60 * 60 * 24 * 30;

function normalizeReferralCode(code: string) {
  return code.trim().toUpperCase().replace(/[^A-Z0-9-]/g, "");
}

export async function GET(request: Request, context: { params: Promise<{ code: string }> }) {
  const { code } = await context.params;
  const referralCode = normalizeReferralCode(code);
  const url = new URL(request.url);
  const redirectTarget = url.searchParams.get("next") || "/products";
  const destination = new URL(redirectTarget, url.origin);

  const response = NextResponse.redirect(destination);

  if (!referralCode) {
    return response;
  }

  const { data: partnerFromPartners, error: partnerError } = await supabaseAdmin
    .from("partners")
    .select("id, referral_code, status")
    .eq("referral_code", referralCode)
    .maybeSingle();

  const { data: partnerFromAmbassadors, error: ambassadorError } = await supabaseAdmin
    .from("ambassadors")
    .select("id, referral_code, status")
    .eq("referral_code", referralCode)
    .maybeSingle();

  const partner = partnerFromPartners ?? partnerFromAmbassadors;
  const error = partnerError ?? ambassadorError;

  if (error || !partner || partner.status !== "approved") {
    return response;
  }

  const forwardedFor = request.headers.get("x-forwarded-for") ?? "";
  const ipAddress = forwardedFor.split(",")[0]?.trim() || null;

  await Promise.all([
    supabaseAdmin.from("partner_clicks").insert({
      ambassador_id: partner.id,
      referral_code: partner.referral_code,
      landing_path: destination.pathname,
      utm_source: url.searchParams.get("utm_source"),
      utm_medium: url.searchParams.get("utm_medium"),
      utm_campaign: url.searchParams.get("utm_campaign"),
      referrer: request.headers.get("referer"),
      user_agent: request.headers.get("user-agent"),
      ip_address: ipAddress,
    }),
    supabaseAdmin.from("referrals").insert({
      partner_id: partner.id,
      referral_code: partner.referral_code,
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

  response.cookies.set(REFERRAL_COOKIE_NAME, partner.referral_code, {
    path: "/",
    maxAge: REFERRAL_COOKIE_MAX_AGE,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    httpOnly: false,
  });

  return response;
}
