import { NextResponse } from "next/server";
import { recordOrderAttribution } from "@/lib/order-attribution";
import { attributeOrderToCampaign } from "@/lib/email/campaign-attribution";
import { readCampaignCookie } from "@/lib/email/campaign-links";
import { createCheckoutSession, sanitizeCustomerInput } from "@/lib/payment-service";
import { recordMarketingOptIn } from "@/lib/marketing-broadcast";
import { detectRoleFromUser } from "@/lib/auth-role";
import { getAuthenticatedUser } from "@/lib/auth-session";
import { isCheckoutOpen } from "@/lib/payment-provider";
import { checkRateLimit } from "@/lib/rate-limit";
import { customerSafeMessage } from "@/lib/safe-error";
import { getRequestIpAddress } from "@/lib/admin-auth";
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

    // Order creation is the most expensive public write on the site — each
    // success inserts an order + items and takes a timed inventory hold. Throttle
    // it (a real shopper places one order) to blunt order-spam and the
    // denial-of-inventory abuse of holding scarce stock in "reserved" via a
    // scripted loop. Keyed on the platform-trusted client IP; fails open.
    const ip = getRequestIpAddress(request) ?? "unknown";
    const rateLimit = await checkRateLimit(`create-session:${ip}`, 8, 60);
    if (!rateLimit.allowed) {
      const res = NextResponse.json(
        { success: false, error: "You're checking out too frequently. Please wait a moment and try again." },
        { status: 429 },
      );
      res.headers.set("Retry-After", String(rateLimit.retryAfterSeconds));
      return res;
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
      // Hard-pin to USD. All amounts are computed in USD; honoring a
      // client-supplied currency code (e.g. "mxn") while sending the USD
      // numeric amount would let a crafted request massively underpay.
      currency: "USD",
      expectedTotal: body.expectedTotal,
      customerUserId,
      pointsToRedeem: customerUserId ? Number(body.pointsToRedeem ?? 0) : 0,
      shippingProtection: Boolean(body.shippingProtection),
      paymentMethod: body.paymentMethod,
      idempotencyKey: typeof body.idempotencyKey === "string" ? body.idempotencyKey : undefined,
      billing: body.billing && typeof body.billing === "object"
        ? {
            fullName: String(body.billing.fullName ?? "").slice(0, 200),
            address: String(body.billing.address ?? "").slice(0, 300),
            city: String(body.billing.city ?? "").slice(0, 120),
            postalCode: String(body.billing.postalCode ?? "").slice(0, 20),
          }
        : undefined,
    });

    // If they opted into offers/coupons at checkout, add them (guest or account)
    // to the marketing list so promo announcements reach them. Fire-and-forget.
    if (body.marketingOptIn && customer.email) {
      void recordMarketingOptIn(customer.email, "checkout");
    }

    // Link the order to the campaign that produced it. Runs only after the
    // order exists, writes to its own table, and cannot throw — see
    // lib/order-attribution.ts. Nothing about the order, its totals or its
    // payment depends on the outcome.
    await recordOrderAttribution({ orderId: result.orderId, raw: body.attribution });

    // Same contract, different signal: credit the order to the email campaign
    // whose tracked link brought them here, if the click is still inside the
    // attribution window. Non-throwing by construction.
    await attributeOrderToCampaign({
      orderId: result.orderId,
      cookieValue: readCampaignCookie(request),
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
    // Shopper-actionable text (coupon rejected, item out of stock, referral
    // minimum) still reaches the customer verbatim. Anything that names the
    // processor, an env var or a database detail does not: an unconfigured
    // gateway used to answer a completed checkout with "Missing VEYRA_API_BASE
    // environment variable."
    console.error("[checkout/create-session]", error);
    return NextResponse.json(
      {
        success: false,
        error: customerSafeMessage(
          message,
          "We couldn't start checkout just now. No charge was made and no order was placed — please try again in a moment.",
        ),
      },
      { status: 400 },
    );
  }
}
