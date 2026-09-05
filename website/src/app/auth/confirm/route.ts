import { NextResponse } from "next/server";

import { getSiteUrl } from "@/lib/env";
import { FORWARDABLE_LINK_TYPES, gotrueVerifyUrl, normalizeLinkType } from "@/lib/auth-confirm-link";
import { safeInternalPath } from "@/lib/internal-path";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// GET /auth/confirm — the hop that keeps every auth link on our own domain.
//
// Emails used to send customers straight to
// https://<project>.supabase.co/auth/v1/verify?..., a domain unrelated to the
// address the mail came from. That mismatch is a classic phishing signal and it
// outlived the branding fix: the 2026-08-29 confirmation was moved onto our
// template, our provider and our From address, and its one button still pointed
// at supabase.co.
//
// This route takes the same single-use token, rebuilds the GoTrue verify URL,
// and redirects. GoTrue still does the verifying — nothing about the auth
// decision happens here — and the customer only ever sees vantalabsresearch.com
// in the message and in their address bar.
//
// The token is NEVER logged. It is read off the query string, put into a
// redirect, and forgotten; a token in a log is a token an attacker can spend.
// ---------------------------------------------------------------------------

/** Where to send someone whose link is malformed or already spent. */
function deadLink(reason: string): NextResponse {
  const site = getSiteUrl().replace(/\/+$/, "");
  // A dead link must SAY it is dead. The failure this whole change exists to
  // fix was a customer staring at a page that told them nothing, so the login
  // page gets a reason it can render and a resend is one tap away.
  return NextResponse.redirect(`${site}/account/login?link=${encodeURIComponent(reason)}`, 303);
}

export async function GET(request: Request) {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return deadLink("invalid");
  }

  const token = (url.searchParams.get("token") ?? "").trim();
  // Accepts the generateLink aliases too (email_change_new / _current), so a
  // hand-built or older link still lands on the verify type GoTrue expects.
  const type = normalizeLinkType(url.searchParams.get("type"));
  const rawNext = (url.searchParams.get("next") ?? "/account").trim();

  if (!token || !FORWARDABLE_LINK_TYPES.has(type)) {
    return deadLink("invalid");
  }

  // Open-redirect guard: `next` is attacker-controllable (it rides in a URL
  // anyone can hand-build), so only a same-site absolute path is accepted.
  // "//evil.example" is protocol-relative and would leave the site.
  const next = safeInternalPath(rawNext, "/account");

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "";
  if (!supabaseUrl) {
    // Nothing to forward to. Say so rather than 500ing at a customer who is
    // one tap from their account.
    console.error("[auth/confirm] NEXT_PUBLIC_SUPABASE_URL is not set; cannot forward a verification link.");
    return deadLink("unavailable");
  }

  const site = getSiteUrl().replace(/\/+$/, "");

  // WHERE GOTRUE PUTS THEM DOWN, and why it is not simply `next`.
  //
  // GoTrue appends the session to redirect_to as a URL FRAGMENT. A fragment is
  // never sent to the server, so landing straight on /account means the layout
  // sees no cookie, bounces to /account/login, and the customer is asked to
  // type the password they just set — having successfully confirmed.
  //
  // Caught in the browser: the account confirmed and the person still ended up
  // staring at a sign-in form. /account/login?verified=1 is the existing,
  // already-tested contract — account-auth-form reads the fragment there,
  // exchanges it for a session and forwards to `next`.
  const redirectTo = type === "recovery" || type === "invite"
    // Both of these end at a password form instead: an invited ambassador has
    // no password yet, and a recovery link exists precisely to set one.
    ? `${site}/account/reset-password`
    : `${site}/account/login?verified=1&next=${encodeURIComponent(next)}`;

  return NextResponse.redirect(
    gotrueVerifyUrl({ supabaseUrl, token, type, redirectTo }),
    // 303, not 307: this is a GET the browser should follow plainly, and it
    // must never be re-issued as anything else.
    303,
  );
}
