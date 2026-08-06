import { createHash, timingSafeEqual } from "crypto";
import { NextResponse } from "next/server";

import { applyTrackingUpdate } from "@/lib/shippo/service";
import type { ShippoWebhookPayload } from "@/lib/shippo/types";

// ---------------------------------------------------------------------------
// POST /api/webhooks/shippo — carrier tracking scans.
//
// AUTHENTICITY
// ------------
// Shippo does not sign webhook bodies the way Stripe does: there is no HMAC
// header to verify, so anyone who learns this URL could otherwise POST
// "DELIVERED" for any tracking number and mark orders delivered. The only
// control available is a shared secret carried in the URL (or a header), which
// is why one is REQUIRED here rather than optional.
//
// HOW THE OWNER CONFIGURES IT
// ---------------------------
//   1. Pick a long random value (e.g. `openssl rand -hex 32`).
//   2. Set it as SHIPPO_WEBHOOK_SECRET in the server environment (Vercel →
//      Project → Settings → Environment Variables) and redeploy. Until it is
//      set, this endpoint accepts nothing at all — it fails closed.
//   3. In Shippo → Settings → API → Webhooks → "Add webhook":
//        Event:    Track Updated
//        Mode:     Live (add a second one for Test if testing)
//        URL:      https://<site>/api/webhooks/shippo?secret=<the same value>
//      Shippo stores the full URL including the query string and sends it back
//      on every delivery, so the secret travels with each request.
//   4. Alternatively, if the sender can set headers, send it as
//      `x-shippo-webhook-secret` instead of in the URL.
//
// Treat the URL itself as a credential: it appears in Shippo's dashboard and in
// its delivery logs. Rotate by changing the env var and editing the webhook URL.
//
// WHAT THIS HANDLER GUARANTEES
// ----------------------------
//   * 401 for anything that does not present the secret, compared in CONSTANT
//     TIME so the value cannot be recovered a byte at a time.
//   * Idempotency is NOT implemented here — applyTrackingUpdate() owns the
//     dedupe (shippo_webhook_events keyed on the event's identity). A repeat
//     delivery therefore returns 200 with `duplicate: true`, because Shippo
//     retries anything that is not a 2xx and a duplicate is not worth retrying.
//   * Anything the service deliberately ignores (an unknown order, a stale
//     out-of-order scan, an event type we do not handle) is also a 200, for the
//     same reason: no number of retries will change the answer.
//   * A database failure is the ONE case that answers 5xx, so Shippo's retry
//     actually gets the event applied.
//   * Nothing from the payload is logged. The body carries a tracking number
//     and, on some events, address detail; none of it belongs in a log
//     aggregator, and neither does the secret.
// ---------------------------------------------------------------------------

const SECRET_HEADER = "x-shippo-webhook-secret";
const SECRET_QUERY_PARAM = "secret";

/**
 * Constant-time comparison.
 *
 * Both sides are hashed first so the buffers are always 32 bytes: timingSafeEqual
 * throws on a length mismatch, and that throw would itself leak the expected
 * secret's length. Hashing removes the length signal entirely.
 */
function secretsMatch(provided: string, expected: string): boolean {
  const providedDigest = createHash("sha256").update(provided, "utf8").digest();
  const expectedDigest = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(providedDigest, expectedDigest);
}

function unauthorized() {
  // No detail: an attacker probing this endpoint learns only that it exists.
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
}

export async function POST(request: Request) {
  const expected = (process.env.SHIPPO_WEBHOOK_SECRET ?? "").trim();
  if (!expected) {
    // Fail closed. An unconfigured secret must never mean "let everyone in" —
    // that is exactly how an order gets marked delivered by a stranger.
    console.error("SHIPPO_WEBHOOK_SECRET is not set; rejecting the Shippo webhook.");
    return NextResponse.json({ error: "Webhook is not configured." }, { status: 503 });
  }

  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return unauthorized();
  }

  const provided = (request.headers.get(SECRET_HEADER) ?? url.searchParams.get(SECRET_QUERY_PARAM) ?? "").trim();
  if (!provided || !secretsMatch(provided, expected)) {
    return unauthorized();
  }

  let payload: ShippoWebhookPayload;
  try {
    payload = (await request.json()) as ShippoWebhookPayload;
  } catch {
    // The sender is authenticated but sent something that is not JSON. Retrying
    // will not fix that, but it IS worth surfacing in Shippo's delivery log.
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  try {
    const result = await applyTrackingUpdate(payload);

    if (!result.ok) {
      // The service only fails this way on a storage error — the one case where
      // a Shippo retry can genuinely succeed. Its own message is not echoed
      // back; a webhook sender has no use for our internal detail.
      console.error("Shippo tracking update failed", result.code);
      return NextResponse.json({ error: "Could not process this event." }, { status: 500 });
    }

    const outcome = result.data;
    // Deliberately minimal: our own order id and the pipeline statuses. No
    // tracking number, no carrier reference, no address, no secret.
    return NextResponse.json({
      received: true,
      duplicate: outcome.duplicate,
      handled: outcome.handled,
      statusChanged: outcome.statusChanged,
      orderId: outcome.orderId,
      status: outcome.to,
      reason: outcome.reason ?? null,
    });
  } catch (error) {
    // applyTrackingUpdate returns typed results; anything thrown is unexpected.
    // 500 so the event is redelivered rather than silently lost — the dedupe
    // table makes that retry safe.
    console.error("Unexpected failure handling a Shippo tracking webhook", error);
    return NextResponse.json({ error: "Could not process this event." }, { status: 500 });
  }
}
