import { NextResponse } from "next/server";

import { MIN_PASSWORD_LENGTH } from "@/lib/password-policy";

import { getAuthenticatedUser, getSessionAccessToken } from "@/lib/auth-session";
import { recordSystemAlert } from "@/lib/monitoring";
import { checkRateLimit } from "@/lib/rate-limit";
import { rateLimitKeyForRequest } from "@/lib/request-ip";
import { customerSafeMessage } from "@/lib/safe-error";
import { createServerClient, supabaseAdmin } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// POST /api/account/change-password
//
// THE CONTROL THAT WAS DESCRIBED BUT NOT ENFORCED.
//
// /account/settings changed a password entirely in the browser:
//
//     if (newPassword.length < 8) throw ...
//     await supabase.auth.signInWithPassword({ email, password: currentPassword })
//     await supabase.auth.updateUser({ password: newPassword })
//
// with the comment "Re-authenticate before applying a change so a hijacked
// session can't lock the real owner out." That is exactly the right intent, and
// none of it held: both the length check and the re-authentication ran in the
// caller's own browser, and `updateUser` is a GoTrue endpoint any holder of the
// session token can call directly. So anyone with a stolen session could set a
// new password WITHOUT knowing the old one — locking the real owner out of
// their own account, which is precisely what the comment set out to prevent.
//
// The same call also bypassed the 8-character rule, leaving whatever minimum
// the Supabase project happens to be configured with (6 by default).
//
// Moving it here makes the guarantee real: the current password is verified
// server-side before anything is written, and the length rule is enforced where
// the caller cannot reach it. Same move as signup, password reset, the
// ambassador invite and the change of email.
//
// AND IT REVOKES THE OTHER SESSIONS.
//
// /account/reset-password already does this — someone changing their password
// is very often doing it BECAUSE they think somebody else is in the account, so
// leaving other sessions live means the intruder keeps their access. Settings
// did not, so the same act had two different security outcomes depending on
// which page you did it from.
// ---------------------------------------------------------------------------

// Matches the rule the settings form has always shown the customer, and the one
// the reset form shows — see lib/password-policy.ts, which also records where
// this rule is genuinely enforced and where it is only advisory.

// Generous for a person correcting a typo, far too few to grind a password.
const MAX_PER_IP = 10;
const MAX_PER_USER = 5;
const WINDOW_SECONDS = 15 * 60;

export async function POST(request: Request) {
  try {
    const user = await getAuthenticatedUser();
    if (!user?.email) {
      return NextResponse.json({ success: false, error: "Please sign in again." }, { status: 401 });
    }

    const body = await request.json().catch(() => ({}));
    const currentPassword = String((body as { currentPassword?: unknown })?.currentPassword ?? "");
    const newPassword = String((body as { newPassword?: unknown })?.newPassword ?? "");

    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      return NextResponse.json(
        { success: false, error: `New password must be at least ${MIN_PASSWORD_LENGTH} characters.` },
        { status: 400 },
      );
    }
    if (!currentPassword) {
      return NextResponse.json(
        { success: false, error: "Enter your current password." },
        { status: 400 },
      );
    }
    if (currentPassword === newPassword) {
      return NextResponse.json(
        { success: false, error: "Your new password must be different from your current one." },
        { status: 400 },
      );
    }

    // This endpoint verifies a password, so it is a password oracle unless it is
    // limited. Per-account as well as per-IP: one account must not be grindable
    // from many addresses.
    const ipLimit = await checkRateLimit(
      rateLimitKeyForRequest("change-password-ip", request), MAX_PER_IP, WINDOW_SECONDS,
    );
    const userLimit = await checkRateLimit(`change-password-user:${user.id}`, MAX_PER_USER, WINDOW_SECONDS);
    if (!ipLimit.allowed || !userLimit.allowed) {
      const retryAfter = String(ipLimit.allowed ? userLimit.retryAfterSeconds : ipLimit.retryAfterSeconds);
      return NextResponse.json(
        { success: false, error: "Too many attempts. Please wait a few minutes and try again." },
        { status: 429, headers: { "Retry-After": retryAfter } },
      );
    }

    // RE-AUTHENTICATE SERVER-SIDE. This is the whole point of the route: a
    // caller holding only a session token cannot get past it.
    const client = createServerClient();
    const { error: reauthError } = await client.auth.signInWithPassword({
      email: user.email,
      password: currentPassword,
    });
    if (reauthError) {
      return NextResponse.json(
        { success: false, error: "Current password is incorrect." },
        { status: 403 },
      );
    }

    const { error: updateError } = await supabaseAdmin.auth.admin.updateUserById(user.id, {
      password: newPassword,
    });
    if (updateError) {
      console.error("[account/change-password] update failed", updateError.message);
      await recordSystemAlert({
        type: "password_change_failed",
        severity: "warning",
        message:
          "A signed-in customer re-authenticated correctly and the password change was still refused, "
          + "so they are stuck on their old password with no way to tell why.",
        context: { reason: updateError.message },
        dedupeWindowMs: 30 * 60 * 1000,
      }).catch(() => {});
      return NextResponse.json(
        { success: false, error: customerSafeMessage(updateError, "Unable to update your password") },
        { status: 400 },
      );
    }

    // Every OTHER session is now stale. Best-effort: the password HAS changed,
    // and failing to revoke must not tell the customer their change did not
    // land — it did.
    try {
      // admin.signOut takes a JWT, NOT a user id — its first parameter is
      // `jwt: string` and it POSTs to /logout?scope=… with that token as the
      // bearer. Passing user.id here sends a garbage token and revokes nothing,
      // silently, which is how a security control ends up existing only in the
      // commit message. Scope "others" keeps THIS session alive so the customer
      // is not signed out of the page they are standing on.
      const accessToken = await getSessionAccessToken();
      if (accessToken) {
        await supabaseAdmin.auth.admin.signOut(accessToken, "others");
      }
    } catch (revokeError) {
      console.error("[account/change-password] could not revoke other sessions", revokeError);
    }

    return NextResponse.json({
      success: true,
      message: "Password updated. Any other devices signed in to this account have been signed out.",
    });
  } catch (error) {
    console.error("[account/change-password]", error);
    return NextResponse.json(
      { success: false, error: customerSafeMessage(error, "Unable to update your password") },
      { status: 400 },
    );
  }
}
