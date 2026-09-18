import { NextResponse } from "next/server";
import { getSmsSignupConfig } from "@/lib/admin-control";
import { getAuthenticatedUser } from "@/lib/auth-session";
import { claimWelcomeOffer, readWelcomeOffer, recordSmsSignupOnly } from "@/lib/offers/welcome-offer";
import { checkRateLimit } from "@/lib/rate-limit";
import { rateLimitKeyForRequest } from "@/lib/request-ip";

export const dynamic = "force-dynamic";

/**
 * THE TEXT-LIST SIGN-UP'S ONE ENDPOINT: what may I be shown (GET), and here is
 * my number (POST).
 *
 * WHOSE ADDRESS. A signed-in shopper's comes from the session and the body
 * cannot override it, so the invitation, the catalogue, product, cart and
 * account surfaces can never be pointed at somebody else. Only a guest at the
 * checkout may name an address, because a guest checkout is a real way to buy
 * here and the address they name is the one they are about to be charged
 * under.
 *
 * WHAT A GUEST IS TOLD. Nothing about the address. A guest claim answers "here
 * is your code" or "not available", never which of the refusals it was — the
 * /attest page's rule, for the same reason. A signed-in shopper is told
 * plainly, because it is their own account they are asking about. Both are
 * throttled per IP, which is what actually stops an address being probed.
 *
 * THE KILL SWITCH IS HONOURED HERE, NOT ONLY IN THE UI. With prompts off, a
 * ticked box still records the consent — that is how the list is built before
 * the carriers approve anything — and no code is minted and none is returned.
 * A discount handed out for a text nobody can send yet is a promise the store
 * cannot keep, and hiding the offer in the UI while the endpoint still mints
 * one is the kind of half-switch that leaks.
 *
 * MINTING IS A POST. The GET never mints, so no page render can start
 * somebody's fourteen days ticking.
 *
 * NEVER A CONDITION OF ANYTHING. A failure is answered 200 with `ok: false`
 * and leaves the checkout exactly as it was: the shopper still pays, their
 * consent is still recorded, they simply get no discount.
 */

export async function GET() {
  const config = await getSmsSignupConfig();
  const user = await getAuthenticatedUser();
  const email = user?.email?.trim().toLowerCase() ?? "";
  const shell = {
    promptsEnabled: config.promptsEnabled,
    dismissCooldownDays: config.dismissCooldownDays,
  };
  // NO SESSION IS NOT THE SAME AS NOT ELIGIBLE. A guest checkout is real here
  // and eligibility cannot be judged until they type an address, so the honest
  // answer is "unknown": the checkout may still offer, the storefront prompts
  // (which only ever render signed in) render nothing.
  if (!email) return NextResponse.json({ status: "unknown", mayInterrupt: false, ...shell });
  try {
    const offer = await readWelcomeOffer(email);
    // THE ADDRESS THE CODE WILL ACTUALLY GO TO. POST reads
    // `sessionEmail || typedEmail`, so for anyone with a session the field on
    // the card is discarded. Returning it lets the card show that plainly
    // instead of collecting an address it is going to ignore. It is the
    // caller's own address, returned to their own authenticated session.
    return NextResponse.json({ ...offer, ...shell, accountEmail: email });
  } catch {
    return NextResponse.json({ status: "unknown", mayInterrupt: false, ...shell });
  }
}

export async function POST(request: Request) {
  // Ten an hour from one address covers a shopper who mistypes their number a
  // few times and a household behind one router; it does not cover a script.
  const limit = await checkRateLimit(rateLimitKeyForRequest("welcome-offer", request), 10, 60 * 60);
  if (!limit.allowed) {
    return NextResponse.json(
      { ok: false, error: "Please wait a moment before trying again." },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } },
    );
  }

  let body: { phone?: unknown; email?: unknown; placement?: unknown };
  try {
    body = (await request.json()) as { phone?: unknown; email?: unknown; placement?: unknown };
  } catch {
    return NextResponse.json({ ok: false, error: "Enter a mobile number." }, { status: 400 });
  }

  const user = await getAuthenticatedUser();
  const sessionEmail = user?.email?.trim().toLowerCase() ?? "";
  const typedEmail = String(body.email ?? "").trim().toLowerCase();
  // The session wins whenever there is one; the body is read only for a guest.
  const email = sessionEmail || typedEmail;
  const phone = String(body.phone ?? "");
  // Which screen collected the tick, stored with the consent row. Anything
  // unrecognised is recorded as the storefront rather than trusted through.
  const source = body.placement === "checkout" ? "checkout" as const : "storefront" as const;
  if (!email) {
    // A storefront prompt has no email field, so "enter your email" would be
    // nonsense there. These surfaces only render for a signed-in shopper, so
    // the honest reading of no session AND no typed address is a session that
    // expired mid-visit.
    const message = source === "checkout"
      ? "Enter your email address first."
      : "Please sign in again to claim this offer.";
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }

  const config = await getSmsSignupConfig();

  try {
    if (!config.promptsEnabled) {
      // Consent only. Subscribed, no discount, and the caller is told so
      // rather than being left to wonder where the code went.
      const recorded = await recordSmsSignupOnly({ email, phone, source, userId: sessionEmail ? user?.id ?? null : null });
      if (recorded) return NextResponse.json({ ok: true, subscribed: true });
      return NextResponse.json({ ok: false, error: "That does not look like a mobile number." }, { status: 400 });
    }

    const claim = await claimWelcomeOffer({
      email,
      phone,
      source,
      userId: sessionEmail ? user?.id ?? null : null,
    });
    if (claim.ok) {
      return NextResponse.json({ ok: true, subscribed: true, code: claim.code, endsAt: claim.endsAt, percent: claim.percent });
    }
    if (claim.reason === "phone") {
      return NextResponse.json({ ok: false, error: "That does not look like a mobile number." }, { status: 400 });
    }
    // Subscribing still worked for a returning buyer; only the discount is
    // refused, and saying so is kinder than a flat "unavailable".
    if (claim.reason === "ineligible") {
      return NextResponse.json({
        ok: true,
        subscribed: true,
        error: sessionEmail ? "You are on the list. The welcome offer is for a first order." : undefined,
      });
    }
    return NextResponse.json({ ok: false, error: "This offer is not available right now." });
  } catch {
    return NextResponse.json({ ok: false, error: "This offer is not available right now." });
  }
}
