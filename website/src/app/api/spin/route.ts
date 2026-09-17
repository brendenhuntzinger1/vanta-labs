import { NextResponse } from "next/server";

import { getRequestIpAddress } from "@/lib/admin-auth";
import { getSpinWheelConfig } from "@/lib/admin-control";
import { getAuthenticatedUser } from "@/lib/auth-session";
import { OFFER_COOKIE, OFFER_COOKIE_MAX_AGE_SECONDS, readOfferCookie, readOfferStatus } from "@/lib/offers/customer-offers";
import { checkRateLimit } from "@/lib/rate-limit";
import { describeRedemptionCondition } from "@/lib/spin/disclosure";
import { claimSpinForAccount } from "@/lib/spin/spin-claim";
import { spin } from "@/lib/spin/spin-service";
import { verifySpinToken } from "@/lib/spin/spin-token";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// SPINNING IS A POST, AND THAT IS NOT A REST FORMALITY.
//
// Corporate link rewriters — Outlook SafeLinks and its kind — FETCH the URLs in
// an email server-side before the recipient ever sees them, and antivirus
// gateways do the same. If opening the link span the wheel, a scanner would
// consume the customer's one and only spin, and they would arrive to find a
// prize already drawn by a machine. On a wheel where the result is permanent
// and the jackpot is a $119.99 vial, that is not a small bug.
//
// So: GET /spin renders and mints nothing. This POST is reached only by a
// deliberate press on the page. Nothing a mail scanner does can spend a spin.
// ---------------------------------------------------------------------------

/** One person, pressing a button, cannot need more than this. */
const SPIN_RATE_LIMIT = 10;
const SPIN_RATE_WINDOW_SECONDS = 600;

export async function POST(request: Request) {
  try {
    const config = await getSpinWheelConfig();
    if (!config.enabled) {
      // 404 rather than 403: while the promotion is off, the endpoint should
      // not confirm it exists.
      return NextResponse.json({ success: false, error: "Not found." }, { status: 404 });
    }

    const ip = getRequestIpAddress(request) ?? "unknown";
    const limit = await checkRateLimit(`spin:${ip}`, SPIN_RATE_LIMIT, SPIN_RATE_WINDOW_SECONDS);
    if (!limit.allowed) {
      const res = NextResponse.json({ success: false, error: "Too many attempts. Try again shortly." }, { status: 429 });
      res.headers.set("Retry-After", String(limit.retryAfterSeconds));
      return res;
    }

    const body = (await request.json().catch(() => ({}))) as { token?: string };
    const verified = await verifySpinToken(String(body.token ?? "").trim());
    if (!verified) {
      // One message for malformed, forged and expired alike — the difference is
      // only ever useful to somebody probing.
      return NextResponse.json({ success: false, error: "This link is no longer valid." }, { status: 400 });
    }

    // A LINK FROM A PREVIOUS CAMPAIGN IS NOT A SPIN IN THIS ONE.
    //
    // The campaign is inside the signed payload, so this cannot be forged — but
    // it can be genuine and stale. Honouring it would hand the recipient a
    // fresh one-live-offer slot under the current campaign key and let them
    // spin a promotion they were never mailed.
    if (verified.campaignId !== config.campaignId) {
      return NextResponse.json({ success: false, error: "This link is no longer valid." }, { status: 400 });
    }

    // WHOSE SPIN IS THIS?
    //
    // The address in the token is trustworthy — this server signed it — so an
    // anonymous visitor arriving from their own email spins as themselves.
    //
    // A SIGNED-IN VISITOR IS A STRONGER CLAIM, and a conflicting one is a
    // forwarded link. Refuse rather than guess: minting under the token's
    // address would bind the prize to an account this person cannot check out
    // as, and minting under the session's would spend a spin the recipient
    // never got. Neither is a prize anyone can use.
    const user = await getAuthenticatedUser();
    const sessionEmail = String(user?.email ?? "").trim().toLowerCase();
    if (sessionEmail && sessionEmail !== verified.email) {
      return NextResponse.json(
        { success: false, error: "This link belongs to a different account. Sign out, or open the link sent to this address." },
        { status: 409 },
      );
    }

    const result = await spin({ email: verified.email, campaignId: verified.campaignId });

    if (!result) {
      // A wheel that cannot mint must not look like one that can.
      return NextResponse.json({ success: false, error: "We couldn't save your prize. Please try again." }, { status: 503 });
    }

    // RE-OPENING THE EMAIL ON A SECOND DEVICE HAS TO ARM THAT DEVICE.
    //
    // spin() reports an already-won prize with offerToken: null — the token is
    // handed out ONLY on the call that minted it (spin-service.ts). So the
    // phone that span got the cookie and the laptop got a page showing a prize
    // it could not use. Under the email-link journey the visitor is anonymous,
    // so /api/spin/claim (session-only, by design) could not rescue them
    // either: the prize was simply unusable on every device but the first.
    //
    // THE TOKEN IS A GOOD ENOUGH IDENTITY FOR THIS, and the mint path a few
    // lines above already says why: "The address in the token is trustworthy —
    // this server signed it". Re-arming for the address this server signed is
    // exactly as safe as minting for it, which already happens here.
    //
    // ONLY WHEN THIS DEVICE HOLDS NOTHING. claimSpinForAccount rotates the
    // bearer token, which retires the copy on whatever device had it. Rotating
    // for a browser that is already armed would be pure harm — it would
    // invalidate the cookie this visitor is about to check out with — so a
    // device that already has a live offer is left completely alone, the same
    // guard /api/spin/claim applies.
    let rearmedToken: string | null = null;
    if (result.alreadySpun && !result.offerToken) {
      const heldHere = await readOfferStatus(readOfferCookie(request));
      if (!heldHere) {
        const reclaimed = await claimSpinForAccount({
          verifiedEmail: verified.email,
          campaignId: verified.campaignId,
        });
        rearmedToken = reclaimed?.offerToken ?? null;
      }
    }

    const response = NextResponse.json({
      success: true,
      alreadySpun: result.alreadySpun,
      sliceIndex: result.sliceIndex,
      prize: {
        id: result.prize.id,
        label: result.prize.label,
        wedgeLabel: result.prize.wedgeLabel,
        minSubtotalCents: result.prize.minSubtotalCents,
        condition: describeRedemptionCondition(result.prize),
      },
      // THE SAVED EXPIRY, not a duration for the client to start counting from.
      // A countdown seeded with "72 hours from now" restarts on every refresh
      // and is a different, longer promise each time it is read.
      expiresAt: result.expiresAt,
    });

    // The bearer secret goes into an httpOnly cookie and is never returned in
    // the body — no script on the page can read it, and it cannot leak through
    // a Referer header or a shared screenshot.
    // Either the token just minted, or the one re-issued above for a device
    // that opened the link second and was holding nothing.
    const cookieToken = result.offerToken ?? rearmedToken;
    if (cookieToken) {
      response.cookies.set({
        name: OFFER_COOKIE,
        value: cookieToken,
        httpOnly: true,
        // Lax, not Strict: the visitor arrives from their mail client, which is
        // a cross-site top-level navigation, and Strict drops the cookie on
        // exactly the hop this exists for.
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        path: "/",
        maxAge: OFFER_COOKIE_MAX_AGE_SECONDS,
      });
    }

    return response;
  } catch (error) {
    console.error("[spin] unable to complete the spin", error);
    return NextResponse.json({ success: false, error: "Something went wrong. Please try again." }, { status: 500 });
  }
}
