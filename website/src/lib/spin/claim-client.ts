"use client";

// ---------------------------------------------------------------------------
// THE PRIZE HAS TO REACH THE SECOND DEVICE, AND UNTIL NOW NOTHING FETCHED IT.
//
// /api/spin/claim was written for exactly this — its own header says "I span on
// my phone and now I'm on my laptop" and "safe to call on every cart view" —
// and then it was never called. A repo-wide search found one reference: the
// allowlist string in link-grant.ts. Meanwhile the wheel told the customer
//
//     "Saved to your account — it applies automatically at checkout,
//      on this device or any other."
//
// The prize lived only in the vl_offer cookie of the browser that span, so that
// sentence was false on every device but one.
//
// WHY THIS RUNS BEFORE /api/offer/status RATHER THAN INSIDE useOfferQuote.
//
// The obvious place looks like the quote hook, since the cart and the checkout
// both use it. It does not work there: the hook is gated on `active`, which the
// cart derives from /api/offer/status, which reads the very cookie that is
// missing on the second device. Claiming behind that gate would only ever run
// for someone who already had the prize. The claim has to come FIRST, and the
// status read after it, so the status sees the cookie the claim just set.
//
// ONCE PER PAGE LOAD. Claiming rotates a bearer token; it has no business
// repeating when a quantity changes or the cart and checkout both mount.
// ---------------------------------------------------------------------------

let settled = false;
let inFlight: Promise<boolean> | null = null;

/**
 * Put an already-won spin prize into this browser, if there is one to put.
 *
 * Resolves `true` only when a prize was actually claimed — i.e. when the caller
 * should re-read the offer status. Everything else resolves `false`:
 *
 *   * not signed in            — no verified identity to claim against
 *   * a live offer cookie already present — the route refuses to stomp it
 *   * nothing won, wheel off, or any failure at all
 *
 * Never rejects. A prize that cannot be claimed right now is a missing
 * discount, not a broken cart — the same posture the route itself takes.
 */
export async function claimSpinPrizeOnce(): Promise<boolean> {
  if (settled) return false;
  inFlight ??= fetch("/api/spin/claim", {
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
  })
    .then((response) => (response.ok ? response.json() : null))
    .then((data) => Boolean(data?.claimed))
    .catch(() => false)
    .finally(() => {
      settled = true;
    });
  return inFlight;
}

/** Test seam: the module-level latch would otherwise leak between cases. */
export function __resetSpinClaimForTests() {
  settled = false;
  inFlight = null;
}
