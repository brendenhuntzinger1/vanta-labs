import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-server";
import { verifyUnsubscribeToken } from "@/lib/email/unsubscribe";

export const dynamic = "force-dynamic";

function htmlPage(title: string, message: string) {
  return `<!doctype html><html><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>${title}</title></head>
  <body style="margin:0;padding:0;background:#050505;color:#f4f4f4;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
    <div style="max-width:480px;margin:80px auto;padding:32px;text-align:center;">
      <p style="font-size:13px;letter-spacing:0.32em;text-transform:uppercase;color:#f2c94c;font-weight:700;">Vanta Labs</p>
      <h1 style="font-size:22px;margin-top:16px;">${title}</h1>
      <p style="color:#d4d4d4;line-height:1.6;">${message}</p>
    </div>
  </body></html>`;
}

function htmlResponse(title: string, message: string, status: number) {
  return new NextResponse(htmlPage(title, message), { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

// One-click unsubscribe (no login required - the HMAC token is what proves
// the request is legitimate, since marketing email also goes to guests
// with no account at all). Suppresses future marketing sends to this email
// immediately; transactional email (receipts, shipping updates, billing
// confirmations) is never affected by this list.
export async function GET(request: NextRequest) {
  const email = request.nextUrl.searchParams.get("email")?.trim().toLowerCase();
  const token = request.nextUrl.searchParams.get("token");

  if (!email || !token || !verifyUnsubscribeToken(email, token)) {
    return htmlResponse("Link invalid", "This unsubscribe link is invalid or has expired.", 400);
  }

  const { error } = await supabaseAdmin
    .from("email_suppressions")
    .upsert({ email, reason: "unsubscribed", created_at: new Date().toISOString() }, { onConflict: "email" });

  if (error) {
    return htmlResponse("Something went wrong", "Unable to process this request right now. Please try again shortly.", 500);
  }

  // Best-effort mirror onto the account preference toggle shown in
  // /account/settings, for a signed-in customer with this email. Not
  // fatal if it can't find a matching account (guest, or lookup failure) -
  // email_suppressions above is the real, authoritative gate.
  try {
    const { data } = await supabaseAdmin.auth.admin.listUsers({ perPage: 1000 });
    const matchedUser = data?.users.find((user) => user.email?.toLowerCase() === email);
    if (matchedUser) {
      await supabaseAdmin
        .from("customer_preferences")
        .upsert({ user_id: matchedUser.id, marketing_emails: false, updated_at: new Date().toISOString() }, { onConflict: "user_id" });
    }
  } catch {
    // Non-fatal.
  }

  return htmlResponse("You're unsubscribed", `${email} will no longer receive marketing emails from Vanta Labs. You'll still receive order receipts and account/billing notices.`, 200);
}
