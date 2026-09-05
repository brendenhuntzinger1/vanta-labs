import { NextResponse } from "next/server";

import { sendBrandedConfirmationResend } from "@/lib/auth-confirmation-email";
import { checkRateLimit } from "@/lib/rate-limit";
import { getRequestIpAddress, rateLimitKeyForRequest } from "@/lib/request-ip";
import { getSiteUrl } from "@/lib/env";
import { verifyTurnstileToken } from "@/lib/turnstile";
import { looksLikeEmail } from "@/lib/email-shape";
import { safeInternalPath } from "@/lib/internal-path";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// POST /api/auth/resend-confirmation — the "Resend confirmation email" button.
//
// It used to call supabase.auth.resend() from the browser, which mails
// Supabase's own template. That is the SAME message Gmail filed as spam on
// 2026-08-29 — and Gmail strips links out of spam, so the recipient opened an
// email with nothing to click and reported, correctly, that "the email doesn't
// have a link".
//
// Re-sending someone an identical copy of the message they already could not
// use is not a recovery path, which made this button worse than useless: it
// reported success, burned the customer's patience, and moved nothing.
//
// It now mints a magic link and sends it branded through sendEmail(), so a
// resend is the one message most likely to reach an inbox rather than the one
// least likely. See lib/auth-confirmation-email.ts for why it is a magic link
// and not a fresh signup link.
// ---------------------------------------------------------------------------

/**
 * Identical for every caller.
 *
 * The old client call was enumeration-safe because Supabase made it so; this
 * route has to be deliberately so. It answers the same for an address with a
 * pending confirmation, one that is already confirmed, and one that has never
 * existed.
 */
const GENERIC_RESPONSE = {
  success: true,
  message:
    "If that address has an account still waiting on confirmation, a new link is on its way. "
    + "It can take a minute — check spam too.",
} as const;

const MAX_PER_IP = 5;
const MAX_PER_EMAIL = 3;
const WINDOW_SECONDS = 15 * 60;

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const email = String((body as { email?: unknown })?.email ?? "").trim().toLowerCase();
    const captchaToken = String((body as { captchaToken?: unknown })?.captchaToken ?? "");
    const nextPath = String((body as { nextPath?: unknown })?.nextPath ?? "").trim() || "/account";

    if (!looksLikeEmail(email)) {
      return NextResponse.json(GENERIC_RESPONSE);
    }

    const ipLimit = await checkRateLimit(
      rateLimitKeyForRequest("resend-confirmation-ip", request),
      MAX_PER_IP,
      WINDOW_SECONDS,
    );
    if (!ipLimit.allowed) {
      return NextResponse.json(
        { success: false, error: "Too many requests. Please wait a few minutes and try again." },
        { status: 429, headers: { "Retry-After": String(ipLimit.retryAfterSeconds) } },
      );
    }

    const emailLimit = await checkRateLimit(`resend-confirmation-email:${email}`, MAX_PER_EMAIL, WINDOW_SECONDS);
    if (!emailLimit.allowed) {
      // GENERIC rather than 429: a distinguishable answer would confirm this
      // address has been asked for recently, which is the same leak in weaker
      // form. Matches /api/auth/password-reset.
      return NextResponse.json(GENERIC_RESPONSE);
    }

    const captcha = await verifyTurnstileToken(captchaToken, getRequestIpAddress(request));
    if (!captcha.ok) {
      return NextResponse.json(
        { success: false, error: "Couldn't verify you're human. Please try again." },
        { status: 400 },
      );
    }

    const safeNext = safeInternalPath(nextPath, "/account");
    const redirectTo = `${getSiteUrl().replace(/\/+$/, "")}/account/login?verified=1&next=${encodeURIComponent(safeNext)}`;

    await sendBrandedConfirmationResend(email, redirectTo);

    return NextResponse.json(GENERIC_RESPONSE);
  } catch (error) {
    console.error("[auth/resend-confirmation]", error);
    return NextResponse.json(GENERIC_RESPONSE);
  }
}
