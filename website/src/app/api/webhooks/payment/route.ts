import { NextResponse } from "next/server";
import { getRequiredEnv } from "@/lib/env";
import { processPaymentWebhook } from "@/lib/payment-webhook";
import { recordSystemAlert } from "@/lib/monitoring";

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

    // Fall back to the event id in the body when no header carries one. Parsed
    // before verification only to READ an identifier — nothing is trusted or acted
    // on until processPaymentWebhook verifies the signature over these exact bytes.
    let eventId = request.headers.get("x-event-id") ?? "";
    if (!eventId) {
      try {
        const parsed = JSON.parse(payload) as { id?: unknown };
        if (typeof parsed?.id === "string") {
          eventId = parsed.id;
        }
      } catch {
        // Not JSON — fall through to the missing-headers response below.
      }
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

    // Record a durable, dashboard-visible alert. Warning (not critical) so
    // routine bad-signature probes from the internet don't email the operator,
    // but a genuine settlement failure is still surfaced for review.
    await recordSystemAlert({
      type: "payment_webhook_error",
      severity: "warning",
      message: `A payment webhook failed to process: ${error instanceof Error ? error.message : "unknown error"}. If this coincides with a real order, that order may not have settled.`,
    });

    return NextResponse.json({ success: false, error: "Webhook processing failed" }, { status: 400 });
  }
}
