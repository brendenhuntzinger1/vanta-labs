import { NextResponse } from "next/server";

import { getSpinWheelConfig } from "@/lib/admin-control";
import { getAuthenticatedUser } from "@/lib/auth-session";
import { OFFER_COOKIE, OFFER_COOKIE_MAX_AGE_SECONDS, readOfferCookie, readOfferStatus } from "@/lib/offers/customer-offers";
import { describeRedemptionCondition } from "@/lib/spin/disclosure";
import { claimSpinForAccount } from "@/lib/spin/spin-claim";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// "I SPAN ON MY PHONE AND NOW I'M ON MY LAPTOP."
//
// The prize lives in an httpOnly cookie, so a second device has nothing. This
// puts it there, for a VERIFIED account only.
//
// IDENTITY COMES FROM THE SESSION AND NOWHERE ELSE. There is no email in the
// request body and no email read from the checkout form — getAuthenticatedUser
// verifies the session against the auth backend, and anything else would let a
// person claim somebody else's prize by typing their address.
//
// POST because it rotates a bearer token, which is a write. It is safe to call
// on every cart view: with a working cookie already present it does nothing.
// ---------------------------------------------------------------------------

export async function POST(request: Request) {
  try {
    const config = await getSpinWheelConfig();
    if (!config.enabled) {
      return NextResponse.json({ success: true, claimed: false });
    }

    const user = await getAuthenticatedUser();
    const verifiedEmail = String(user?.email ?? "").trim().toLowerCase();
    if (!verifiedEmail) {
      // Not signed in. This is the ordinary case for an anonymous shopper and
      // is not an error: they simply have no verified account to claim against.
      return NextResponse.json({ success: true, claimed: false });
    }

    // ALREADY HOLDING A LIVE OFFER? Do nothing. Rotating a working token would
    // invalidate the cookie this browser is about to check out with, and would
    // stomp a cart-recovery gift that has nothing to do with the wheel.
    const existing = await readOfferStatus(readOfferCookie(request));
    if (existing) {
      return NextResponse.json({ success: true, claimed: false, alreadyHeld: true });
    }

    const claimed = await claimSpinForAccount({
      verifiedEmail,
      campaignId: config.campaignId,
    });
    if (!claimed) {
      return NextResponse.json({ success: true, claimed: false });
    }

    const response = NextResponse.json({
      success: true,
      claimed: true,
      prize: {
        id: claimed.prize.id,
        label: claimed.prize.label,
        minSubtotalCents: claimed.prize.minSubtotalCents,
        condition: describeRedemptionCondition(claimed.prize),
      },
      // The stored instant, so a countdown on this device resumes where the
      // prize really is rather than restarting.
      expiresAt: claimed.expiresAt,
    });

    response.cookies.set({
      name: OFFER_COOKIE,
      value: claimed.offerToken,
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: OFFER_COOKIE_MAX_AGE_SECONDS,
    });

    return response;
  } catch (error) {
    // Never fail the page this is called from. A prize that cannot be claimed
    // right now is a missing discount, not a broken cart.
    console.error("[spin] claim failed", error);
    return NextResponse.json({ success: true, claimed: false });
  }
}
