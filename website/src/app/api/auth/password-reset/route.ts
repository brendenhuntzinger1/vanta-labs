import { NextResponse } from "next/server";

import { sendEmail } from "@/lib/email/send";
import { passwordResetTemplate } from "@/lib/email/templates";
import { recordSystemAlert } from "@/lib/monitoring";
import { createServerClient, supabaseAdmin } from "@/lib/supabase-server";
import { findUserByEmail } from "@/lib/auth-confirmation-email";
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
// provider, the From identity and the bounce webhook.
//
// It does NOT inherit the retry queue, and that is deliberate: a recovery link
// goes stale the moment another is minted, so a delayed retry would deliver a
// dead link. See deliverResetEmail below.
//
// WHY IT STILL FALLS BACK TO SUPABASE.
//
// Moving the send in-house makes our provider a new single point of failure for
// account recovery. So when anything on the in-house path fails — the admin API
// refuses, the provider is unconfigured, the send errors — we fall back to
// `resetPasswordForEmail`, which is exactly what happened before this route
// existed. The change is therefore strictly additive: at worst it behaves like
// the old code, at best it delivers a branded email the bounce webhook can see.
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

    // TWO DIFFERENT THINGS LIVE IN THIS BRANCH, and only one of them is fine.
    //
    // "No account for this address" is fine: nothing to send, and nothing to
    // say about it. Falling back would only add latency that differs between
    // existing and non-existing addresses, which is the leak this route exists
    // to avoid.
    //
    // "That address HAS an account and minting failed" is not fine. The
    // customer has just been told a link is on its way, nothing was sent, no
    // retry is queued and — until this alert existed — nobody was told. That is
    // the same silent-failure shape that stranded four signups on 2026-08-29,
    // and it lands on the one path a locked-out customer has left.
    //
    // The RESPONSE stays byte-identical either way; only the telemetry differs,
    // so enumeration safety is untouched.
    if (error || !data?.properties?.action_link) {
      const existing = await findUserByEmail(email).catch(() => null);
      if (existing) {
        await recordSystemAlert({
          type: "password_reset_mint_failed",
          severity: "critical",
          message:
            "A password reset was requested for an address that DOES have an account, and the "
            + "recovery link could not be minted — so no email was sent at all. The customer was "
            + "told a link was on its way. They are locked out with no way back until this is fixed.",
          context: { reason: error?.message ?? "no action_link returned" },
          dedupeWindowMs: 30 * 60 * 1000,
        }).catch(() => {});
      }
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

    // The provider refused. Fall through to the Supabase fallback below — and
    // deliberately DO NOT queue this message for retry.
    //
    // A recovery link is not an ordinary transactional email and must not be
    // treated like one. `auth.users.recovery_token` holds a SINGLE token per
    // user, so the fallback's `resetPasswordForEmail` overwrites the token
    // inside the link we just built. Queuing it would deliver, minutes later, a
    // second password-reset email whose link is already dead — after the
    // customer had a working one in hand. Two reset emails for one request is
    // confusing at best; a dead one arriving second is worse than nothing.
    //
    // The failure still has to be visible, which is what the alert is for.
    await recordSystemAlert({
      type: "password_reset_provider_failed",
      severity: "warning",
      message:
        "The configured email provider refused a password-reset send, so it fell back to "
        + "Supabase Auth's own email. Recovery still works, but it is no longer using the "
        + "branded template and the bounce webhook cannot see it. Check the provider in "
        + "Admin -> Settings.",
      context: { error: String(result.error ?? "unknown").slice(0, 300) },
      dedupeWindowMs: 60 * 60 * 1000,
    }).catch(() => {
      /* An alert must never be the reason a reset email does not go out. */
    });
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
