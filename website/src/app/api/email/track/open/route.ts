import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-server";
import { stampCartRecoveryEngagement } from "@/lib/email/engagement";

export const dynamic = "force-dynamic";

// 1x1 transparent PNG, served regardless of whether tracking succeeds -
// a broken pixel would look wrong in the email client, and open-tracking
// is inherently best-effort (many clients block remote images by default).
const TRANSPARENT_PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

export async function GET(request: NextRequest) {
  const id = request.nextUrl.searchParams.get("id");

  if (id) {
    try {
      await supabaseAdmin
        .from("abandoned_cart_emails")
        .update({ opened_at: new Date().toISOString() })
        .eq("id", id)
        .is("opened_at", null);
    } catch {
      // Non-fatal - the pixel still needs to render.
    }
    // ...and again in email_send_log, which is the one table that lists every
    // send the system makes. Cart-recovery opens were recorded here alone for
    // six weeks, which is why they appeared nowhere the owner looks.
    await stampCartRecoveryEngagement("opened", id);
  }

  return new NextResponse(TRANSPARENT_PIXEL, {
    status: 200,
    headers: { "Content-Type": "image/png", "Cache-Control": "no-store" },
  });
}
