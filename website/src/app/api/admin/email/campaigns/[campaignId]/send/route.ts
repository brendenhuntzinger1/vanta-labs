import { NextResponse } from "next/server";
import { getRequestIpAddress, getRequestUserAgent, verifyAdminSessionFromRequest } from "@/lib/admin-auth";
import { canManageEmailCampaigns } from "@/lib/admin-roles";
import { queueCampaign, sendCampaignBatch } from "@/lib/email/campaign-sender";
import { campaignTemplate } from "@/lib/email/templates";
import { sendEmail } from "@/lib/email/send";
import { getEmailRuntimeConfig, marketingBlockedReason, resolveMarketingFrom } from "@/lib/email/settings";
import { extractEmailAddress, isMarketingSuppressed } from "@/lib/email/marketing";
import { generateUnsubscribeToken } from "@/lib/email/unsubscribe";
import { getSiteUrl } from "@/lib/env";
import { safeCampaignDestination } from "@/lib/email/campaign-links";
import { supabaseAdmin } from "@/lib/supabase-server";

/**
 * Send, schedule, or test a campaign.
 *
 * "Send now" queues the audience and then runs ONE batch inline, so the admin
 * sees the send actually start instead of pressing a button and waiting up to
 * half an hour for the next cron tick to prove it worked. The remainder is
 * picked up by the sweep — this route never tries to send the whole list inside
 * one request.
 */
export async function POST(request: Request, context: { params: Promise<{ campaignId: string }> }) {
  const session = await verifyAdminSessionFromRequest(request);
  if (!session) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }
  if (!canManageEmailCampaigns(session.role)) {
    return NextResponse.json({ success: false, error: "Your role does not have permission to send email campaigns." }, { status: 403 });
  }

  const { campaignId } = await context.params;
  const body = await request.json().catch(() => null) as { mode?: string; scheduledAt?: string; testEmail?: string } | null;
  const mode = body?.mode ?? "now";

  const config = await getEmailRuntimeConfig();
  const blocked = marketingBlockedReason(config);
  if (blocked) {
    // Say exactly what is missing. "Something went wrong" on a send button is
    // the least useful message in an admin panel.
    return NextResponse.json({ success: false, error: blocked }, { status: 400 });
  }

  const { data: campaign } = await supabaseAdmin
    .from("email_campaigns")
    .select("id, name, subject, preview_text, headline, body, promo_code, cta_label, cta_path, status")
    .eq("id", campaignId)
    .maybeSingle();
  if (!campaign) {
    return NextResponse.json({ success: false, error: "Campaign not found" }, { status: 404 });
  }

  // --- Test send ----------------------------------------------------------
  // Goes through sendEmail, NOT sendMarketingEmail, so a test is not logged as
  // a campaign send and does not count in the campaign's metrics. That part was
  // right. Two things that came with it were not.
  //
  // THE ADDRESS WAS NEVER THE OPERATOR'S. The comment here used to justify the
  // bypass as "a test to the operator's own address", but nothing checked that:
  // `testEmail` is whatever the request body says, validated only for an "@".
  // So the one path that skips the suppression list could deliver a full
  // marketing campaign to a real customer — including one who had unsubscribed
  // or hit "report spam" — carrying no List-Unsubscribe header, because those
  // are set in the marketing wrapper this deliberately avoids. A "[TEST]"
  // subject prefix was the only thing marking it.
  //
  // Both halves are closed here rather than by routing through
  // sendMarketingEmail, which would reintroduce the logging and metrics this is
  // specifically meant to stay out of:
  //   * a suppressed address is refused outright. An operator whose own address
  //     is suppressed sees why and can test to another — strictly better than
  //     silently mailing someone who asked us to stop;
  //   * the one-click unsubscribe headers are attached unconditionally, so any
  //     recipient of a promotional message has a working opt-out even on a
  //     path that never consults an audience.
  if (mode === "test") {
    const testEmail = String(body?.testEmail ?? "").trim().toLowerCase();
    if (!testEmail || !testEmail.includes("@")) {
      return NextResponse.json({ success: false, error: "Enter a valid test address." }, { status: 400 });
    }

    if (await isMarketingSuppressed(testEmail)) {
      return NextResponse.json(
        { success: false, error: "That address has unsubscribed or bounced, so it cannot receive a campaign — even a test. Use a different address." },
        { status: 400 },
      );
    }

    const template = campaignTemplate({
      subject: `[TEST] ${campaign.subject}`,
      previewText: campaign.preview_text as string | null,
      headline: String(campaign.headline),
      body: String(campaign.body),
      promoCode: campaign.promo_code as string | null,
      ctaLabel: String(campaign.cta_label),
      // A test can't carry a per-recipient tracking link, so it points straight
      // at the real destination. The button therefore behaves as it will for a
      // customer, minus the click being recorded.
      ctaUrl: safeCampaignDestination(campaign.cta_path as string),
      postalAddress: config.marketingPostalAddress,
    });

    // The same headers sendMarketingEmail sets, built from the same HMAC token,
    // so the opt-out in a test behaves exactly as it will in the real send.
    const unsubscribeUrl = `${getSiteUrl()}/api/unsubscribe?email=${encodeURIComponent(testEmail)}&token=${generateUnsubscribeToken(testEmail)}`;
    const unsubscribeMailbox = extractEmailAddress(resolveMarketingFrom(config));
    const result = await sendEmail({
      to: testEmail,
      ...template,
      from: resolveMarketingFrom(config),
      headers: {
        "List-Unsubscribe": `<${unsubscribeUrl}>${unsubscribeMailbox ? `, <mailto:${unsubscribeMailbox}?subject=unsubscribe>` : ""}`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
    });
    return NextResponse.json({ success: result.success, error: result.error });
  }

  // --- Schedule -----------------------------------------------------------
  if (mode === "schedule") {
    const when = new Date(String(body?.scheduledAt ?? ""));
    if (!Number.isFinite(when.getTime())) {
      return NextResponse.json({ success: false, error: "Enter a valid date and time." }, { status: 400 });
    }
    if (when.getTime() <= Date.now()) {
      return NextResponse.json({ success: false, error: "Pick a time in the future." }, { status: 400 });
    }
    if (!["draft", "scheduled", "paused"].includes(String(campaign.status))) {
      return NextResponse.json({ success: false, error: "This campaign has already been sent." }, { status: 409 });
    }

    const { error } = await supabaseAdmin
      .from("email_campaigns")
      .update({ status: "scheduled", scheduled_at: when.toISOString(), updated_at: new Date().toISOString() })
      .eq("id", campaignId);
    if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 });

    await supabaseAdmin.from("admin_audit_logs").insert({
      action: "email_campaign_scheduled",
      target_table: "email_campaigns",
      target_id: campaignId,
      metadata: {
        scheduledAt: when.toISOString(),
        performedAt: new Date().toISOString(),
        performedBy: session.username,
        ipAddress: getRequestIpAddress(request),
        userAgent: getRequestUserAgent(request),
      },
    });

    // The sweep runs every 30 minutes, so a scheduled time is honoured to
    // within that window, not to the minute. Said plainly rather than implied.
    return NextResponse.json({ success: true, scheduledAt: when.toISOString(), granularityMinutes: 30 });
  }

  // --- Send now -----------------------------------------------------------
  if (!["draft", "scheduled", "paused"].includes(String(campaign.status))) {
    return NextResponse.json({ success: false, error: "This campaign is already sending or sent." }, { status: 409 });
  }

  try {
    const queued = await queueCampaign(campaignId);

    await supabaseAdmin.from("admin_audit_logs").insert({
      action: "email_campaign_sent",
      target_table: "email_campaigns",
      target_id: campaignId,
      metadata: {
        recipients: queued.queued,
        performedAt: new Date().toISOString(),
        performedBy: session.username,
        ipAddress: getRequestIpAddress(request),
        userAgent: getRequestUserAgent(request),
      },
    });

    if (queued.queued === 0 && queued.alreadyQueued === 0) {
      return NextResponse.json({
        success: true,
        recipients: 0,
        sent: 0,
        remaining: 0,
        note: "Nobody currently matches this audience, so nothing was sent.",
      });
    }

    // One batch inline for immediate feedback; the sweep finishes the rest.
    const batch = await sendCampaignBatch({ campaignId, budgetMs: 8000 });

    return NextResponse.json({
      success: true,
      recipients: queued.queued,
      sent: batch.sent,
      failed: batch.failed,
      remaining: batch.remaining,
      finished: batch.finished,
    });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Unable to send this campaign" },
      { status: 400 },
    );
  }
}
