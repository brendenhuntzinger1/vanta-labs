import { NextResponse } from "next/server";

import { brandedConfirmUrl } from "@/lib/auth-confirm-link";
import { getAuthenticatedUser } from "@/lib/auth-session";
import { getSiteUrl } from "@/lib/env";
import { sendEmail } from "@/lib/email/send";
import { recordAuthEmailAttempt } from "@/lib/auth-email-audit";
import { emailChangeConfirmationTemplate } from "@/lib/email/templates";
import { recordSystemAlert } from "@/lib/monitoring";
import { checkRateLimit } from "@/lib/rate-limit";
import { rateLimitKeyForRequest } from "@/lib/request-ip";
import { customerSafeMessage } from "@/lib/safe-error";
import { createServerClient, supabaseAdmin } from "@/lib/supabase-server";
import { looksLikeEmail } from "@/lib/email-shape";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// POST /api/account/email-change — the last auth email Supabase still sent.
//
// /account/settings called supabase.auth.updateUser({ email }) from the
// browser, which makes GoTrue mail its own unstyled template, from Supabase's
// identity, with a button pointing at <project>.supabase.co. Unbranded body,
// off-domain link, no send-log row, no retry-queue row, no alert if it fails —
// the exact message shape Gmail filed as spam on 2026-08-29 and stripped the
// links out of. Meanwhile the page told the customer "Check your new email
// address to confirm the change."
//
// Signup, resend-confirmation, password reset and the ambassador invite were
// all moved onto generateLink + sendEmail. This is the same move for the one
// that was left behind. GoTrue still owns the change itself: this mints the
// link it would have mailed and sends it through our own provider and template.
//
// NOT enumeration-sensitive the way signup and password-reset are — the caller
// must already hold a session, so it cannot be used to probe for accounts. It
// IS abuse-sensitive in the other direction: it can mail an arbitrary address,
// so it is rate limited per session and per IP.
//
// AND IT RE-AUTHENTICATES, WHICH IT DID NOT USED TO.
//
// account-settings-client.tsx has always said, above the email field:
//
//     // Changing the email is security-sensitive: require the current password
//     // first so a hijacked open session can't silently take over the account.
//     await supabase.auth.signInWithPassword({ email: initialEmail, password })
//
// That check ran in the caller's own browser and this route never asked for a
// password at all, so it enforced nothing: anyone holding the session cookie
// could POST straight here with a new address, confirm it from their own
// mailbox, and then own the account outright via password reset. The stated
// threat — "a hijacked open session" — was exactly the one still open, and an
// email takeover is worse than the password takeover its sibling route closed,
// because it survives the real owner changing their password back.
//
// change-password/route.ts fixed the same shape and its comment claims this
// route was already part of that move ("Same move as ... the change of email").
// It was not. This is that move, actually made: the current password is
// verified server-side, by the server's own client, before anything is minted.
// ---------------------------------------------------------------------------

const MAX_PER_IP = 10;
const MAX_PER_USER = 5;
const WINDOW_SECONDS = 60 * 60;

export async function POST(request: Request) {
  try {
    const user = await getAuthenticatedUser();
    if (!user?.email) {
      return NextResponse.json({ success: false, error: "Please sign in again." }, { status: 401 });
    }

    const body = await request.json().catch(() => ({}));
    const newEmail = String((body as { email?: unknown })?.email ?? "").trim().toLowerCase();
    const currentPassword = String((body as { currentPassword?: unknown })?.currentPassword ?? "");

    if (!looksLikeEmail(newEmail)) {
      return NextResponse.json({ success: false, error: "Enter a valid email address." }, { status: 400 });
    }
    if (newEmail === user.email.trim().toLowerCase()) {
      return NextResponse.json({ success: false, error: "That is already your email address." }, { status: 400 });
    }
    // Checked before the limiter, because an empty field is the customer's own
    // mistake and must not spend their five attempts an hour.
    if (!currentPassword) {
      return NextResponse.json(
        { success: false, error: "Enter your current password to change your email address." },
        { status: 400 },
      );
    }

    // Per-IP and per-account, because this endpoint can put a message in any
    // mailbox its caller names. Neither limit inconveniences someone correcting
    // a typo twice.
    const ipLimit = await checkRateLimit(rateLimitKeyForRequest("email-change-ip", request), MAX_PER_IP, WINDOW_SECONDS);
    const userLimit = await checkRateLimit(`email-change-user:${user.id}`, MAX_PER_USER, WINDOW_SECONDS);
    if (!ipLimit.allowed || !userLimit.allowed) {
      const retryAfter = String(ipLimit.allowed ? userLimit.retryAfterSeconds : ipLimit.retryAfterSeconds);
      return NextResponse.json(
        { success: false, error: "Too many email change requests. Please wait a while and try again." },
        { status: 429, headers: { "Retry-After": retryAfter } },
      );
    }

    // RE-AUTHENTICATE SERVER-SIDE, after the limiter, because verifying a
    // password is what makes an endpoint a password oracle and the limiter is
    // what stops it being a free one. A caller holding only a session token
    // cannot get past this, which is the whole point of the route now.
    const reauth = createServerClient();
    const { error: reauthError } = await reauth.auth.signInWithPassword({
      email: user.email,
      password: currentPassword,
    });
    if (reauthError) {
      return NextResponse.json(
        { success: false, error: "Current password is incorrect." },
        { status: 403 },
      );
    }

    // `email_change_new` is the link that goes to the address being ADOPTED,
    // which is the one that proves the customer controls it. Minting it also
    // records the pending change on the auth row, exactly as updateUser did.
    const minted = await supabaseAdmin.auth.admin.generateLink({
      type: "email_change_new",
      email: user.email,
      newEmail,
      options: { redirectTo: `${getSiteUrl().replace(/\/+$/, "")}/account/settings?email_changed=1` },
    });

    if (minted.error || !minted.data?.properties?.action_link) {
      // Nothing was minted, so nothing will arrive. Say so rather than
      // repeating the failure this route exists to end: a page that promises an
      // email nobody sent.
      const reason = minted.error?.message ?? "no action_link returned";
      console.error("[account/email-change] mint failed", reason);
      await recordSystemAlert({
        type: "email_change_mint_failed",
        severity: "warning",
        message:
          "A signed-in customer asked to change their email address and the confirmation link could "
          + "not be minted, so no email was sent. Most often the new address is already registered "
          + "to another account.",
        context: { reason },
        dedupeWindowMs: 30 * 60 * 1000,
      }).catch(() => {});

      return NextResponse.json(
        { success: false, error: "We couldn't start that email change. That address may already be in use." },
        { status: 400 },
      );
    }

    const fullName = typeof user.user_metadata?.full_name === "string" ? user.user_metadata.full_name : "";
    const template = emailChangeConfirmationTemplate({
      name: fullName.trim().split(/\s+/)[0] ?? "",
      newEmail,
      confirmUrl: brandedConfirmUrl({
        hashedToken: minted.data.properties.hashed_token,
        type: minted.data.properties.verification_type ?? "email_change",
        next: "/account/settings",
        fallbackActionLink: minted.data.properties.action_link,
      }),
    });

    const result = await sendEmail({ to: newEmail, ...template });

    // Recorded like the other auth sends — see lib/auth-email-audit.ts. This
    // one is logged against the NEW address, because that is the mailbox the
    // link was sent to and the one the customer will say never received it.
    await recordAuthEmailAttempt({
      kind: "email_change",
      email: newEmail,
      success: result.success,
      error: result.error,
    });

    if (!result.success) {
      // The pending change is recorded on the auth row either way, so the
      // customer is mid-change with nothing in their inbox. Deliberately NOT
      // queued for retry: auth.users holds ONE email_change_token, and a
      // re-request overwrites it — a queued copy would deliver a dead link
      // minutes later, after they had already asked again and received a live
      // one. Two confirmation emails for one change is confusing; a dead one
      // arriving second is worse than none.
      console.error("[account/email-change] send failed", result.error);
      await recordSystemAlert({
        type: "email_change_send_failed",
        severity: "warning",
        message:
          "The email provider refused a change-of-address confirmation, so the customer is mid-change "
          + "with nothing in their inbox. Check the provider in Admin -> Settings.",
        context: { error: String(result.error ?? "unknown").slice(0, 300) },
        dedupeWindowMs: 60 * 60 * 1000,
      }).catch(() => {});

      return NextResponse.json(
        { success: false, error: "We couldn't send the confirmation email. Please try again in a few minutes." },
        { status: 502 },
      );
    }

    return NextResponse.json({
      success: true,
      message: `Check ${newEmail} — we've sent a link to confirm the change. Your account keeps its current address until you do.`,
    });
  } catch (error) {
    console.error("[account/email-change]", error);
    return NextResponse.json(
      { success: false, error: customerSafeMessage(error, "Unable to change your email address") },
      { status: 400 },
    );
  }
}
