import { NextResponse } from "next/server";
import { createCheckoutSession, sanitizeCustomerInput } from "@/lib/payment-service";
import type { CustomerInput } from "@/lib/payment-types";

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const customer = sanitizeCustomerInput(body.customer as CustomerInput);

    const result = await createCheckoutSession({
      items: body.items,
      customer,
      referralCode: body.referralCode,
      currency: body.currency,
      expectedTotal: body.expectedTotal,
    });

    return NextResponse.json({
      success: true,
      orderId: result.orderId,
      hostedCheckoutUrl: result.hostedCheckoutUrl,
      paymentId: result.paymentId,
      status: result.status,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to create checkout session";
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}
