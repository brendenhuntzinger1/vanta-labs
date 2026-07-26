import { NextResponse } from "next/server";
import { createCheckoutSession, sanitizeCustomerInput } from "@/lib/payment-service";
import { detectRoleFromUser } from "@/lib/auth-role";
import { getAuthenticatedUser } from "@/lib/auth-session";
import type { CustomerInput } from "@/lib/payment-types";

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
    // Ambassador attribution is driven ONLY by the code the customer has
    // visibly applied at checkout (body.referralCode). We deliberately do NOT
    // fall back to the vl_referral_code cookie here: a cookie the shopper can't
    // see must never silently generate an ambassador commission. A referral
    // link still pre-fills the visible field client-side, so legitimate,
    // customer-confirmed attribution is unaffected.
    const referralCode = body.referralCode;

    const result = await createCheckoutSession({
      items: body.items,
      customer,
      referralCode,
      couponCode: body.couponCode,
      currency: body.currency,
      expectedTotal: body.expectedTotal,
      customerUserId,
      pointsToRedeem: customerUserId ? Number(body.pointsToRedeem ?? 0) : 0,
      shippingProtection: Boolean(body.shippingProtection),
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
    const raw = error instanceof Error ? error.message : "Unable to create checkout session";
    // Translate the internal underpayment-guard string into an actionable,
    // non-alarming message (it can trip on a stale membership/credit preview).
    const message = raw === "Altered total detected"
      ? "A discount on your order is no longer available, so your total has been updated. Please refresh this page to see the current total, then place your order."
      : raw;
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}
