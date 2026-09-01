import { NextResponse } from "next/server";
import { verifyAdminSessionFromRequest } from "@/lib/admin-auth";
import { canManageSettings } from "@/lib/admin-roles";
import { checkRateLimit } from "@/lib/rate-limit";
import { sendTestPushNotification } from "@/lib/order-push-notification";

export const dynamic = "force-dynamic";

/**
 * "Send test notification" — the button beside the Pushover fields.
 *
 * WHY THIS EXISTS. A paid $94.96 order was announced to nothing: the push
 * destination had died and the only evidence was the absence of a notification,
 * which is indistinguishable from a quiet afternoon. The daily health check
 * catches a destination that goes bad later; this catches one that was never
 * right, at the moment the owner is looking at the fields and can fix it.
 *
 * It sends a REAL notification, because the question is "does it reach my
 * phone" and nothing short of a delivery answers that.
 *
 * A failure comes back in the response, not as a system alert — see
 * sendTestPushNotification. Someone is standing at the screen waiting for it.
 */
export async function POST(request: Request) {
  const session = await verifyAdminSessionFromRequest(request);
  if (!session) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }
  // Same capability that edits the fields: if you cannot change where
  // notifications go, you cannot make one go there.
  if (!canManageSettings(session.role)) {
    return NextResponse.json({ success: false, error: "Your role does not have permission to change store settings." }, { status: 403 });
  }

  // This is the one admin action whose whole purpose is to make a phone buzz.
  // Six an hour is more than enough to get a token right and few enough that a
  // stuck button, or a bored second admin, cannot turn the owner's phone into
  // an alarm.
  const rateLimit = await checkRateLimit(`push-test:${session.username}`, 6, 60 * 60);
  if (!rateLimit.allowed) {
    return NextResponse.json(
      { success: false, error: `Too many test notifications. Try again in ${Math.ceil(rateLimit.retryAfterSeconds / 60)} minute(s).` },
      { status: 429 },
    );
  }

  const result = await sendTestPushNotification();

  // 200 either way: the request was handled correctly, and the interesting
  // outcome is in the body. The client shows `detail` verbatim, which is how
  // "Pushover answered 400" reaches the person who can act on it.
  return NextResponse.json({
    success: result.sent,
    kind: result.kind,
    error: result.sent ? undefined : result.detail,
    message: result.sent
      ? result.kind === "pushover"
        ? "Sent through Pushover. Check your phone — if nothing arrives, the token is valid but the Pushover app is not installed or is muted."
        : "Sent to the webhook, which answered OK. Whether it reaches your phone now depends on what the webhook does with it."
      : undefined,
  });
}
