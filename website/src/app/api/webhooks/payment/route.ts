import { NextResponse } from "next/server";
import { processPaymentWebhook } from "@/lib/payment-webhook";

export async function POST(request: Request) {
  try {
    const payload = await request.text();
    const signature = request.headers.get("x-payment-signature") ?? "";
    const eventId = request.headers.get("x-event-id") ?? "";

    const result = await processPaymentWebhook(payload, signature, process.env.PAYMENT_WEBHOOK_SECRET ?? "", eventId);

    return NextResponse.json({ success: true, ...result });
  } catch (error) {
    console.error("Payment webhook error", error);
    return NextResponse.json({ success: false, error: "Webhook processing failed" }, { status: 400 });
  }
}
