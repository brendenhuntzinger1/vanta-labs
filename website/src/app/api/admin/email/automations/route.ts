import { NextResponse } from "next/server";
import { getRequestIpAddress, getRequestUserAgent, verifyAdminSessionFromRequest } from "@/lib/admin-auth";
import { canManageEmailCampaigns } from "@/lib/admin-roles";
import { isAutomationKey } from "@/lib/email/automations";
import { normalizeSitePathInput } from "@/lib/email/cta-path";
import { ctaPathReachesStore } from "@/lib/email/link-grant";
import { findCopyComplianceIssueIn } from "@/lib/email/copy-compliance";
import { isOfferKey } from "@/lib/offers/customer-offers";
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

  // THE CTA IS THE OPERATOR'S TO SET, INCLUDING TO NOTHING.
  //
  // Both fields used to fall back to a hard-coded default — `|| "SHOP NOW"` and
  // `|| "/products"` — which meant clearing the button text in the admin saved
  // "SHOP NOW" instead. The box looked empty, the database said otherwise, and
  // the two only reconciled on a page reload. An operator cannot own their
  // button copy while the server silently overrules it, so blank now round-trips
  // as blank and removes the button (see renderCtaButton).
  //
  // The 40-character cap stays: a label longer than that wraps inside the pill
  // on a phone, which is a broken-looking button rather than a long one.
  const ctaLabel = text(body.ctaLabel, 40);
  // Accepts either "/products" or the full same-origin URL an operator gets by
  // copying the address bar, and stores the path either way. Off-site is still
  // refused — see normalizeSitePathInput.
  const ctaPath = normalizeSitePathInput(text(body.ctaPath, 300), getSiteUrl());
  if (ctaPath === null) {
    return NextResponse.json(
      { success: false, error: "The button link must point at this site — a path like /products, or its full https:// address." },
      { status: 400 },
    );
  }
  // THE BRAND'S OWN COPY RULES, CHECKED WHERE THEY CAN STOP SOMETHING.
  //
  // brand.md and compliance.md both state "no emojis, no exclamation marks"
  // absolutely, and nothing checked either — so this automation shipped for
  // weeks with the headline "RESEARCH. TESTED. TRANSPARENT 🧪" to 54
  // recipients, at the worst open rate of any message the store sends. An
  // emoji in a subject line is a spam signal as well as off-voice.
  const copyIssue = findCopyComplianceIssueIn([
    { label: "Subject", value: subject },
    { label: "Headline", value: headline },
    { label: "Message", value: messageBody },
    { label: "Button text", value: String(body.ctaLabel ?? "") },
  ]);
  if (copyIssue) {
    return NextResponse.json({ success: false, error: copyIssue }, { status: 400 });
  }

  // A DESTINATION THE RECIPIENT CANNOT REACH IS NOT A DESTINATION.
  //
  // This store is account-only by default, and an email grant opens the
  // catalogue and the checkout — deliberately NOT order history or any other
  // account surface, because a forwarded email would then hand a stranger
  // somebody's addresses and order totals.
  //
  // So a stored cta_path outside that set sends the recipient to a sign-in
  // page. It is not hypothetical: `post_purchase` and `replenishment` both
  // pointed at /account/orders, and `replenishment` carried a real paid
  // incentive (free shipping + 10%) into that dead end. Between them they
  // produced 0 clicks on 75 sends, and nothing anywhere said why.
  //
  // ctaPathReachesStore already answered this question and was wired to
  // nothing on the write path — the check existed, the save ignored it. It is
  // a refusal rather than a warning because the failure it prevents is
  // invisible from the admin: the message sends, the click is recorded, and
  // only the conversion is missing.
  if (ctaPath && !ctaPathReachesStore(ctaPath)) {
    return NextResponse.json(
      {
        success: false,
        error:
          `Recipients cannot reach ${ctaPath} from an email — the store needs an account and that page is not one an `
          + "email link can open, so they would land on the sign-in page instead. Point the button at the home page, "
          + "/products, /research, a product page, or /cart.",
      },
      { status: 400 },
    );
  }
  // Half a button is not a button. Saying so here beats rendering a labelled
  // pill that goes nowhere, or an unlabelled one that goes somewhere.
  if (Boolean(ctaLabel) !== Boolean(ctaPath)) {
    return NextResponse.json(
      { success: false, error: "Set both the button text and its destination, or clear both to send this automation with no button." },
      { status: 400 },
    );
  }

  // WHICH ONE-TIME GIFT THIS SEQUENCE CARRIES, if any.
  //
  // Blank is the normal answer and means no gift. An unrecognised value is
  // refused rather than stored: a typo here would silently mail a win-back with
  // no offer attached, and the operator would have no way to tell from the
  // admin that nothing was minted.
  const rawOfferKey = text(body.offerKey, 60);
  if (rawOfferKey && !isOfferKey(rawOfferKey)) {
    return NextResponse.json({ success: false, error: "That gift offer is not one this store knows how to grant." }, { status: 400 });
  }
  const offerKey = rawOfferKey || null;

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
      cta_label: ctaLabel,
      cta_path: ctaPath,
      offer_key: offerKey,
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
      // The CTA is now operator-editable, so it is operator-auditable. Without
      // this, "who changed the button on the win-back and when" had no answer.
      ctaLabel,
      ctaPath,
      // Attaching a gift to a sequence spends real product. It is the single
      // most consequential thing on this form, so it is the one most worth
      // being able to answer "who turned that on, and when" about.
      offerKey,
      performedAt: new Date().toISOString(),
      performedBy: session.username,
      ipAddress: getRequestIpAddress(request),
      userAgent: getRequestUserAgent(request),
    },
  });

  // The saved row goes back so the client can replace its local draft with what
  // was actually stored, rather than keeping the values it optimistically holds.
  // This is what makes a cleared CTA visibly stay cleared instead of diverging
  // from the database until the next page load.
  const { data: saved } = await supabaseAdmin
    .from("email_automations")
    .select("key, enabled, delay_days, subject, headline, body, promo_code, cta_label, cta_path, offer_key, updated_at")
    .eq("key", body.key)
    .maybeSingle();

  return NextResponse.json({ success: true, automation: saved ?? null });
}
