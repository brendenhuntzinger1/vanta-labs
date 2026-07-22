import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createCheckoutSession, sanitizeCustomerInput } from "@/lib/payment-service";
import { detectRoleFromUser } from "@/lib/auth-role";
import { getAuthenticatedUser } from "@/lib/auth-session";
import type { CustomerInput } from "@/lib/payment-types";
import { checkRateLimit, rateLimitedResponseBody } from "@/lib/rate-limit";

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
    const ip = request.headers.get("x-forwarded-for")?.split(",")[0].trim() || request.headers.get("x-real-ip") || "unknown";
    const rl = await checkRateLimit({ action: "checkout_session", identifier: ip, limit: 12, windowSeconds: 60 });
    if (!rl.allowed) {
      return NextResponse.json(rateLimitedResponseBody(), { status: 429 });
    }

    const body = await request.json();

    if (!hasRequiredAcknowledgements(body.complianceAcknowledgements)) {
      return NextResponse.json(
        { success: false, error: "Required research and legal acknowledgements must be accepted." },
        { status: 400 },
      );
    }

    // Checkout requires a signed-in customer account — guest checkout is off.
    // Enforced server-side so it can't be bypassed by calling the API directly.
    const authenticatedUser = await getAuthenticatedUser();
    if (!authenticatedUser || detectRoleFromUser(authenticatedUser) !== "customer") {
      return NextResponse.json(
        { success: false, error: "Please sign in to your account to complete checkout." },
        { status: 401 },
      );
    }
    const customerUserId = authenticatedUser.id;

    const customer = sanitizeCustomerInput(body.customer as CustomerInput);
    // The order is always tied to the account's own email — this is the single
    // email used for confirmations, shipping, receipts, etc.
    if (authenticatedUser.email) {
      customer.email = authenticatedUser.email.trim().toLowerCase();
    }
    const cookieStore = await cookies();
    const referralFromCookie = cookieStore.get(REFERRAL_COOKIE_NAME)?.value;
    const referralCode = body.referralCode || referralFromCookie;

    const result = await createCheckoutSession({
      items: body.items,
      customer,
      referralCode,
      couponCode: body.couponCode,
      currency: body.currency,
      expectedTotal: body.expectedTotal,
      customerUserId,
      pointsToRedeem: customerUserId ? Number(body.pointsToRedeem ?? 0) : 0,
      paymentMethod: body.paymentMethod,
    });

    return NextResponse.json({
      success: true,
      orderId: result.orderId,
      orderNumber: result.orderNumber,
      hostedCheckoutUrl: result.hostedCheckoutUrl,
      paymentId: result.paymentId,
      status: result.status,
      paymentMethod: result.paymentMethod,
      isManualPayment: result.isManualPayment,
      total: result.total,
      cardProcessingFee: result.cardProcessingFee,
      cardProcessingFeePercent: result.cardProcessingFeePercent,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to create checkout session";
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}
