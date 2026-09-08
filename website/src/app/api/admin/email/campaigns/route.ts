import { NextResponse } from "next/server";
import { getRequestIpAddress, getRequestUserAgent, verifyAdminSessionFromRequest } from "@/lib/admin-auth";
import { canManageEmailCampaigns } from "@/lib/admin-roles";
import { validateCampaignInput } from "@/lib/admin-email";
import { isCampaignSegment, resolveAudience, type CampaignSegment } from "@/lib/email/audience";
import { supabaseAdmin } from "@/lib/supabase-server";
import { resolveCampaignGift } from "@/lib/offers/campaign-gift-server";

// Create a campaign (always as a draft — composing and sending are separate
// actions, so a mistyped subject line can't reach the whole list on one click).
export async function POST(request: Request) {
  const session = await verifyAdminSessionFromRequest(request);
  if (!session) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }
  if (!canManageEmailCampaigns(session.role)) {
    return NextResponse.json({ success: false, error: "Your role does not have permission to manage email campaigns." }, { status: 403 });
  }

  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) {
    return NextResponse.json({ success: false, error: "Invalid request" }, { status: 400 });
  }

  const validated = validateCampaignInput(body);
  if (!validated.ok) {
    return NextResponse.json({ success: false, error: validated.error }, { status: 400 });
  }
  const value = validated.value;

  if (!isCampaignSegment(value.segment)) {
    return NextResponse.json({ success: false, error: "Unknown audience segment." }, { status: 400 });
  }

  // THE GIFT'S PRODUCT MUST BE ON SALE, and the operator finds out now rather
  // than from a support ticket. quoteOrder resolves the product half of a gift
  // with an exact slug match and no fallback, so a gift naming a product that
  // is not live does not throw — the free line is simply never added, the
  // percentage half still applies, and the customer gets the discount the email
  // promised and none of the product it promised.
  //
  // The sender checks again at mint time, because a product can be retired
  // between saving a campaign and sending it. This one is the fast feedback;
  // that one is the guarantee.
  const giftCheck = await resolveCampaignGift({ offer_key: value.offerKey, offer_custom: value.offerCustom });
  if (giftCheck.error) {
    return NextResponse.json({ success: false, error: giftCheck.error }, { status: 400 });
  }

  const { data, error } = await supabaseAdmin
    .from("email_campaigns")
    .insert({
      name: value.name,
      subject: value.subject,
      preview_text: value.previewText,
      headline: value.headline,
      body: value.body,
      promo_code: value.promoCode,
      cta_label: value.ctaLabel,
      cta_path: value.ctaPath,
      segment: value.segment,
      segment_param: value.segmentParam,
      offer_key: value.offerKey,
      offer_custom: value.offerCustom,
      status: "draft",
      created_by: session.username,
    })
    .select("id")
    .single();

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 400 });
  }

  await supabaseAdmin.from("admin_audit_logs").insert({
    action: "email_campaign_created",
    target_table: "email_campaigns",
    target_id: String(data.id),
    metadata: {
      name: value.name,
      segment: value.segment,
      performedAt: new Date().toISOString(),
      performedBy: session.username,
      ipAddress: getRequestIpAddress(request),
      userAgent: getRequestUserAgent(request),
    },
  });

  return NextResponse.json({ success: true, campaignId: String(data.id) });
}

// Audience size preview. Read-only, and deliberately available before a
// campaign exists so the operator can see who a segment reaches while they are
// still choosing one.
export async function GET(request: Request) {
  const session = await verifyAdminSessionFromRequest(request);
  if (!session) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }
  if (!canManageEmailCampaigns(session.role)) {
    return NextResponse.json({ success: false, error: "Forbidden" }, { status: 403 });
  }

  const url = new URL(request.url);
  const segment = url.searchParams.get("segment") ?? "all";
  const segmentParam = url.searchParams.get("segmentParam");

  if (!isCampaignSegment(segment)) {
    return NextResponse.json({ success: false, error: "Unknown audience segment." }, { status: 400 });
  }

  try {
    const emails = await resolveAudience({ segment: segment as CampaignSegment, segmentParam });
    // The COUNT only. The admin needs to know how many people a send reaches,
    // not to be handed the customer list through an API response.
    return NextResponse.json({ success: true, count: emails.length });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Unable to size this audience" },
      { status: 400 },
    );
  }
}
