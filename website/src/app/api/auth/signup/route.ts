import { NextResponse } from "next/server";

import { sendEmail } from "@/lib/email/send";
import { accountConfirmationTemplate } from "@/lib/email/templates";
import { fallBackToSupabaseConfirmation, sendBrandedConfirmationResend } from "@/lib/auth-confirmation-email";
import { supabaseAdmin } from "@/lib/supabase-server";
import { checkRateLimit } from "@/lib/rate-limit";
import { getRequestIpAddress, rateLimitKeyForRequest } from "@/lib/request-ip";
import { getSiteUrl } from "@/lib/env";
import { brandedConfirmUrl } from "@/lib/auth-confirm-link";
import { verifyTurnstileToken } from "@/lib/turnstile";
import { SIGNUP_CHECK_EMAIL_MESSAGE } from "@/lib/auth-signup-outcome";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// POST /api/auth/signup — create the account AND send the confirmation email.
//
// WHY THIS ROUTE EXISTS.
//
// Signup confirmation was the last transactional email this app did not send.
// `supabase.auth.signUp()` runs in the browser and Supabase Auth mails the
// confirmation itself, from its own template and its own identity — so the
// message never touched sendEmail(), produced no send-log row, and raised no
// event on the bounce webhook. It was the only piece of the system with no
// telemetry at all.
//
// On 2026-08-29 that cost real customers. Four of nine signups over four days
// never confirmed. Every check came back clean: the template was well-formed
// with {{ .ConfirmationURL }} in the anchor, custom SMTP was on and pointed at
// Resend on the port Resend documents, Supabase logged no send error, the
// confirmation tokens were minted and unspent — and Resend reported DELIVERED
// for every one of them. The mail arrived and nobody clicked it, because
// Supabase's default template is a bare <h2>, one sentence and a naked <a>,
// which is the exact shape of a phishing email. Gmail filed it accordingly.
// Meanwhile the branded order confirmations, same domain, same Resend account,
// landed every time.
//
// So the fix is not a better Supabase template — it is not sending from there
// at all. `generateLink` mints the confirmation link WITHOUT mailing anything,
// exactly as /api/auth/password-reset already does for recovery, and the link
// then goes out through sendEmail() with renderLayout's branding, from the
// identity configured in Admin → Settings, visible to the bounce webhook.
//
// THE PASSWORD IS WHY THIS HAS TO BE A ROUTE.
//
// `generateLink({ type: "signup" })` requires the user's password. templates.ts
// used to say that made an app-sent confirmation impossible, which was true of
// an account that ALREADY exists and false at the only moment that matters: at
// signup the person has just typed it. It reaches this route over TLS, is
// handed straight to Supabase, and is never logged or stored here.
//
// ENUMERATION SAFETY IS THE HARD CONSTRAINT, exactly as on password-reset.
//
// `supabase.auth.signUp()` answers a signup for an existing address with an
// obfuscated user and sends nothing, so the form cannot be used to probe which
// addresses have accounts. `generateLink` is blunter: it ERRORS with "user
// already registered". That signal must never reach the client. Every path
// below therefore returns one identical body, and the difference between a new
// address, an existing one, and a send failure is visible only server-side.
// ---------------------------------------------------------------------------

/** Identical for every caller — see ENUMERATION SAFETY above. */
const GENERIC_RESPONSE = {
  success: true,
  message: SIGNUP_CHECK_EMAIL_MESSAGE,
} as const;

// Per-IP allows a household or a shared network a few goes; per-address stops
// one mailbox being flooded from many IPs. Mirrors password-reset's shape.
const MAX_PER_IP = 8;
const MAX_PER_EMAIL = 4;
const WINDOW_SECONDS = 15 * 60;

/** What the confirmation link lands on once GoTrue has verified it. */
function confirmationRedirect(nextPath: string): string {
  const site = getSiteUrl().replace(/\/+$/, "");
  const safeNext = nextPath.startsWith("/") && !nextPath.startsWith("//") ? nextPath : "/account";
  return `${site}/account/login?verified=1&next=${encodeURIComponent(safeNext)}`;
}

/** Best-effort display name, never used for anything but the greeting. */
function greetingName(fullName: string): string {
  return fullName.trim().split(/\s+/)[0] ?? "";
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const read = (key: string) => String((body as Record<string, unknown>)?.[key] ?? "").trim();

    const email = read("email").toLowerCase();
    const password = String((body as { password?: unknown })?.password ?? "");
    const fullName = read("fullName").slice(0, 120);
    const businessType = read("businessType").slice(0, 80);
    const referredByCode = read("referredByCode").slice(0, 32);
    const captchaToken = read("captchaToken");
    const nextPath = read("nextPath") || "/account";

    // Shape checks only, and each one answers the same way a real attempt does
    // where it can. A password that is too short is the one exception: it is
    // the user's own input error, reveals nothing about any account, and
    // silently swallowing it would leave them staring at "check your email"
    // for a message that was never sent.
    if (!email || !email.includes("@") || email.length > 320) {
      return NextResponse.json(GENERIC_RESPONSE);
    }
    if (password.length < 8) {
      return NextResponse.json(
        { success: false, error: "Password must be at least 8 characters." },
        { status: 400 },
      );
    }

    const ipLimit = await checkRateLimit(
      rateLimitKeyForRequest("signup-ip", request),
      MAX_PER_IP,
      WINDOW_SECONDS,
    );
    if (!ipLimit.allowed) {
      return NextResponse.json(
        { success: false, error: "Too many signup attempts. Please wait a few minutes and try again." },
        { status: 429, headers: { "Retry-After": String(ipLimit.retryAfterSeconds) } },
      );
    }

    const emailLimit = await checkRateLimit(`signup-email:${email}`, MAX_PER_EMAIL, WINDOW_SECONDS);
    if (!emailLimit.allowed) {
      // GENERIC, not a 429: a distinguishable answer would confirm that this
      // address has been tried recently, which is the same leak in weaker form.
      return NextResponse.json(GENERIC_RESPONSE);
    }

    const captcha = await verifyTurnstileToken(captchaToken, getRequestIpAddress(request));
    if (!captcha.ok) {
      return NextResponse.json(
        { success: false, error: "Couldn't verify you're human. Please try again." },
        { status: 400 },
      );
    }

    await createAccountAndSend({
      email,
      password,
      fullName,
      businessType,
      referredByCode,
      redirectTo: confirmationRedirect(nextPath),
    });

    return NextResponse.json(GENERIC_RESPONSE);
  } catch (error) {
    // Even an unexpected failure answers generically: a 500 is itself a signal
    // ("that address made the server work harder"). Full detail server-side.
    console.error("[auth/signup]", error);
    return NextResponse.json(GENERIC_RESPONSE);
  }
}

/**
 * Mint the link, send it branded, and never say which branch ran.
 *
 * Three outcomes, one response:
 *   new address      -> user created unconfirmed, branded confirmation sent
 *   existing address -> no user created; a branded MAGIC LINK is sent instead,
 *                       but only to an account that is still unconfirmed
 *   anything failed  -> Supabase's own email as a fallback, plus an alert
 */
async function createAccountAndSend(input: {
  email: string;
  password: string;
  fullName: string;
  businessType: string;
  referredByCode: string;
  redirectTo: string;
}): Promise<void> {
  const { data, error } = await supabaseAdmin.auth.admin.generateLink({
    type: "signup",
    email: input.email,
    password: input.password,
    options: {
      redirectTo: input.redirectTo,
      // The same metadata shape signUp() wrote, so nothing downstream that
      // reads raw_user_meta_data can tell which path created the row.
      data: {
        full_name: input.fullName,
        role: "customer",
        business_type: input.businessType,
        age_confirmed_21: true,
        research_use_only_agreed: true,
        ...(input.referredByCode ? { referred_by_code: input.referredByCode } : {}),
      },
    },
  });

  if (error || !data?.properties?.action_link) {
    // Overwhelmingly this is "user already registered". Nothing is created and
    // nothing is said — but an account stranded UNCONFIRMED is exactly the
    // person this whole change is for, so they get a branded way back in.
    await sendBrandedConfirmationResend(input.email, input.redirectTo);
    return;
  }

  const template = accountConfirmationTemplate({
    name: greetingName(input.fullName),
    // Our own host, not <project>.supabase.co — see lib/auth-confirm-link.ts.
    // A link whose domain does not match the sender is a phishing signal, and
    // it was the one spam reason the branding fix did not remove.
    confirmUrl: brandedConfirmUrl({
      hashedToken: data.properties.hashed_token,
      type: data.properties.verification_type ?? "signup",
      next: "/account",
      fallbackActionLink: data.properties.action_link,
    }),
  });

  const result = await sendEmail({ to: input.email, ...template });
  if (result.success) {
    return;
  }

  await fallBackToSupabaseConfirmation(input.email, result.error);
}
