import { NextResponse } from "next/server";
import { getRequestIpAddress, getRequestUserAgent, verifyAdminSessionFromRequest } from "@/lib/admin-auth";
import { canManageEmailCampaigns } from "@/lib/admin-roles";
import { isAutomationKey } from "@/lib/email/automations";
import { isSafeSitePath } from "@/lib/email/cta-path";
import { getSiteUrl } from "@/lib/env";
import { supabaseAdmin } from "@/lib/supabase-server";

// Edit one retention automation (copy, delay, on/off).
export async function PATCH(request: Request) {
  const session = await verifyAdminSessionFromRequest(request);
  if (!session) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }
  if (!canManageEmailCampaigns(session.role)) {
    return NextResponse.json({ success: false, error: "Your role does not have permission to manage email automations." }, { status: 403 });
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

  const ctaPath = text(body.ctaPath, 300) || "/products";
  if (!isSafeSitePath(ctaPath, getSiteUrl())) {
    return NextResponse.json({ success: false, error: "The button link must be a path on this site, like /products." }, { status: 400 });
  }

  // A delay of zero would mail someone the instant they place an order, which
  // reads as a glitch rather than a follow-up. One day is the floor.
  const delayDays = Math.max(1, Math.min(365, Math.round(Number(body.delayDays ?? 3) || 3)));

  const { error } = await supabaseAdmin
    .from("email_automations")
    .update({
      enabled: Boolean(body.enabled),
      delay_days: delayDays,
      subject,
      headline,
      body: messageBody,
      promo_code: text(body.promoCode, 60) || null,
      cta_label: text(body.ctaLabel, 40) || "SHOP NOW",
      cta_path: ctaPath,
      updated_at: new Date().toISOString(),
    })
    .eq("key", body.key);

  if (error) {
    return NextResponse.json({ success: false, error: error.message }, { status: 400 });
  }

  await supabaseAdmin.from("admin_audit_logs").insert({
    action: "email_automation_updated",
    target_table: "email_automations",
    target_id: String(body.key),
    metadata: {
      enabled: Boolean(body.enabled),
      delayDays,
      performedAt: new Date().toISOString(),
      performedBy: session.username,
      ipAddress: getRequestIpAddress(request),
      userAgent: getRequestUserAgent(request),
    },
  });

  return NextResponse.json({ success: true });
}
