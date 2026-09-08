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
//   4. REQUIRED, NOT OPTIONAL: set RESEND_WEBHOOK_SIGNING_SECRET to the
//      endpoint's signing secret (Resend → Webhooks → the endpoint → Signing
//      Secret, a value beginning `whsec_`). Every delivery must carry a valid
//      Svix signature over its own body, inside a five-minute window, or it is
//      refused. Until it is set this endpoint answers 503 and Resend
//      redelivers, so no event is lost while it is being configured.
//
//      This used to say "strongly recommended", and the code matched that
//      wording rather than the risk: a delivery carrying NO Svix headers was
//      accepted whether or not the secret was set. So the recommendation
//      protected nothing — an attacker holding the URL omitted the headers
//      rather than forging them.
//
//      What the URL alone was worth: one forged `email.complained` per address
//      lands an UNLIFTABLE suppression and flips that customer's marketing
//      preference off, and the customer cannot undo it from their account page
//      by design. Addresses are guessable for any customer whose email is
//      known. The URL is obtainable from the Resend dashboard, a proxy or CDN
//      access log, or a screenshot of the webhook configuration — all places a
//      query string is routinely recorded. (Sentry is not one of them:
//      `secret` is in SENSITIVE_KEY_FRAGMENTS and scrubUrl redacts it.)
//
//      Prefer a header to the query string where the provider allows one:
//      `x-email-webhook-secret` is accepted and keeps the value out of every
//      access log on the path.
//
//      SENDGRID IS NOT USABLE HERE UNTIL SOMEBODY IMPLEMENTS ITS SIGNATURE.
//      It sends no Svix headers, and this file has no ECDSA verifier for the
//      ones it does send, so a SendGrid delivery is now refused. That is the
//      correct order: a provider whose payloads cannot be authenticated should
//      not be able to write to the suppression list. The store runs Resend.
//
// WHAT IT ANSWERS
//   * 503 when either secret is unconfigured — retryable, because it is our
//     fault and the provider redelivers.
//   * 401 to anything without the URL secret, compared in CONSTANT TIME, and to
//     anything whose Svix signature is absent, wrong, or outside the window.
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

  // AUTHENTICATION IS BOUND TO THE PAYLOAD. THIS IS THE ACTUAL BOUNDARY.
  //
  // WHAT WAS WRONG. This block used to read:
  //
  //     if (signingSecret) {
  //       const verdict = verifySvixSignature(...);
  //       if (verdict === "bad-signature" || verdict === "stale") return 401;
  //     }
  //
  // `unsigned` — a request carrying no Svix headers at all — fell straight
  // through and was ACCEPTED. So the signature check stopped nobody: an
  // attacker holding the URL did not have to forge a signature, they simply
  // omitted the headers. Setting RESEND_WEBHOOK_SIGNING_SECRET bought exactly
  // nothing against the one attacker it was added for, and the comment here
  // said it was "strongly recommended" while the code made it decorative.
  //
  // WHAT THAT WAS WORTH TO AN ATTACKER. delivery-events.ts turns
  // `email.complained` into a row in `email_suppressions`, and
  // suppression-reasons.ts classes `complained` and `bounced` as
  // PROVIDER_IMPOSED_SUPPRESSION_REASONS — which the customer cannot lift from
  // their own account page. One forged POST per address permanently removes
  // that customer from every marketing send, and addresses are guessable for
  // anyone whose email is known. The URL itself carries its secret in a query
  // string, so it is recorded in the provider dashboard, in CDN and proxy
  // access logs, and in any screenshot of the webhook configuration.
  //
  // WHY THE CARVE-OUT IS GONE. It existed for SendGrid, which sends no Svix
  // headers. But this endpoint implements no SendGrid verifier either, so an
  // unsigned "SendGrid" delivery could not be authenticated by anything except
  // the URL — which is the vulnerability, not a feature. The store runs Resend
  // (admin_control_current: email.provider = 'resend'), so the carve-out was
  // paying full price for a provider that is not in use. Moving to SendGrid
  // would mean implementing its ECDSA verification here first; that is the
  // correct order, and it is now the only order available.
  //
  // WHAT IS REQUIRED NOW, and each half is load-bearing:
  //
  //   * A VALID SVIX SIGNATURE over the raw bytes of THIS body, under the
  //     endpoint's own signing secret. Covers tampering and forgery.
  //   * A TIMESTAMP INSIDE THE WINDOW. Covers replay of a captured delivery —
  //     the signature alone would verify forever.
  //   * THE URL SECRET, still, checked first and in constant time. Cheap, and
  //     it means a prober without it never reaches the HMAC at all.
  //
  // FAIL CLOSED WHEN UNCONFIGURED, exactly as the URL secret above does. An
  // endpoint that can suppress any customer must not be reachable on a
  // half-configured deployment. 503 rather than 401 because it is OUR fault
  // and it IS retryable: Resend redelivers a 5xx, so events that arrive during
  // a misconfiguration are not lost — they land once the secret is set.
  const signingSecret = (process.env.RESEND_WEBHOOK_SIGNING_SECRET ?? "").trim();
  if (!signingSecret) {
    console.error(
      "[email-webhook] REFUSED: RESEND_WEBHOOK_SIGNING_SECRET is not set, so no delivery can be "
      + "authenticated against its own payload. Set it from Resend → Webhooks → the endpoint → "
      + "Signing Secret (it begins whsec_) and redeploy. Deliveries are answered 503 until then, "
      + "so the provider will redeliver them.",
    );
    return NextResponse.json({ error: "Webhook signature verification is not configured." }, { status: 503 });
  }

  const verdict = verifySvixSignature(request.headers, rawBody, signingSecret, Date.now());
  if (verdict !== "ok") {
    // OBSERVABLE, AND IT NAMES NOTHING SECRET. The verdict says which rule was
    // broken; the body, the addresses it contains, the secrets and the
    // signature itself are all absent. Without this line a rejected delivery is
    // indistinguishable from one that never arrived, which is the same
    // ambiguity email_delivery_events exists to remove.
    console.error("[email-webhook] refused a delivery", {
      verdict,
      // Bounded, and it is the provider's own opaque id — not customer data.
      // It is what makes one refusal findable in Resend's own delivery log.
      svixId: (request.headers.get("svix-id") ?? request.headers.get("webhook-id") ?? "").slice(0, 64),
    });
    // The response says nothing beyond "no". A prober learns only that the
    // endpoint exists — the same rule the URL-secret check above follows.
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
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
