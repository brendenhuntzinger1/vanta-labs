import { NextResponse } from "next/server";
import { detectRoleFromUser } from "@/lib/auth-role";
import { getAuthenticatedUser } from "@/lib/auth-session";
import { createMembershipCheckoutSession, startMembershipSignup } from "@/lib/membership-billing";
import { isCheckoutOpen } from "@/lib/payment-provider";
import { customerSafeMessage } from "@/lib/safe-error";

export async function POST(request: Request) {
  const user = await getAuthenticatedUser();
  if (!user || detectRoleFromUser(user) !== "customer") {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => null) as {
    tierId?: string;
    billingCycle?: string;
    agreedToTerms?: boolean;
    /** BT token intent from the card panel. Presence selects the RECURRING lane. */
    tokenIntentId?: string;
    consentTextVersion?: string;
  } | null;

  if (!body?.tierId || (body.billingCycle !== "monthly" && body.billingCycle !== "annual")) {
    return NextResponse.json({ success: false, error: "Invalid request" }, { status: 400 });
  }

  if (body.agreedToTerms !== true) {
    return NextResponse.json({ success: false, error: "You must agree to the recurring billing terms to continue." }, { status: 400 });
  }

  try {
    // LANE 1 — recurring (Veyra). The card panel captured a card and minted a
    // token intent, so hand the whole subscription to Veyra: it takes the first
    // charge, vaults the card, and owns every renewal after this one.
    //
    // This lane exists because the hosted-checkout lane below is a ONE-TIME
    // sale. It charges once and flips the membership flag; month 2 never bills.
    // That is the same defect Refined shipped with and had to be re-ported off
    // (2026-07-16). Prefer this lane whenever a token intent is present.
    //
    // Note the price is NOT taken from the client — startMembershipSignup
    // resolves it from the tier row.
    if (typeof body.tokenIntentId === "string" && body.tokenIntentId.trim()) {
      const result = await startMembershipSignup({
        userId: user.id,
        tierId: body.tierId,
        billingCycle: body.billingCycle,
        tokenIntentId: body.tokenIntentId.trim(),
        ...(body.consentTextVersion ? { consentTextVersion: body.consentTextVersion } : {}),
      });
      if (!result.success) {
        // The charge did not land, so the member is past-due with no benefits.
        // Surface it as a failure rather than a cheerful success the shopper
        // would read as "you're a member now".
        return NextResponse.json(
          { success: false, error: "We couldn't complete that payment. Please try another card." },
          { status: 402 },
        );
      }
      return NextResponse.json({ success: true, recurring: true, chargeSucceeded: true });
    }

    // LANE 2 — legacy one-time hosted checkout. Left intact so nothing breaks
    // while the card panel rolls out, but it does NOT create a subscription.
    if (isCheckoutOpen()) {
      const session = await createMembershipCheckoutSession({ userId: user.id, tierId: body.tierId, billingCycle: body.billingCycle });
      return NextResponse.json({ success: true, checkoutUrl: session.hostedCheckoutUrl, orderId: session.orderId });
    }

    // LANE 3 — no processor configured. Records the intent, charges nothing.
    const result = await startMembershipSignup({ userId: user.id, tierId: body.tierId, billingCycle: body.billingCycle });
    return NextResponse.json({ success: true, chargeSucceeded: result.success });
  } catch (error) {
    return NextResponse.json({ success: false, error: customerSafeMessage(error, "Unable to start membership") }, { status: 400 });
  }
}
