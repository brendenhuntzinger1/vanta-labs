import { NextResponse } from "next/server";
import { getRequestIpAddress, getRequestUserAgent, verifyAdminSessionFromRequest } from "@/lib/admin-auth";
import { canManageEmailCampaigns } from "@/lib/admin-roles";
import { validateCampaignInput } from "@/lib/admin-email";
import { isCampaignSegment } from "@/lib/email/audience";
import { supabaseAdmin } from "@/lib/supabase-server";

async function guard(request: Request) {
  const session = await verifyAdminSessionFromRequest(request);
  if (!session) return { error: NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 }) };
  if (!canManageEmailCampaigns(session.role)) {
    return { error: NextResponse.json({ success: false, error: "Your role does not have permission to manage email campaigns." }, { status: 403 }) };
  }
  return { session };
}

// The full row, for "Duplicate" in the composer. The history table carries
// only a summary; a duplicate that dropped the headline, message and button
// was not a duplicate.
export async function GET(request: Request, context: { params: Promise<{ campaignId: string }> }) {
  const guarded = await guard(request);
  if ("error" in guarded) return guarded.error;
  const { campaignId } = await context.params;
  const { data, error } = await supabaseAdmin
    .from("email_campaigns")
    .select("id, name, subject, preview_text, headline, body, promo_code, cta_label, cta_path, segment, segment_param, status, scheduled_at, audience_kind")
    .eq("id", campaignId)
    .maybeSingle();
  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 });
  if (!data) return NextResponse.json({ success: false, error: "Campaign not found" }, { status: 404 });
  return NextResponse.json({ success: true, campaign: data });
}

// Edit a draft. A campaign that has already started sending is NOT editable:
// half its audience would have received the old copy and half the new, and
// there is no honest way to report that as one campaign.
export async function PATCH(request: Request, context: { params: Promise<{ campaignId: string }> }) {
  const { session, error } = await guard(request);
  if (error) return error;
  const { campaignId } = await context.params;

  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ success: false, error: "Invalid request" }, { status: 400 });

  const validated = validateCampaignInput(body);
  if (!validated.ok) return NextResponse.json({ success: false, error: validated.error }, { status: 400 });
  const value = validated.value;
  if (!isCampaignSegment(value.segment)) {
    return NextResponse.json({ success: false, error: "Unknown audience segment." }, { status: 400 });
  }

  const { data: existing } = await supabaseAdmin
    .from("email_campaigns")
    .select("status")
    .eq("id", campaignId)
    .maybeSingle();
  if (!existing) return NextResponse.json({ success: false, error: "Campaign not found" }, { status: 404 });
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
      promo_code: value.promoCode,
      cta_label: value.ctaLabel,
      cta_path: value.ctaPath,
      segment: value.segment,
      segment_param: value.segmentParam,
      updated_at: new Date().toISOString(),
    })
    .eq("id", campaignId);

  if (updateError) return NextResponse.json({ success: false, error: updateError.message }, { status: 400 });

  await supabaseAdmin.from("admin_audit_logs").insert({
    action: "email_campaign_updated",
    target_table: "email_campaigns",
    target_id: campaignId,
    metadata: {
      performedAt: new Date().toISOString(),
      performedBy: session!.username,
      ipAddress: getRequestIpAddress(request),
      userAgent: getRequestUserAgent(request),
    },
  });

  return NextResponse.json({ success: true });
}

// Delete a draft. Anything that has sent is kept: the campaign row is what its
// history line and its attributed revenue point at, so removing it would
// silently orphan real orders.
export async function DELETE(request: Request, context: { params: Promise<{ campaignId: string }> }) {
  const { session, error } = await guard(request);
  if (error) return error;
  const { campaignId } = await context.params;

  const { data: existing } = await supabaseAdmin
    .from("email_campaigns")
    .select("status")
    .eq("id", campaignId)
    .maybeSingle();
  if (!existing) return NextResponse.json({ success: false, error: "Campaign not found" }, { status: 404 });
  if (!["draft", "scheduled"].includes(String(existing.status))) {
    return NextResponse.json({ success: false, error: "Only drafts and scheduled campaigns can be deleted." }, { status: 409 });
  }

  const { error: deleteError } = await supabaseAdmin.from("email_campaigns").delete().eq("id", campaignId);
  if (deleteError) return NextResponse.json({ success: false, error: deleteError.message }, { status: 400 });

  await supabaseAdmin.from("admin_audit_logs").insert({
    action: "email_campaign_deleted",
    target_table: "email_campaigns",
    target_id: campaignId,
    metadata: {
      performedAt: new Date().toISOString(),
      performedBy: session!.username,
      ipAddress: getRequestIpAddress(request),
      userAgent: getRequestUserAgent(request),
    },
  });

  return NextResponse.json({ success: true });
}
