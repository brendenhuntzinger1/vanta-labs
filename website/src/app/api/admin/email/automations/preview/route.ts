import { NextResponse } from "next/server";
import { verifyAdminSessionFromRequest } from "@/lib/admin-auth";
import { canManageEmailCampaigns } from "@/lib/admin-roles";
import { isAutomationKey } from "@/lib/email/automations";
import { campaignTemplate } from "@/lib/email/templates";
import { normalizeSitePathInput } from "@/lib/email/cta-path";
import { getEmailRuntimeConfig } from "@/lib/email/settings";
import { getSiteUrl } from "@/lib/env";

/**
 * Render an automation exactly as a customer will receive it.
 *
 * THE PREVIEW USES THE REAL TEMPLATE, not a lookalike assembled in the browser.
 * A preview built separately from the sender can be right while the send is
 * wrong, which is worse than having no preview at all — it is the thing the
 * operator checked before turning the automation on. Same rule the affiliate
 * composer's preview follows, and the same function `runAutomationSweep` calls.
 *
 * IT PREVIEWS THE DRAFT IN THE BROWSER, NOT THE SAVED ROW. An operator edits
 * the button text, previews, then saves; previewing the stored row would show
 * them the copy they are replacing. The key is still required and validated, so
 * this cannot be used to render arbitrary mail — but every visible string comes
 * from the request.
 *
 * WHY THERE IS NO "SEND TEST" HERE. Automations dedupe on email_send_log via
 * the partial unique index in automation-send-once.sql, so a test send would
 * consume that address's send-once slot and permanently prevent the real
 * message reaching them. A preview cannot do that because it sends nothing.
 */
export async function POST(request: Request) {
  const session = await verifyAdminSessionFromRequest(request);
  if (!session) return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  if (!canManageEmailCampaigns(session.role)) {
    return NextResponse.json({ success: false, error: "Forbidden" }, { status: 403 });
  }

  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!body || !isAutomationKey(body.key)) {
    return NextResponse.json({ success: false, error: "Unknown automation." }, { status: 400 });
  }

  const text = (value: unknown, max: number) => String(value ?? "").trim().slice(0, max);
  const subject = text(body.subject, 200);
  const headline = text(body.headline, 200);
  const messageBody = text(body.body, 8000);
  if (!subject || !headline || !messageBody) {
    return NextResponse.json({ success: false, error: "Subject, headline and message are all required." }, { status: 400 });
  }

  const ctaLabel = text(body.ctaLabel, 40);
  const ctaPath = normalizeSitePathInput(text(body.ctaPath, 300), getSiteUrl());
  if (ctaPath === null) {
    return NextResponse.json(
      { success: false, error: "The button link must point at this site — a path like /products, or its full https:// address." },
      { status: 400 },
    );
  }

  const config = await getEmailRuntimeConfig().catch(() => ({ marketingPostalAddress: "" }));
  const site = getSiteUrl().replace(/\/$/, "");

  const email = campaignTemplate({
    subject,
    previewText: headline,
    headline,
    body: messageBody,
    promoCode: text(body.promoCode, 60) || null,
    // Blank stays blank. This is the whole point of previewing a cleared CTA:
    // the operator sees the message render with no button, which is what a
    // recipient will get.
    ctaLabel,
    // A preview has no recipient, so there is no tracking link to sign. The
    // button points at its OWN real destination instead, which makes the
    // preview clickable and honest about where it goes — the same choice the
    // affiliate preview makes for the same reason.
    ctaUrl: ctaLabel && ctaPath ? `${site}${ctaPath}` : "",
    postalAddress: String(config.marketingPostalAddress ?? ""),
  });

  return NextResponse.json({ success: true, subject: email.subject, html: email.html, text: email.text });
}
