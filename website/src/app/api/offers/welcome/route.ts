import { NextResponse } from "next/server";
import { getSmsSignupConfig } from "@/lib/admin-control";
import { getAuthenticatedUser } from "@/lib/auth-session";
import { claimWelcomeOffer, readWelcomeOffer, recordPhoneWithoutConsent, recordSmsSignupOnly } from "@/lib/offers/welcome-offer";
import { checkRateLimit } from "@/lib/rate-limit";
import { rateLimitKeyForRequest } from "@/lib/request-ip";
import { phoneOnFileFor } from "@/lib/sms-consent";

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
 *
 * CONSENT IS SAID, NOT INFERRED FROM A NUMBER BEING PRESENT.
 *
 * It used to be inferred, and that was safe only while the sole reason to send
 * a phone number here was a ticked box. The wheel broke that: it collects a
 * number from everybody, because having somebody's number and being allowed to
 * text it are different facts and the store wants the first without claiming
 * the second.
 *
 * So the body now carries `smsConsent`, and ONLY an explicit `true` records a
 * consent. Anything else — false, absent, a string, a number — stores the
 * phone against the customer and subscribes nobody. That direction is
 * deliberate: a caller that forgets the field under-claims, and the failure
 * mode of under-claiming is a subscriber the store has to ask again, while the
 * failure mode of over-claiming is a text message to somebody who never agreed.
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
  const user = await getAuthenticatedUser();
  const sessionEmail = user?.email?.trim().toLowerCase() ?? "";

  // TEN AN HOUR, COUNTED AGAINST THE SHOPPER WHERE THERE IS ONE.
  //
  // It used to be counted against the request IP for everybody, and the
  // comment here said that covered "a household behind one router". It does
  // not cover the NAT a mobile carrier puts thousands of phones behind, and
  // most of this store's traffic is mobile. MEASURED on the harness: with ten
  // hits already on `welcome-offer:127.0.0.1`, the next shopper opened the
  // invitation, entered a number, pressed Spin, was told "Please wait a moment
  // before trying again", never reached /spin and minted nothing — a hard stop
  // on the store's acquisition funnel caused by other people's traffic.
  //
  // A signed-in caller is therefore counted as themselves, which is the thing
  // the limit is actually about: one person retyping a number they keep
  // getting wrong. The storefront invitation only renders for a session, so
  // that is its whole population. A guest — the checkout form — is still
  // counted by IP, because there is nothing else to count them by until they
  // have given an address, and enumeration there is the case IP-keying is for.
  const limit = await checkRateLimit(
    sessionEmail ? `welcome-offer-account:${sessionEmail}` : rateLimitKeyForRequest("welcome-offer", request),
    10,
    60 * 60,
  );
  if (!limit.allowed) {
    return NextResponse.json(
      { ok: false, error: "Please wait a moment before trying again." },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSeconds) } },
    );
  }

  let body: { phone?: unknown; email?: unknown; placement?: unknown; smsConsent?: unknown };
  try {
    body = (await request.json()) as { phone?: unknown; email?: unknown; placement?: unknown; smsConsent?: unknown };
  } catch {
    return NextResponse.json({ ok: false, error: "Enter a mobile number." }, { status: 400 });
  }
  // Strictly `true`. Every other value, including the field being missing,
  // means the number is kept and nobody is subscribed.
  const smsConsent = body.smsConsent === true;

  const typedEmail = String(body.email ?? "").trim().toLowerCase();
  // The session wins whenever there is one; the body is read only for a guest.
  const email = sessionEmail || typedEmail;
  const typedPhone = String(body.phone ?? "").trim();
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

  // A TICK WITH NOTHING TYPED IS THE COMMON CASE, NOT AN EMPTY FORM.
  //
  // The wheel stops asking for a number once the store holds one, so anybody
  // who has checked out before ticks the box with the field absent. The number
  // that tick subscribes is the store's own, read here rather than accepted
  // from the body — the body can never name a number the caller does not
  // already have.
  //
  // Only a CONSENT reaches for it. An untouched box with nothing typed has
  // given nothing and agreed to nothing, and re-filing a number the store
  // already holds would write a fresh collection date over a real one.
  const phone = typedPhone || (smsConsent ? (await phoneOnFileFor(email)) ?? "" : "");
  if (smsConsent && !phone) {
    // The card hid its phone field because the store was believed to hold a
    // number. It does not. `needPhone` is what reopens the field, so the
    // shopper has somewhere to answer rather than an instruction they cannot
    // follow — and the consent is refused rather than recorded against nothing.
    return NextResponse.json(
      { ok: false, needPhone: true, error: "Enter your mobile number to get texts." },
      { status: 400 },
    );
  }

  try {
    // NO TICK: KEEP THE NUMBER, SUBSCRIBE NOBODY.
    //
    // This is the wheel's path and it is the common one. The number lands on
    // the consent ledger and the account profile with marketing_consent false,
    // reads as "none" to every standing check, and reaches Omnisend as a
    // nonSubscribed phone identifier — so the day an explicit tick arrives, it
    // is the same number changing status rather than a new one being
    // collected.
    if (!smsConsent) {
      const stored = await recordPhoneWithoutConsent({ email, phone, source, userId: sessionEmail ? user?.id ?? null : null });
      if (stored) return NextResponse.json({ ok: true, subscribed: false, phoneStored: true });
      return NextResponse.json({ ok: false, error: "That does not look like a mobile number." }, { status: 400 });
    }

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
      // NO CODE IS THE NORMAL ANSWER NOW. The welcome discount is retired, so a
      // successful sign-up subscribes and returns nothing to redeem. The `code`
      // keys stay in the shape only for a customer who still holds a live one
      // from before the retirement — dropping them would strand that code where
      // the caller expects to print it.
      if ("subscribedOnly" in claim) {
        return NextResponse.json({ ok: true, subscribed: true });
      }
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
