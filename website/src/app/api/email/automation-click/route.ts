import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-server";
import {
  AUTOMATION_COOKIE,
  AUTOMATION_COOKIE_MAX_AGE_SECONDS,
  encodeAutomationCookie,
  safeAutomationDestination,
  verifyAutomationLink,
} from "@/lib/email/automation-links";
import { isAutomationKey } from "@/lib/email/automations";
import { hashIpAddress } from "@/lib/ip-hash";

export const dynamic = "force-dynamic";

/**
 * Retention-automation click tracker.
 *
 * The twin of /api/email/click, and it obeys the same two rules that make a
 * tracking redirect safe rather than a liability:
 *
 *   THE DESTINATION COMES FROM THE DATABASE, NEVER FROM THE URL. Nothing in the
 *   query string can influence where somebody lands. The automation row's
 *   stored `cta_path` is the only source, and it is resolved against the site
 *   origin on the way out. This is the difference between a tracking link and
 *   an open redirect on a domain customers have been trained to click.
 *
 *   A TRACKING FAILURE MUST NEVER STRAND A CUSTOMER. Every path below still
 *   redirects, including the ones that record nothing. Losing a click from a
 *   report is a rounding error; losing the click-through is a lost sale.
 *
 * The key is validated against AUTOMATION_KEYS before it reaches the database
 * — not for safety (the query is parameterised and the HMAC has already
 * passed) but so a renamed automation produces a clean fallback rather than a
 * lookup for a row that cannot exist.
 */
export async function GET(request: NextRequest) {
  const automationKey = request.nextUrl.searchParams.get("k") ?? "";
  const email = (request.nextUrl.searchParams.get("e") ?? "").trim().toLowerCase();
  const referenceId = request.nextUrl.searchParams.get("r") ?? "";
  const token = request.nextUrl.searchParams.get("t") ?? "";

  const fallback = safeAutomationDestination(null);

  if (
    !automationKey
    || !email
    || !referenceId
    || !isAutomationKey(automationKey)
    || !verifyAutomationLink(automationKey, email, referenceId, token)
  ) {
    // Unsigned, tampered, or for an automation that no longer exists. Send
    // them to the store rather than an error page, and record nothing.
    return NextResponse.redirect(fallback, { status: 302 });
  }

  let destination = fallback;
  try {
    const { data: automation } = await supabaseAdmin
      .from("email_automations")
      .select("key, cta_path")
      .eq("key", automationKey)
      .maybeSingle();
    if (!automation) {
      return NextResponse.redirect(fallback, { status: 302 });
    }
    // An operator who cleared the destination to remove the button has left
    // cta_path empty. A link minted before that edit can still be clicked, so
    // it resolves to the catalog rather than to nowhere.
    destination = safeAutomationDestination(automation.cta_path as string | null);
  } catch {
    return NextResponse.redirect(fallback, { status: 302 });
  }

  const clickedAt = new Date();

  // Awaited, not fire-and-forget: a serverless function can be frozen the
  // moment it responds, and an un-awaited insert here would be lost more often
  // than it landed. Same reasoning as the campaign click route.
  try {
    await supabaseAdmin.from("email_automation_clicks").insert({
      automation_key: automationKey,
      reference_id: referenceId,
      email,
      clicked_at: clickedAt.toISOString(),
      user_agent: request.headers.get("user-agent")?.slice(0, 300) ?? null,
      ip_hash: hashIpAddress(
        request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
          ?? request.headers.get("x-real-ip"),
      ),
    });

    // FIRST CLICK ONLY. `clicked_at` on the send-log row answers "did this
    // person ever click this send", which is what a unique-click count is;
    // overwriting it on every click would turn it into "when did they last
    // click" and quietly make unique clicks equal total clicks.
    //
    // The log row is where this lives because automations have no recipient
    // table — there is no queue by design — and email_send_log already holds
    // exactly one row per (campaign_type, reference_id), enforced by the
    // partial unique index in automation-send-once.sql.
    await supabaseAdmin
      .from("email_send_log")
      .update({ clicked_at: clickedAt.toISOString() })
      .eq("campaign_type", `automation:${automationKey}`)
      .eq("reference_id", referenceId)
      .is("clicked_at", null);
  } catch {
    // Metrics are not worth failing a customer's click over.
  }

  const response = NextResponse.redirect(destination, { status: 302 });
  response.cookies.set({
    name: AUTOMATION_COOKIE,
    value: encodeAutomationCookie(automationKey, clickedAt.getTime()),
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: AUTOMATION_COOKIE_MAX_AGE_SECONDS,
  });
  return response;
}
