import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createCheckoutSession, sanitizeCustomerInput } from "@/lib/payment-service";
import type { CustomerInput } from "@/lib/payment-types";

const REFERRAL_COOKIE_NAME = "vl_referral_code";

function hasRequiredAcknowledgements(value: unknown) {
  if (!value || typeof value !== "object") {
    return false;
  }

  const acknowledgements = value as Record<string, unknown>;

  return (
    acknowledgements.researchResponsibility === true &&
    acknowledgements.researchCompliance === true &&
    acknowledgements.ageLegalConfirmation === true
  );
}

export async function POST(request: Request) {
  try {
    const body = await request.json();

    if (!hasRequiredAcknowledgements(body.complianceAcknowledgements)) {
      return NextResponse.json(
        { success: false, error: "Required research and legal acknowledgements must be accepted." },
        { status: 400 },
      );
    }

    const customer = sanitizeCustomerInput(body.customer as CustomerInput);
    const cookieStore = await cookies();
    const referralFromCookie = cookieStore.get(REFERRAL_COOKIE_NAME)?.value;
    const referralCode = body.referralCode || referralFromCookie;

    const result = await createCheckoutSession({
      items: body.items,
      customer,
      referralCode,
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
