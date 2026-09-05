import { NextResponse } from "next/server";
import { detectRoleFromUser } from "@/lib/auth-role";
import { getAuthenticatedUser } from "@/lib/auth-session";
import { startMembershipSignup } from "@/lib/membership-billing";
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
        // The signup names its own refusal when it has one — "your previous
        // subscription could not be closed", a legacy-lane refusal — and the
        // shopper was told to try another card for every one of them. A card
        // is not the fix for those.
        return NextResponse.json(
          { success: false, error: result.error?.trim() || "We couldn't complete that payment. Please try another card." },
          { status: 402 },
        );
      }
      const scheduledFor = (result as { scheduledFor?: string | null }).scheduledFor ?? null;
      return NextResponse.json({ success: true, recurring: true, chargeSucceeded: !scheduledFor, scheduledFor });
    }

    // NO SILENT ONE-TIME FALLBACK.
    //
    // This used to drop through to the hosted-checkout lane whenever the card
    // token was missing. That lane charges ONCE and stores no card, so the
    // shopper paid, saw "success", and owned a "subscription" that could never
    // renew — it simply lapsed at the end of the period with no notice and no
    // second payment. A real account was sold this way: an active monthly
    // membership with veyra_membership_id NULL, silently non-renewing.
    //
    // A membership is a recurring product by definition. If the card capture
    // did not produce a token intent, the correct outcome is a FAILED sale the
    // shopper can retry, not a successful charge for something that will not do
    // what they bought. Failing a sale is recoverable; taking money for a
    // broken subscription is not.
    console.error(
      `[membership] subscribe called without a card token for user ${user.id} — refusing rather than selling a non-renewing membership.`,
    );
    return NextResponse.json(
      {
        success: false,
        error: "We couldn't set up recurring billing for this membership. Please re-enter your card and try again, or contact support.",
      },
      { status: 400 },
    );
  } catch (error) {
    return NextResponse.json({ success: false, error: customerSafeMessage(error, "Unable to start membership") }, { status: 400 });
  }
}
