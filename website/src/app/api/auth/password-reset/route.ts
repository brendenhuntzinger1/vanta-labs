import { NextResponse } from "next/server";

import { sendEmail } from "@/lib/email/send";
import { passwordResetTemplate } from "@/lib/email/templates";
import { enqueueFailedEmail } from "@/lib/email/retry-queue";
import { createServerClient, supabaseAdmin } from "@/lib/supabase-server";
import { checkRateLimit } from "@/lib/rate-limit";
import { getRequestIpAddress, rateLimitKeyForRequest } from "@/lib/request-ip";
import { getSiteUrl } from "@/lib/env";
import { verifyTurnstileToken } from "@/lib/turnstile";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// POST /api/auth/password-reset — send a password reset link.
//
// WHY THIS ROUTE EXISTS (audit E1).
//
// `passwordResetTemplate` had been sitting in templates.ts with ZERO call
// sites. The reset email was sent by Supabase Auth's own SMTP, using Supabase's
// default template, from whatever identity is configured in the Supabase
// dashboard — while `lib/email/settings.ts` told operators that "EVERY
// transactional email ... password resets, account verification ... flows
// through the same sendEmail()". It did not. Three things followed from that:
//
//   * the bounce/complaint webhook never saw a reset-email bounce, so a hard
//     bouncing address on the ONE path a locked-out customer has was invisible;
//   * the branded template never rendered;
//   * an operator who configured email in Admin → Settings had not, in fact,
//     configured password reset.
//
// This route closes that. It mints the recovery link with the ADMIN API — which
// generates a link WITHOUT sending anything — and then puts it through the same
// sendEmail() as every other transactional message, so it inherits the
// provider, the From identity, the bounce webhook and the retry queue.
//
// WHY IT STILL FALLS BACK TO SUPABASE.
//
// Moving the send in-house makes our provider a new single point of failure for
// account recovery. So when anything on the in-house path fails — the admin API
// refuses, the provider is unconfigured, the send errors — we fall back to
// `resetPasswordForEmail`, which is exactly what happened before this route
// existed. The change is therefore strictly additive: at worst it behaves like
// the old code, at best it delivers a branded, monitored, retryable email.
//
// ENUMERATION SAFETY IS THE HARD CONSTRAINT.
//
// The response is byte-identical whether or not the address has an account, and
// whether or not any email was actually sent. `generateLink` DOES report
// "user not found", and that signal must never reach the client — it would turn
// this endpoint into the account oracle that the signup form goes to
// considerable trouble to avoid (see auth-signup-outcome.ts). Timing is not
// equalised: the rate limiter below is the control for bulk probing.
// ---------------------------------------------------------------------------

/** Identical for every caller — see ENUMERATION SAFETY above. */
const GENERIC_RESPONSE = {
  success: true,
  message:
    "If an account exists for that email, a password reset link is on its way.",
} as const;

// Per-IP: enough for a person who mistypes their address a few times, far too
// few to enumerate. Per-address on top, so one mailbox cannot be flooded from
// a botnet of addresses that each stay under the IP limit.
const MAX_PER_IP = 5;
const MAX_PER_EMAIL = 3;
const WINDOW_SECONDS = 15 * 60;

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const email = String((body as { email?: unknown })?.email ?? "").trim().toLowerCase();
    const captchaToken = String((body as { captchaToken?: unknown })?.captchaToken ?? "");

    // Shape check only. An invalid address gets the same answer as a valid one
    // that has no account — silence is the whole point.
    if (!email || !email.includes("@") || email.length > 320) {
      return NextResponse.json(GENERIC_RESPONSE);
    }

    const ipLimit = await checkRateLimit(
      rateLimitKeyForRequest("password-reset-ip", request),
      MAX_PER_IP,
      WINDOW_SECONDS,
    );
    if (!ipLimit.allowed) {
      return NextResponse.json(
        { success: false, error: "Too many reset requests. Please wait a few minutes and try again." },
        { status: 429, headers: { "Retry-After": String(ipLimit.retryAfterSeconds) } },
      );
    }

    const emailLimit = await checkRateLimit(`password-reset-email:${email}`, MAX_PER_EMAIL, WINDOW_SECONDS);
    if (!emailLimit.allowed) {
      // Deliberately the GENERIC response, not a 429: a distinguishable answer
      // here would confirm that this specific address has been asked for
      // recently, which is a weaker form of the same enumeration leak.
      return NextResponse.json(GENERIC_RESPONSE);
    }

    const captcha = await verifyTurnstileToken(captchaToken, getRequestIpAddress(request));
    if (!captcha.ok) {
      return NextResponse.json(
        { success: false, error: "Couldn't verify you're human. Please try again." },
        { status: 400 },
      );
    }

    const redirectTo = `${getSiteUrl().replace(/\/+$/, "")}/account/reset-password`;

    await deliverResetEmail(email, redirectTo);

    return NextResponse.json(GENERIC_RESPONSE);
  } catch (error) {
    // Even an unexpected failure answers generically. A 500 here is itself a
    // signal ("that address made the server work harder"), and the operator
    // still gets the full error server-side.
    console.error("[auth/password-reset]", error);
    return NextResponse.json(GENERIC_RESPONSE);
  }
}

/**
 * Mint the link and send it ourselves; fall back to Supabase's own email if any
 * step of that fails. Never throws, never reports which branch ran.
 */
async function deliverResetEmail(email: string, redirectTo: string): Promise<void> {
  try {
    const { data, error } = await supabaseAdmin.auth.admin.generateLink({
      type: "recovery",
      email,
      options: { redirectTo },
    });

    // No account for this address. Nothing to send, and — critically — nothing
    // to say about it. Return without falling back: asking Supabase to send
    // would be equally silent, so the fallback would only add latency that
    // differs between existing and non-existing addresses.
    if (error || !data?.properties?.action_link) {
      return;
    }

    const template = passwordResetTemplate({
      name: resolveGreetingName(data.user),
      resetUrl: data.properties.action_link,
    });

    const result = await sendEmail({ to: email, ...template });
    if (result.success) {
      return;
    }

    // The provider refused. Queue it so the sweep retries with backoff, then
    // fall through to Supabase so the customer is not left waiting on a retry.
    await enqueueFailedEmail({ to: email, ...template }, result.error);
  } catch (adminError) {
    console.error("[auth/password-reset] in-house send failed; falling back to Supabase", adminError);
  }

  await sendViaSupabase(email, redirectTo);
}

/** The pre-existing behaviour, kept as the safety net. */
async function sendViaSupabase(email: string, redirectTo: string): Promise<void> {
  try {
    const client = createServerClient();
    await client.auth.resetPasswordForEmail(email, { redirectTo });
  } catch (fallbackError) {
    console.error("[auth/password-reset] Supabase fallback failed", fallbackError);
  }
}

function resolveGreetingName(user: { user_metadata?: Record<string, unknown> } | null): string {
  const fullName = typeof user?.user_metadata?.full_name === "string" ? user.user_metadata.full_name.trim() : "";
  // "there" rather than the mailbox local-part: a reset email that greets
  // someone by a mangled address reads like phishing, which is the last
  // impression this particular email should give.
  return fullName || "there";
}
