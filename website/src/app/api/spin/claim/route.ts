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
    // PAUSING THE WHEEL MUST NOT STRAND A PRIZE SOMEBODY ALREADY WON.
    //
    // This used to refuse while `enabled` was false, which made the kill switch
    // do two things at once: stop new spins (intended) and stop a legitimate
    // winner reaching their own prize from a second device (not). Someone who
    // span on their phone an hour before the wheel was paused would open their
    // laptop to nothing, with the prize sitting in customer_offers the whole
    // time — indistinguishable, to them, from having been taken away.
    //
    // ISSUING AND RETRIEVING ARE DIFFERENT ACTS, and only one of them is what
    // the switch is for. `claimSpinForAccount` cannot mint: it reads an
    // existing row for this verified address and rotates its bearer token, and
    // returns null when there is no such row. So a paused wheel still refuses
    // every new prize — /api/spin and /spin are where that is enforced, and
    // they keep their gate — while a prize that was already won stays
    // reachable for the 72 hours it was promised for.
    //
    // The config is still read, because `campaignId` is what scopes the claim
    // to this promotion rather than any spin the address has ever had.
    const config = await getSpinWheelConfig();

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
        // The row's rung, so a customer who chose the 30mg on their phone is
        // quoted $170 on their laptop rather than the table's entry $90.
        minSubtotalCents: claimed.minSubtotalCents,
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
