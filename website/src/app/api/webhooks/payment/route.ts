import { NextResponse } from "next/server";
import { getRequiredEnv } from "@/lib/env";
import { processPaymentWebhook, WebhookSignatureError } from "@/lib/payment-webhook";
import { recordSystemAlert } from "@/lib/monitoring";

/**
 * At most one `payment_webhook_error` row per half hour while the condition
 * lasts. Long enough that a retry storm collapses to a single line, short
 * enough that a NEW failure the next time the cron sweep runs still lands.
 */
const PAYMENT_WEBHOOK_ALERT_DEDUPE_MS = 30 * 60 * 1000;

export async function POST(request: Request) {
  try {
    const payload = await request.text();

    // Two senders hit this route and they do not agree on headers:
    //
    //   • The internal/mock gateway sends `x-payment-signature` + `x-event-id`.
    //   • VeyraGate sends `veyragate-signature` and carries the event id in the
    //     BODY as `id` ("evt_…"); it sends no event-id header at all.
    //
    // Accepting both costs nothing — the signature still has to verify against the
    // same secret either way — and without it every real VeyraGate callback is
    // rejected at this guard before the signature is even checked, which means a
    // card is charged and the order never settles.
    const signature =
      request.headers.get("veyragate-signature") ??
      request.headers.get("x-payment-signature") ??
      "";

    // THE BODY WINS, AND THE ORDER IS THE WHOLE POINT.
    //
    // eventId is the primary key of payment_events and the sole argument to the
    // claimEvent dedupe. Neither signature scheme covers request headers — both
    // hash the body alone (payment-provider.ts verifyWebhookSignature /
    // verifyTimestampedSignature) — so an `x-event-id` header is attacker-chosen
    // on a captured-and-replayed delivery, and reading it FIRST let a replay
    // pick a fresh key and walk straight past the dedupe. The `id` inside the
    // payload is inside the HMAC, so it cannot be changed without breaking the
    // signature. Header stays as a fallback only for senders whose body carries
    // no id (the internal/mock gateway), which is exactly where it is safe:
    // those deliveries are still signature-checked over the same bytes.
    //
    // Parsed before verification only to READ an identifier — nothing is trusted
    // or acted on until processPaymentWebhook verifies the signature over these
    // exact bytes.
    let eventId = "";
    try {
      const parsed = JSON.parse(payload) as { id?: unknown };
      if (typeof parsed?.id === "string") {
        eventId = parsed.id;
      }
    } catch {
      // Not JSON — fall through to the header, then the guard below.
    }
    if (!eventId) {
      eventId = request.headers.get("x-event-id") ?? "";
    }

    if (!signature || !eventId) {
      return NextResponse.json(
        { success: false, error: "Missing required webhook headers." },
        { status: 400 },
      );
    }

    const webhookSecret = getRequiredEnv("PAYMENT_WEBHOOK_SECRET");

    const result = await processPaymentWebhook(payload, signature, webhookSecret, eventId);

    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    console.error("Payment webhook error", error);

    if (error instanceof Error && error.message.includes("Missing PAYMENT_WEBHOOK_SECRET")) {
      return NextResponse.json(
        { success: false, error: "Webhook configuration is missing on the server." },
        { status: 500 },
      );
    }

    // THIS ROUTE IS PUBLIC, AND `recordSystemAlert` WRITES A ROW.
    //
    // Every failure used to be recorded, signature failures included — so
    // anything on the internet could POST here in a loop and mint `system_alerts`
    // rows at whatever rate it liked, with no authentication and no ceiling.
    // Those rows then filled the ten-row window on /admin/status and buried the
    // criticals underneath them, which is the same storm this phase is clearing
    // up. A refused signature is not a fact about this store; it is a fact about
    // the internet, and the 400 below is the whole of the correct response.
    //
    // Everything past the signature check is different: the sender proved it
    // holds PAYMENT_WEBHOOK_SECRET, so a failure there means a real card event
    // may not have settled and is worth waking someone for.
    if (!(error instanceof WebhookSignatureError)) {
      await recordSystemAlert({
        type: "payment_webhook_error",
        severity: "warning",
        message: `A payment webhook failed to process: ${error instanceof Error ? error.message : "unknown error"}. If this coincides with a real order, that order may not have settled.`,
        // Second bound, and the one that holds even if a future edit lets an
        // unauthenticated path back through: a provider retrying a broken event
        // every few seconds is one problem, not three hundred rows.
        dedupeWindowMs: PAYMENT_WEBHOOK_ALERT_DEDUPE_MS,
      });
    }

    return NextResponse.json({ success: false, error: "Webhook processing failed" }, { status: 400 });
  }
}
