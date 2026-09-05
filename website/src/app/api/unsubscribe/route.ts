import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-server";
import { verifyUnsubscribeToken } from "@/lib/email/unsubscribe";
import { findUserByEmail } from "@/lib/auth-confirmation-email";

export const dynamic = "force-dynamic";

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function htmlPage(rawTitle: string, rawMessage: string) {
  // Defense-in-depth: the message embeds the caller-supplied email. Reaching
  // here already requires a valid HMAC token, but escape anyway so no reflected
  // markup can ever render.
  const title = escapeHtml(rawTitle);
  const message = escapeHtml(rawMessage);
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

/**
 * The confirmation step the footer link lands on (EMAIL-07). One sentence,
 * one button; the button POSTs the very same signed token to this route with
 * `confirm=1` in the body, so the human path and Gmail's one-click path share
 * one authorisation and one suppression write.
 */
function confirmPage(rawEmail: string, actionUrl: string) {
  const email = escapeHtml(rawEmail);
  const action = escapeHtml(actionUrl);
  return `<!doctype html><html><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><meta name="robots" content="noindex" /><title>Unsubscribe from marketing emails</title></head>
  <body style="margin:0;padding:0;background:#050505;color:#f4f4f4;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
    <div style="max-width:480px;margin:80px auto;padding:32px;text-align:center;">
      <p style="font-size:13px;letter-spacing:0.32em;text-transform:uppercase;color:#f2c94c;font-weight:700;">Vanta Labs</p>
      <h1 style="font-size:22px;margin-top:16px;">Unsubscribe from marketing emails</h1>
      <p style="color:#d4d4d4;line-height:1.6;">Stop marketing emails to <strong>${email}</strong>? You'll still receive order receipts and account/billing notices.</p>
      <form method="post" action="${action}" style="margin-top:24px;">
        <input type="hidden" name="confirm" value="1" />
        <button type="submit" style="background:#f2c94c;color:#111;border:0;border-radius:999px;padding:14px 28px;font-size:15px;font-weight:700;cursor:pointer;">Unsubscribe</button>
      </form>
    </div>
  </body></html>`;
}

// One-click unsubscribe (no login required - the HMAC token is what proves
// the request is legitimate, since marketing email also goes to guests
// with no account at all). Suppresses future marketing sends to this email
// immediately; transactional email (receipts, shipping updates, billing
// confirmations) is never affected by this list.
/**
 * Record the opt-out. Shared verbatim by the footer link (GET) and Gmail's
 * one-click button (POST), so all three entry points are the same decision.
 */
/**
 * Which send carried the link — `campaign:<uuid>`, `automation:winback_60`,
 * `cart_recovery_t72h`. Reporting only; it never affects whether the opt-out
 * is honoured. Restricted to a short, plain identifier so nothing typed into
 * the URL can end up in a report verbatim.
 */
function unsubscribeSource(raw: string | null): string | null {
  const value = String(raw ?? "").trim().slice(0, 120);
  return /^[a-z0-9_:-]+$/i.test(value) ? value : null;
}

async function suppress(email: string, source: string | null): Promise<{ ok: boolean }> {
  const row = { email, reason: "unsubscribed", created_at: new Date().toISOString() };
  let { error } = await supabaseAdmin
    .from("email_suppressions")
    .upsert({ ...row, source }, { onConflict: "email" });

  // The `source` column arrived with email-lifecycle-2026-09-04.sql. A database
  // that has not run it yet must still honour the opt-out — that is the one
  // thing this route exists for — so the write is retried without the column.
  if (error && /source/i.test(String(error.message ?? ""))) {
    ({ error } = await supabaseAdmin
      .from("email_suppressions")
      .upsert(row, { onConflict: "email" }));
  }

  if (error) return { ok: false };

  // Best-effort mirror onto the account preference toggle shown in
  // /account/settings, for a signed-in customer with this email. Not
  // fatal if it can't find a matching account (guest, or lookup failure) -
  // email_suppressions above is the real, authoritative gate.
  //
  // NOT listUsers({ perPage: 1000 }). That read the first thousand accounts and
  // scanned them, so for any customer past the thousandth the toggle in
  // /account/settings silently stayed ON after they had unsubscribed — the
  // suppression list stopped the mail, but the account page said otherwise.
  // findUserByEmail asks the directory for THIS address (an RPC, with a paged
  // walk behind it), so it does not stop at a page boundary.
  try {
    const matchedUser = await findUserByEmail(email);
    if (matchedUser) {
      await supabaseAdmin
        .from("customer_preferences")
        .upsert({ user_id: matchedUser.id, marketing_emails: false, updated_at: new Date().toISOString() }, { onConflict: "user_id" });
    }
  } catch {
    // Non-fatal.
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// GET — the footer link. RENDERS A CONFIRMATION; CHANGES NOTHING (EMAIL-07).
//
// This used to suppress on sight. Corporate and ISP link scanners (Outlook Safe
// Links, Proofpoint, Mimecast, some Gmail prefetch) issue a GET to every link
// in a message, and the HMAC token is per-address and never expires — so one
// scan of any marketing email silently unsubscribed that recipient for good,
// with no notice to anyone. A GET must not change state; the human confirms
// with one button, which POSTs the same token below.
// ---------------------------------------------------------------------------
export async function GET(request: NextRequest) {
  const email = request.nextUrl.searchParams.get("email")?.trim().toLowerCase();
  const token = request.nextUrl.searchParams.get("token");

  if (!email || !token || !verifyUnsubscribeToken(email, token)) {
    return htmlResponse("Link invalid", "This unsubscribe link is invalid or has expired.", 400);
  }

  const params = new URLSearchParams({ email, token });
  const source = unsubscribeSource(request.nextUrl.searchParams.get("s"));
  if (source) params.set("s", source);
  return new NextResponse(confirmPage(email, `${request.nextUrl.pathname}?${params.toString()}`), {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}

// ---------------------------------------------------------------------------
// POST — RFC 8058 one-click unsubscribe.
//
// This is what Gmail's and Yahoo's own "Unsubscribe" button calls. Both have
// required bulk senders to support it since February 2024, and a commercial
// message that does not is one their filters may score worse. That is not an
// abstract risk here: on 2026-08-29 a message this store sent was DELIVERED,
// filed as spam, had its links stripped by the filter, and left four customers
// unable to finish signing up.
//
// The mail client POSTs with no cookies and no user interaction, so the signed
// token in the URL is the whole authorisation — the same HMAC the footer link
// carries. The body ("List-Unsubscribe=One-Click") is not read: the RFC says a
// sender must not require anything further, and the token already proves the
// request came from a message we sent to that address.
//
// The response to a mail client is a bare 200. No HTML: nothing renders it.
//
// The SAME handler also takes the confirmation form the GET page renders
// (EMAIL-07). That form carries `confirm=1` in its body, which no RFC 8058
// client sends (theirs is `List-Unsubscribe=One-Click`), and a person is
// looking at the answer — so that one case gets the rendered page. Everything
// else about the mail-client path is unchanged.
// ---------------------------------------------------------------------------
async function confirmedFromPage(request: NextRequest): Promise<boolean> {
  try {
    const body = await request.text();
    return new URLSearchParams(body).get("confirm") === "1";
  } catch {
    return false;
  }
}

export async function POST(request: NextRequest) {
  const email = request.nextUrl.searchParams.get("email")?.trim().toLowerCase();
  const token = request.nextUrl.searchParams.get("token");
  const fromPage = await confirmedFromPage(request);

  if (!email || !token || !verifyUnsubscribeToken(email, token)) {
    return fromPage
      ? htmlResponse("Link invalid", "This unsubscribe link is invalid or has expired.", 400)
      : new NextResponse("Invalid unsubscribe link", { status: 400 });
  }

  const { ok } = await suppress(email, unsubscribeSource(request.nextUrl.searchParams.get("s")));
  if (fromPage) {
    return ok
      ? htmlResponse("You're unsubscribed", `${email} will no longer receive marketing emails from Vanta Labs. You'll still receive order receipts and account/billing notices.`, 200)
      : htmlResponse("Something went wrong", "Unable to process this request right now. Please try again shortly.", 500);
  }
  // A 5xx makes the client retry, which is right: the customer asked to stop.
  return new NextResponse(ok ? "Unsubscribed" : "Unable to process", { status: ok ? 200 : 500 });
}
