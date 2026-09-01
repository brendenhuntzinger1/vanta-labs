import { NextResponse } from "next/server";
import { verifyAdminSessionFromRequest } from "@/lib/admin-auth";
import { canManageEmailCampaigns } from "@/lib/admin-roles";
import { validateAffiliateCampaignInput } from "@/lib/admin-affiliate-email";
import { buildAffiliateCampaignEmail } from "@/lib/email/affiliate-campaign-template";
import { buildSampleMergeContext } from "@/lib/email/affiliate-merge";
import { getEmailRuntimeConfig } from "@/lib/email/settings";
import { getSiteUrl } from "@/lib/env";

/**
 * Render the composer's current draft exactly as an affiliate will receive it.
 *
 * THE PREVIEW USES THE REAL TEMPLATE, not a lookalike built in the browser. A
 * preview assembled separately from the sender is a preview that can be right
 * while the send is wrong, which is worse than having no preview: it is the
 * thing the owner checked before pressing Send.
 *
 * Personalisation is filled from a clearly-labelled SAMPLE affiliate rather than
 * a real one — a preview showing a real person's rate invites the owner to
 * believe that specific rate has been verified for everyone.
 */
export async function POST(request: Request) {
  const session = await verifyAdminSessionFromRequest(request);
  if (!session) return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  if (!canManageEmailCampaigns(session.role)) {
    return NextResponse.json({ success: false, error: "Forbidden" }, { status: 403 });
  }

  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ success: false, error: "Invalid request" }, { status: 400 });

  const validated = validateAffiliateCampaignInput(body);
  if (!validated.ok) return NextResponse.json({ success: false, error: validated.error }, { status: 400 });
  const value = validated.value;

  const config = await getEmailRuntimeConfig().catch(() => ({ marketingPostalAddress: "" }));
  const siteUrl = getSiteUrl();

  const email = buildAffiliateCampaignEmail({
    subject: value.subject,
    previewText: value.previewText,
    headline: value.headline,
    body: value.body,
    ctaLabel: value.ctaLabel,
    ctaPath: value.ctaPath,
    linkButtons: value.linkButtons,
    mergeContext: buildSampleMergeContext(siteUrl),
    siteUrl,
    postalAddress: String(config.marketingPostalAddress ?? ""),
    // A preview is not a send, so there is no recipient to sign a tracking link
    // for. Each button points at its OWN real destination, which is what makes
    // the preview clickable and honest about where each one goes.
    trackedUrlFor: (linkIndex) => {
      const path = linkIndex === null ? value.ctaPath : (value.linkButtons[linkIndex]?.url ?? value.ctaPath);
      return `${siteUrl}${path.startsWith("/") ? path : `/${path}`}`;
    },
  });

  return NextResponse.json({ success: true, subject: email.subject, html: email.html, text: email.text });
}
