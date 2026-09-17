import { NextResponse } from "next/server";
import { getAuthenticatedUser } from "@/lib/auth-session";
import { claimWelcomeOffer, readWelcomeOffer } from "@/lib/offers/welcome-offer";
import { checkRateLimit } from "@/lib/rate-limit";
import { rateLimitKeyForRequest } from "@/lib/request-ip";

export const dynamic = "force-dynamic";

/**
 * THE WELCOME OFFER'S ONE ENDPOINT: what may I be shown (GET), and here is my
 * number, give me the code (POST).
 *
 * WHOSE ADDRESS. A signed-in shopper's address comes from the session and the
 * body cannot override it, so the catalogue, product, cart and account
 * surfaces can never be pointed at somebody else. Only a guest at the
 * checkout may name an address, because a guest checkout is a real way to buy
 * here (a cart-recovery link opens one) and the address they name is the one
 * they are about to be charged under.
 *
 * WHAT A GUEST IS TOLD. Nothing about the address. A guest claim answers
 * "here is your code" or "not available", and never says which of "already a
 * customer", "refused" or "unlucky" it was — the /attest page's rule, for the
 * same reason. A signed-in shopper is told plainly, because it is their own
 * account they are asking about. Both are throttled per IP, which is what
 * actually stops an address being probed at scale.
 *
 * MINTING IS A POST. The GET never mints, so no page render can start
 * somebody's fourteen days ticking; the clock begins when they ask.
 *
 * NEVER A CONDITION OF ANYTHING. A failure here is answered 200 with
 * `ok: false` for the claim and leaves the checkout exactly as it was: the
 * shopper still pays, still gets the box they ticked recorded, and simply
 * does not get a discount. No purchase path may fail over this.
 */

export async function GET() {
  const user = await getAuthenticatedUser();
  const email = user?.email?.trim().toLowerCase() ?? "";
  if (!email) return NextResponse.json({ status: "ineligible" });
  try {
    return NextResponse.json(await readWelcomeOffer(email));
  } catch {
    return NextResponse.json({ status: "ineligible" });
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
  if (!email) return NextResponse.json({ ok: false, error: "Enter your email address first." }, { status: 400 });

  try {
    const claim = await claimWelcomeOffer({
      email,
      phone,
      source,
      userId: sessionEmail ? user?.id ?? null : null,
    });
    if (claim.ok) {
      return NextResponse.json({ ok: true, code: claim.code, endsAt: claim.endsAt, percent: claim.percent });
    }
    if (claim.reason === "phone") {
      return NextResponse.json({ ok: false, error: "That does not look like a mobile number." }, { status: 400 });
    }
    // Everything else is one answer for a guest, and the plain truth for
    // someone asking about their own account.
    const error = sessionEmail && claim.reason === "ineligible"
      ? "The welcome offer is for a first order."
      : "This offer is not available right now.";
    return NextResponse.json({ ok: false, error });
  } catch {
    return NextResponse.json({ ok: false, error: "This offer is not available right now." });
  }
}
