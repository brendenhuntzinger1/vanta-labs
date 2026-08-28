import { createHash, timingSafeEqual } from "crypto";
import { NextResponse } from "next/server";

import { applyDeliveryEvents, parseDeliveryEvents } from "@/lib/email/delivery-events";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// POST /api/webhooks/email — bounces and spam complaints from the email
// provider (E-08).
//
// WHY IT EXISTS. Suppression only ever grew from a person clicking unsubscribe.
// Nothing listened to the provider, so a hard-bouncing address stayed on every
// audience for ever and someone who hit "this is spam" kept receiving campaigns
// — the two behaviours that ruin a sending domain, and the first mail to suffer
// when it is ruined is receipts and password resets.
//
// HOW THE OWNER CONFIGURES IT
//   1. Pick a long random value (e.g. `openssl rand -hex 32`).
//   2. Set it as EMAIL_WEBHOOK_SECRET in the server environment (Vercel →
//      Project → Settings → Environment Variables) and redeploy. Until it is
//      set this endpoint accepts nothing — it fails closed.
//   3. Point the provider at it:
//        Resend   → Webhooks → Add: https://<site>/api/webhooks/email?secret=<value>
//                   Events: email.bounced, email.complained
//        SendGrid → Settings → Mail Settings → Event Webhook, same URL,
//                   Events: Bounced, Dropped, Spam Reports
//      Both store the full URL and send the query string back on every
//      delivery, so the secret travels with each request. A sender that can set
//      headers may use `x-email-webhook-secret` instead.
//
// Treat the URL as a credential: it appears in the provider's dashboard and
// delivery logs. Rotate by changing the env var and editing the webhook URL.
//
// WHAT IT ANSWERS
//   * 401 to anything without the secret, compared in CONSTANT TIME.
//   * 200 to a body it understands, and to one it does not — an unrecognised
//     shape will not become recognisable on a retry.
//   * 5xx only when a suppression write FAILED, so the provider's retry gets
//     the suppression actually applied. That is the one case where retrying
//     changes the outcome.
//   * Nothing from the payload is logged. It carries customer email addresses.
// ---------------------------------------------------------------------------

const SECRET_HEADER = "x-email-webhook-secret";
const SECRET_QUERY_PARAM = "secret";

/**
 * Constant-time comparison. Both sides are hashed first so the buffers are
 * always 32 bytes: timingSafeEqual throws on a length mismatch, and that throw
 * would itself leak the expected secret's length.
 */
function secretsMatch(provided: string, expected: string): boolean {
  return timingSafeEqual(
    createHash("sha256").update(provided, "utf8").digest(),
    createHash("sha256").update(expected, "utf8").digest(),
  );
}

export async function POST(request: Request) {
  const expected = (process.env.EMAIL_WEBHOOK_SECRET ?? "").trim();
  if (!expected) {
    // Fail closed. An unconfigured secret must never mean "let everyone in" —
    // this endpoint can suppress any address from marketing, so an open one
    // would let a stranger quietly unsubscribe a customer list.
    console.error("EMAIL_WEBHOOK_SECRET is not set; rejecting the email delivery webhook.");
    return NextResponse.json({ error: "Webhook is not configured." }, { status: 503 });
  }

  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const provided = (request.headers.get(SECRET_HEADER) ?? url.searchParams.get(SECRET_QUERY_PARAM) ?? "").trim();
  if (!provided || !secretsMatch(provided, expected)) {
    // No detail: a prober learns only that the endpoint exists.
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const events = parseDeliveryEvents(body);
  if (events.length === 0) {
    return NextResponse.json({ received: 0, suppressed: 0 }, { status: 200 });
  }

  const outcome = await applyDeliveryEvents(events);

  if (outcome.writeFailed) {
    // Ask for a redelivery: unlike an unknown payload, this one WILL succeed on
    // a retry, and the cost of not retrying is continuing to mail an address
    // that bounced or complained.
    return NextResponse.json(
      { received: events.length, suppressed: outcome.suppressed, error: "Could not record every event." },
      { status: 503 },
    );
  }

  return NextResponse.json(
    { received: events.length, suppressed: outcome.suppressed, ignored: outcome.ignored },
    { status: 200 },
  );
}
