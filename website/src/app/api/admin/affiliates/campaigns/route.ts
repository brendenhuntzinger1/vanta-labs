import { NextResponse } from "next/server";
import { getRequestIpAddress, getRequestUserAgent, verifyAdminSessionFromRequest } from "@/lib/admin-auth";
import { canManageEmailCampaigns } from "@/lib/admin-roles";
import { validateAffiliateCampaignInput } from "@/lib/admin-affiliate-email";
import { isAffiliateFilter, resolveAffiliateAudience, type AffiliateFilter } from "@/lib/email/affiliate-audience";
import { supabaseAdmin } from "@/lib/supabase-server";

/**
 * Create an affiliate campaign — ALWAYS as a draft.
 *
 * Composing and sending are separate actions, deliberately: a mistyped subject
 * line cannot reach the whole affiliate programme on one click. This mirrors the
 * customer composer exactly.
 */
export async function POST(request: Request) {
  const session = await verifyAdminSessionFromRequest(request);
  if (!session) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }
  if (!canManageEmailCampaigns(session.role)) {
    return NextResponse.json({ success: false, error: "Your role does not have permission to manage email campaigns." }, { status: 403 });
  }

  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ success: false, error: "Invalid request" }, { status: 400 });

  const validated = validateAffiliateCampaignInput(body);
  if (!validated.ok) return NextResponse.json({ success: false, error: validated.error }, { status: 400 });
  const value = validated.value;

  const { data, error } = await supabaseAdmin
    .from("email_campaigns")
    .insert({
      name: value.name,
      subject: value.subject,
      preview_text: value.previewText,
      headline: value.headline,
      body: value.body,
      cta_label: value.ctaLabel,
      cta_path: value.ctaPath,
      link_buttons: value.linkButtons,
      audience_kind: "affiliate",
      affiliate_filter: value.affiliateFilter,
      affiliate_ids: value.affiliateIds,
      // Affiliate campaigns do not use customer segments. 'all' is stored so the
      // NOT NULL default is satisfied; nothing reads it for this audience kind.
      segment: "all",
      status: "draft",
      created_by: session.username,
    })
    .select("id")
    .single();

  if (error) return NextResponse.json({ success: false, error: error.message }, { status: 400 });

  await supabaseAdmin.from("admin_audit_logs").insert({
    action: "affiliate_campaign_created",
    target_table: "email_campaigns",
    target_id: String(data.id),
    metadata: {
      name: value.name,
      audience: value.affiliateFilter,
      performedAt: new Date().toISOString(),
      performedBy: session.username,
      ipAddress: getRequestIpAddress(request),
      userAgent: getRequestUserAgent(request),
    },
  });

  return NextResponse.json({ success: true, campaignId: String(data.id) });
}

/**
 * Audience size preview: "This email will be sent to X affiliates."
 *
 * Read-only and available before a campaign exists, so the owner can see who an
 * audience reaches while still choosing one. Returns the COUNT only — the admin
 * needs to know how many people a send reaches, not to be handed the affiliate
 * list through an API response.
 */
export async function GET(request: Request) {
  const session = await verifyAdminSessionFromRequest(request);
  if (!session) return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  if (!canManageEmailCampaigns(session.role)) {
    return NextResponse.json({ success: false, error: "Forbidden" }, { status: 403 });
  }

  const url = new URL(request.url);
  const filter = url.searchParams.get("filter") ?? "all_active";
  const ids = (url.searchParams.get("ids") ?? "").split(",").map((id) => id.trim()).filter(Boolean);

  if (!isAffiliateFilter(filter)) {
    return NextResponse.json({ success: false, error: "Unknown affiliate audience." }, { status: 400 });
  }

  try {
    const recipients = await resolveAffiliateAudience({ filter: filter as AffiliateFilter, ambassadorIds: ids });
    return NextResponse.json({ success: true, count: recipients.length });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Unable to size this audience" },
      { status: 400 },
    );
  }
}
