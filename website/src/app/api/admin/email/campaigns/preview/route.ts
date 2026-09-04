import { NextResponse } from "next/server";
import { verifyAdminSessionFromRequest } from "@/lib/admin-auth";
import { canManageEmailCampaigns } from "@/lib/admin-roles";
import { campaignTemplate } from "@/lib/email/templates";
import { normalizeSitePathInput, resolveSitePath } from "@/lib/email/cta-path";
import { getEmailRuntimeConfig } from "@/lib/email/settings";
import { getSiteUrl } from "@/lib/env";

/**
 * Render a customer campaign exactly as a recipient will see it.
 *
 * Same rule as the automation preview: the REAL template, driven by the draft
 * in the composer rather than the saved row, and no send. A preview that used a
 * lookalike could be right while the send was wrong, which is worse than no
 * preview — it is the thing the operator checked before pressing Send.
 *
 * The button points at the real destination rather than a tracking link (a
 * preview has no recipient to attribute a click to), and the CAN-SPAM postal
 * address renders from the same setting the sender will use, so a blank one is
 * visible here before it blocks the send.
 */
export async function POST(request: Request) {
  const session = await verifyAdminSessionFromRequest(request);
  if (!session) return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  if (!canManageEmailCampaigns(session.role)) {
    return NextResponse.json({ success: false, error: "Forbidden" }, { status: 403 });
  }

  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ success: false, error: "Nothing to preview." }, { status: 400 });

  const text = (value: unknown, max: number) => String(value ?? "").trim().slice(0, max);
  const subject = text(body.subject, 200) || "(no subject yet)";
  const headline = text(body.headline, 200) || "(no headline yet)";
  const messageBody = text(body.body, 8000) || "(no message yet)";
  const ctaLabel = text(body.ctaLabel, 40);
  const ctaPath = normalizeSitePathInput(text(body.ctaPath, 300) || "/products", getSiteUrl()) ?? "/products";

  const config = await getEmailRuntimeConfig().catch(() => ({ marketingPostalAddress: "" }));
  const template = campaignTemplate({
    subject,
    previewText: text(body.previewText, 200) || null,
    headline,
    body: messageBody,
    promoCode: text(body.promoCode, 60) || null,
    ctaLabel,
    ctaUrl: ctaLabel ? resolveSitePath(ctaPath, getSiteUrl()) : "",
    postalAddress: config.marketingPostalAddress || "(postal address not set — add it in Settings before sending)",
  });

  return NextResponse.json({ success: true, subject: template.subject, html: template.html, text: template.text });
}
