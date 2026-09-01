import { NextResponse } from "next/server";
import { getRequestIpAddress, getRequestUserAgent, verifyAdminSessionFromRequest } from "@/lib/admin-auth";
import { canManageEmailCampaigns } from "@/lib/admin-roles";
import { getAffiliateCampaignDetail, validateAffiliateCampaignInput } from "@/lib/admin-affiliate-email";
import { supabaseAdmin } from "@/lib/supabase-server";

async function guard(request: Request) {
  const session = await verifyAdminSessionFromRequest(request);
  if (!session) return { error: NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 }) };
  if (!canManageEmailCampaigns(session.role)) {
    return { error: NextResponse.json({ success: false, error: "Your role does not have permission to manage email campaigns." }, { status: 403 }) };
  }
  return { session };
}

/** Open an old campaign and see exactly what was sent. */
export async function GET(request: Request, context: { params: Promise<{ campaignId: string }> }) {
  const { error } = await guard(request);
  if (error) return error;
  const { campaignId } = await context.params;

  const detail = await getAffiliateCampaignDetail(campaignId);
  if (!detail) return NextResponse.json({ success: false, error: "Campaign not found" }, { status: 404 });
  return NextResponse.json({ success: true, campaign: detail });
}

/**
 * Edit a draft.
 *
 * A campaign that has already started sending is NOT editable: half its
 * audience would have received the old copy and half the new, and there is no
 * honest way to report that as one campaign. Same rule the customer composer
 * enforces.
 */
export async function PATCH(request: Request, context: { params: Promise<{ campaignId: string }> }) {
  const { session, error } = await guard(request);
  if (error) return error;
  const { campaignId } = await context.params;

  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ success: false, error: "Invalid request" }, { status: 400 });

  const validated = validateAffiliateCampaignInput(body);
  if (!validated.ok) return NextResponse.json({ success: false, error: validated.error }, { status: 400 });
  const value = validated.value;

  const { data: existing } = await supabaseAdmin
    .from("email_campaigns")
    .select("status, audience_kind")
    .eq("id", campaignId)
    .maybeSingle();
  if (!existing) return NextResponse.json({ success: false, error: "Campaign not found" }, { status: 404 });
  if (String(existing.audience_kind ?? "") !== "affiliate") {
    return NextResponse.json({ success: false, error: "That is not an affiliate campaign." }, { status: 400 });
  }
  if (!["draft", "scheduled", "paused"].includes(String(existing.status))) {
    return NextResponse.json({ success: false, error: "This campaign has already been sent and can no longer be edited." }, { status: 409 });
  }

  const { error: updateError } = await supabaseAdmin
    .from("email_campaigns")
    .update({
      name: value.name,
      subject: value.subject,
      preview_text: value.previewText,
      headline: value.headline,
      body: value.body,
      cta_label: value.ctaLabel,
      cta_path: value.ctaPath,
      link_buttons: value.linkButtons,
      affiliate_filter: value.affiliateFilter,
      affiliate_ids: value.affiliateIds,
      updated_at: new Date().toISOString(),
    })
    .eq("id", campaignId);

  if (updateError) return NextResponse.json({ success: false, error: updateError.message }, { status: 400 });

  await supabaseAdmin.from("admin_audit_logs").insert({
    action: "affiliate_campaign_updated",
    target_table: "email_campaigns",
    target_id: campaignId,
    metadata: {
      performedAt: new Date().toISOString(),
      performedBy: session?.username,
      ipAddress: getRequestIpAddress(request),
      userAgent: getRequestUserAgent(request),
    },
  });

  return NextResponse.json({ success: true });
}

/**
 * Duplicate a campaign into a fresh draft.
 *
 * Copies the CONTENT and the audience choice, never the send state: the copy
 * starts as a draft with no recipients, no schedule and no history, so
 * duplicating something that has already gone out cannot re-send it.
 */
export async function POST(request: Request, context: { params: Promise<{ campaignId: string }> }) {
  const { session, error } = await guard(request);
  if (error) return error;
  const { campaignId } = await context.params;

  const { data: source } = await supabaseAdmin
    .from("email_campaigns")
    .select("name, subject, preview_text, headline, body, cta_label, cta_path, link_buttons, affiliate_filter, affiliate_ids, audience_kind")
    .eq("id", campaignId)
    .maybeSingle();
  if (!source || String(source.audience_kind ?? "") !== "affiliate") {
    return NextResponse.json({ success: false, error: "Campaign not found" }, { status: 404 });
  }

  const { data, error: insertError } = await supabaseAdmin
    .from("email_campaigns")
    .insert({
      name: `${String(source.name ?? "Campaign")} (copy)`.slice(0, 120),
      subject: source.subject,
      preview_text: source.preview_text,
      headline: source.headline,
      body: source.body,
      cta_label: source.cta_label,
      cta_path: source.cta_path,
      link_buttons: source.link_buttons,
      audience_kind: "affiliate",
      affiliate_filter: source.affiliate_filter,
      affiliate_ids: source.affiliate_ids,
      segment: "all",
      status: "draft",
      created_by: session?.username,
    })
    .select("id")
    .single();

  if (insertError) return NextResponse.json({ success: false, error: insertError.message }, { status: 400 });
  return NextResponse.json({ success: true, campaignId: String(data.id) });
}
