import { NextResponse } from "next/server";
import { getRequiredEnv } from "@/lib/env";
import { processPaymentWebhook } from "@/lib/payment-webhook";
import { recordSystemAlert } from "@/lib/monitoring";

export async function POST(request: Request) {
  try {
    const payload = await request.text();
    const signature = request.headers.get("x-payment-signature") ?? "";
    const eventId = request.headers.get("x-event-id") ?? "";

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
