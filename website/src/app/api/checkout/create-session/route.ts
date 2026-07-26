import { NextResponse } from "next/server";
import { createCheckoutSession, sanitizeCustomerInput } from "@/lib/payment-service";
import { recordMarketingOptIn } from "@/lib/marketing-broadcast";
import { detectRoleFromUser } from "@/lib/auth-role";
import { getAuthenticatedUser } from "@/lib/auth-session";
import { isCheckoutOpen } from "@/lib/payment-provider";
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
    // HARD SAFETY GATE: never create an order the store can't actually charge.
    // Until a real payment path is live (CHECKOUT_ENABLED=true, or the mock
    // gateway in dev), refuse checkout BEFORE any order row is written — no
    // orphan orders, no false "confirmed" state. Browsing/cart/accounts are
    // unaffected; only order creation is gated.
    if (!isCheckoutOpen()) {
      return NextResponse.json(
        {
          success: false,
          error: "Checkout is opening soon — we're finalizing secure payment setup. No charge was made and no order was placed. Please check back shortly.",
          checkoutClosed: true,
        },
        { status: 503 },
      );
    }

    const body = await request.json();

    if (!hasRequiredAcknowledgements(body.complianceAcknowledgements)) {
      return NextResponse.json(
        { success: false, error: "Required research and legal acknowledgements must be accepted." },
        { status: 400 },
      );
    }

    // Guest checkout is allowed. A signed-in customer's order is tied to their
    // account (and locked to the account email); a guest checks out with just
    // the email they enter. Account-only perks (points, store credit) are gated
    // on customerUserId below, so guests simply can't use them.
    const authenticatedUser = await getAuthenticatedUser();
    const isCustomer = Boolean(authenticatedUser) && detectRoleFromUser(authenticatedUser!) === "customer";
    const customerUserId = isCustomer ? authenticatedUser!.id : undefined;

    const customer = sanitizeCustomerInput(body.customer as CustomerInput);
    // A signed-in customer's order always uses their account email (the single
    // email for confirmations/receipts); a guest uses the email they entered.
    if (isCustomer && authenticatedUser!.email) {
      customer.email = authenticatedUser!.email.trim().toLowerCase();
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

    // If they opted into offers/coupons at checkout, add them (guest or account)
    // to the marketing list so promo announcements reach them. Fire-and-forget.
    if (body.marketingOptIn && customer.email) {
      void recordMarketingOptIn(customer.email, "checkout");
    }

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
