import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-server";
import { verifyAutomationLink } from "@/lib/email/automation-links";
import { isAutomationKey } from "@/lib/email/automations";

export const dynamic = "force-dynamic";

// 1x1 transparent GIF.
const PIXEL = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");

/**
 * Open-tracking pixel for the retention automations.
 *
 * The same caveat as the campaign pixel applies and is worth repeating before
 * anyone optimises against this number: Apple Mail Privacy Protection
 * pre-fetches images for a large share of recipients whether or not the message
 * was read, and other clients block images entirely. Opens are inflated at the
 * top and missing at the bottom, and the rate is not comparable between
 * audiences. Recorded because it is nearly free and directionally useful across
 * sends of the SAME automation; clicks and attributed revenue are the numbers
 * that mean something.
 *
 * Always returns the pixel, whatever happens. A broken image in an email looks
 * like a broken email.
 */
export async function GET(request: NextRequest) {
  const automationKey = request.nextUrl.searchParams.get("k") ?? "";
  const email = (request.nextUrl.searchParams.get("e") ?? "").trim().toLowerCase();
  const referenceId = request.nextUrl.searchParams.get("r") ?? "";
  const token = request.nextUrl.searchParams.get("t") ?? "";

  if (
    automationKey
    && email
    && referenceId
    && isAutomationKey(automationKey)
    && verifyAutomationLink(automationKey, email, referenceId, token)
  ) {
    try {
      // First open only, so the timestamp means "when they first saw it".
      await supabaseAdmin
        .from("email_send_log")
        .update({ opened_at: new Date().toISOString() })
        .eq("campaign_type", `automation:${automationKey}`)
        .eq("reference_id", referenceId)
        .is("opened_at", null);
    } catch {
      // Never worth failing the image over.
    }
  }

  return new NextResponse(PIXEL, {
    status: 200,
    headers: {
      "Content-Type": "image/gif",
      "Content-Length": String(PIXEL.length),
      // Must not be cached: a cached pixel records one open and then goes
      // quiet, and a proxy would serve it to other recipients.
      "Cache-Control": "no-store, no-cache, must-revalidate, private",
      Pragma: "no-cache",
    },
  });
}
