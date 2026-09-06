import { createHash, createHmac, timingSafeEqual } from "crypto";
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
//                   Events: email.bounced, email.complained, email.delivered,
//                           email.delivery_delayed, email.failed,
//                           email.opened, email.clicked
//                   AND Domains → <domain> → Open tracking ON. The webhook
//                   subscription alone sends nothing: Resend only emits
//                   email.opened for a domain whose tracking is enabled, so
//                   half the configuration looks identical to none of it.
//        SendGrid → Settings → Mail Settings → Event Webhook, same URL,
//                   Events: Bounced, Dropped, Spam Reports, Delivered,
//                           Opened, Clicked
//      Both store the full URL and send the query string back on every
//      delivery, so the secret travels with each request. A sender that can set
//      headers may use `x-email-webhook-secret` instead.
//
// Treat the URL as a credential: it appears in the provider's dashboard and
// delivery logs. Rotate by changing the env var and editing the webhook URL.
//
//   4. STRONGLY RECOMMENDED, and the reason step 3's secret is not enough on
//      its own: set RESEND_WEBHOOK_SIGNING_SECRET to the endpoint's signing
//      secret (Resend → Webhooks → the endpoint → Signing Secret, a value
//      beginning `whsec_`). Once it is set, every Resend delivery must carry a
//      valid Svix signature over its own body or it is refused.
//
//      Without it, authentication binds to the URL and NOTHING ELSE. The
//      signature covers no bytes, there is no timestamp window and no nonce, so
//      possession of the URL alone is full write access to the suppression
//      list: one forged `email.complained` per address lands an UNLIFTABLE
//      suppression and flips that customer's marketing preference off, and the
//      customer cannot undo it from their account page by design. Addresses are
//      guessable for any customer whose email is known. The URL is obtainable
//      from the Resend dashboard, a proxy or CDN access log, or a screenshot of
//      the webhook configuration — all places a query string is routinely
//      recorded. (Sentry is not one of them: `secret` is in
//      SENSITIVE_KEY_FRAGMENTS and scrubUrl redacts it.)
//
//      SendGrid has no equivalent signature here, so the shared secret remains
//      the only check for it.
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

/** How far a signed delivery's own timestamp may be from now. Svix's own default. */
const SIGNATURE_TOLERANCE_SECONDS = 5 * 60;

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

/**
 * Verify Resend's Svix signature over the RAW body.
 *
 * The signed content is `${id}.${timestamp}.${body}`, HMAC-SHA256 under the
 * endpoint secret (base64 after the `whsec_` prefix), and the header carries a
 * space-separated list of `v1,<base64>` candidates so a secret rotation can be
 * verified against either key.
 *
 * Answers "unsigned" when the delivery carries no Svix headers at all — that is
 * SendGrid, or a hand-made request, and the caller decides what to do with it
 * rather than this function silently passing it.
 */
function verifySvixSignature(
  headers: Headers,
  rawBody: string,
  signingSecret: string,
  nowMs: number,
): "ok" | "unsigned" | "bad-signature" | "stale" {
  const id = headers.get("svix-id") ?? headers.get("webhook-id");
  const timestamp = headers.get("svix-timestamp") ?? headers.get("webhook-timestamp");
  const signature = headers.get("svix-signature") ?? headers.get("webhook-signature");
  if (!id || !timestamp || !signature) return "unsigned";

  // A window, so a captured delivery cannot be replayed for ever.
  const sentSeconds = Number(timestamp);
  if (!Number.isFinite(sentSeconds)) return "bad-signature";
  if (Math.abs(nowMs / 1000 - sentSeconds) > SIGNATURE_TOLERANCE_SECONDS) return "stale";

  const key = signingSecret.startsWith("whsec_") ? signingSecret.slice("whsec_".length) : signingSecret;
  let secretBytes: Buffer;
  try {
    secretBytes = Buffer.from(key, "base64");
  } catch {
    return "bad-signature";
  }
  if (secretBytes.length === 0) return "bad-signature";

  const expected = createHmac("sha256", secretBytes)
    .update(`${id}.${timestamp}.${rawBody}`, "utf8")
    .digest();

  // `v1,<base64> v1,<base64>` — any one matching is enough.
  for (const candidate of signature.split(" ")) {
    const [version, value] = candidate.split(",");
    if (version !== "v1" || !value) continue;
    let provided: Buffer;
    try {
      provided = Buffer.from(value, "base64");
    } catch {
      continue;
    }
    if (provided.length === expected.length && timingSafeEqual(provided, expected)) return "ok";
  }
  return "bad-signature";
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

  // Read the body as TEXT first: a signature is over bytes, and re-serialising
  // a parsed object would not reproduce them.
  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch {
    return NextResponse.json({ error: "Invalid body." }, { status: 400 });
  }

  // BIND AUTHENTICATION TO THE PAYLOAD, when the operator has configured it.
  //
  // The shared secret above authenticates the URL and nothing else, so anyone
  // holding the URL can post any event for any address. With the signing secret
  // set, a Resend delivery must carry a valid Svix signature over its own body
  // and a timestamp inside a five-minute window, which also bounds replay.
  //
  // An UNSIGNED delivery still passes: SendGrid sends none, and this endpoint
  // supports both providers. That is why the URL secret stays as well rather
  // than being replaced.
  const signingSecret = (process.env.RESEND_WEBHOOK_SIGNING_SECRET ?? "").trim();
  if (signingSecret) {
    const verdict = verifySvixSignature(request.headers, rawBody, signingSecret, Date.now());
    if (verdict === "bad-signature" || verdict === "stale") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
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
    {
      received: events.length,
      suppressed: outcome.suppressed,
      ignored: outcome.ignored,
      // Opens and clicks that were matched back to a send. Reported because the
      // provider's dashboard shows the delivery attempt and this shows whether
      // it landed anywhere we can read it — the two disagreeing is the signal
      // that message-id capture has regressed.
      engaged: outcome.engaged,
    },
    { status: 200 },
  );
}
