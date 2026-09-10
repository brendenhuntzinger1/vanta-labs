import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { describeUnavailable, type UnavailableLine } from "@/lib/inventory-reservation";

// ---------------------------------------------------------------------------
// THE SHOPPER'S OWN UNFINISHED ATTEMPT, REPORTED TO THEM AS A SOLD-OUT SHELF.
//
// Reproduced against the local harness on 2026-09-10. One dose, three units on
// the shelf, no holds. A signed-in shopper checks out two of them:
//
//   ATTEMPT A  HTTP 200  VL-E36B3737  pending_payment  hold: 2 units, active
//
// They do not finish — the iframe dies, they close the tab, they hit Back. The
// order stays pending_payment with a live fifteen-minute hold, which is correct:
// that hold is what stops the units being sold out from under a payment that
// may still settle. Then they return to /checkout and submit the same cart. The
// page mints a FRESH idempotency key on every submit (it nulls the ref just
// before redirecting to the pay page), so this is a new order, not a resume:
//
//   ATTEMPT B  HTTP 400
//     "we can't ship that many of BPC-157 10mg 5mg right now.
//      Please adjust your cart and try again."
//
// Every clause of that is wrong. We CAN ship that many — three are on the shelf.
// Adjusting the cart is not the fix; the cart is fine. And the one action that
// would actually work, going back to the payment page they already have, is not
// mentioned, because the message was written for a shelf that had genuinely run
// out and nothing ever distinguished the two cases.
//
// David and Andrew both made multiple attempts on 2026-09-08, which is exactly
// the shape that lands here.
//
// WHAT THIS FIX DOES NOT DO, DELIBERATELY
//
// It does not release the blocking hold. That was the obvious fix and it is not
// safe: a superseded pending_payment order can still settle minutes later (a
// stalled challenge, a late webhook — and payment_failed and canceled orders
// can both still reach paid, which is deliberate, because a real capture must
// never be lost). Hand its units to the retry and the shopper can end up with
// two paid orders for one purchase, or finalize_inventory_for_order finding no
// active hold and falling through to the fallback decrement on stock that is
// already spoken for. A truthful message costs nothing and risks nothing; that
// trade is the whole of this change.
//
// So the distinction is drawn from the shelf alone — on_hand versus available —
// and never from who owns the hold. No order is read, no email is matched, and
// a shopper cannot use this to learn anything about another shopper.
// ---------------------------------------------------------------------------

function line(overrides: Partial<UnavailableLine> = {}): UnavailableLine {
  return {
    slug: "bpc-157-10mg",
    variantId: "aaaaaaa1-0000-4000-8000-000000000002",
    quantity: 2,
    available: 1,
    onHand: 3,
    name: "BPC-157 10mg 5mg",
    ...overrides,
  };
}

describe("stock held by an unfinished checkout is not reported as sold out", () => {
  it("does not claim we cannot ship units that are sitting on the shelf", () => {
    // The exact harness case: three on hand, two held, two asked for.
    const message = describeUnavailable([line()]);
    expect(message).not.toMatch(/can't ship that many|cannot ship that many/i);
    expect(message).not.toMatch(/sold out/i);
  });

  it("says plainly that the units are held by a checkout still in flight", () => {
    expect(describeUnavailable([line()])).toMatch(/held by a (checkout|payment)[^.]*(finished|complete)/i);
  });

  it("points at the payment page the shopper already has, which is the only thing that works", () => {
    const message = describeUnavailable([line()]);
    expect(message).toMatch(/payment page/i);
    expect(message).toMatch(/back/i);
  });

  it("does not tell them to adjust a cart that is not the problem", () => {
    expect(describeUnavailable([line()])).not.toMatch(/adjust your cart/i);
  });

  it("still reassures them that nothing was charged", () => {
    expect(describeUnavailable([line()])).toMatch(/not been charged|no charge/i);
  });

  it("names the item, so a five-line cart does not become a guessing game", () => {
    expect(describeUnavailable([line()])).toContain("BPC-157 10mg 5mg");
  });

  it("treats a fully-held shelf the same way — that is where 'sold out' was most wrong", () => {
    // Every unit held, none sold. The old copy said "just sold out".
    const message = describeUnavailable([line({ quantity: 3, available: 0, onHand: 3 })]);
    expect(message).not.toMatch(/sold out/i);
    expect(message).toMatch(/held by a (checkout|payment)/i);
  });
});

describe("a genuinely empty shelf still says so", () => {
  it("keeps 'just sold out' when the units really are gone", () => {
    // on_hand 0 is a real sell-out: no hold is involved and no payment page
    // exists to go back to. Telling this shopper to check a payment page they
    // never opened would be the same defect pointing the other way.
    const message = describeUnavailable([line({ quantity: 2, available: 0, onHand: 0 })]);
    expect(message).toMatch(/just sold out/i);
    expect(message).toMatch(/adjust your cart/i);
    expect(message).not.toMatch(/held by/i);
  });

  it("keeps the short-shelf wording when the shelf itself is short", () => {
    // Two on hand, three asked for, nothing held. Editing the cart IS the fix.
    const message = describeUnavailable([line({ quantity: 3, available: 2, onHand: 2 })]);
    expect(message).toMatch(/can't ship that many/i);
    expect(message).toMatch(/adjust your cart/i);
  });

  it("degrades to the old wording when the shelf could not be read at all", () => {
    const message = describeUnavailable([line({ available: null, onHand: null })]);
    expect(message).toMatch(/no longer available/i);
    expect(message).not.toMatch(/null|undefined|NaN/);
  });

  it("reveals no more about a held shelf than it already did about a short one", () => {
    // Same privacy rule as the rest of this message: the wording must not vary
    // with HOW MANY units are held, or the refusal becomes a binary search for
    // the exact figure.
    const messages = [3, 4, 9, 50, 1000].map((onHand) =>
      describeUnavailable([line({ quantity: 2, available: 1, onHand })]),
    );
    expect(new Set(messages).size).toBe(1);
  });
});

describe("a mixed cart tells the truth about each line separately", () => {
  it("distinguishes a held line from a sold-out one in one sentence", () => {
    const message = describeUnavailable([
      line({ name: "BPC-157 10mg 5mg", quantity: 2, available: 1, onHand: 3 }),
      line({ name: "GHK-Cu 50mg", quantity: 1, available: 0, onHand: 0 }),
    ]);
    expect(message).toContain("BPC-157 10mg 5mg");
    expect(message).toContain("GHK-Cu 50mg");
    expect(message).toMatch(/held by/i);
    expect(message).toMatch(/sold out/i);
    // Both actions are offered, because both apply to this cart.
    expect(message).toMatch(/payment page/i);
    expect(message).toMatch(/adjust your cart/i);
  });
});

// ---------------------------------------------------------------------------
// AND IT HAS TO SURVIVE THE SANITISER.
//
// The first version of this fix was correct and the shopper never saw it.
// safe-error.ts rejects any message over 200 characters as a probable stack
// dump, so createCheckoutSession's plain `throw new Error(describeUnavailable())`
// was replaced by "We couldn't start checkout just now" — the generic fallback
// the whole message exists to avoid. Reproduced against the harness twice: once
// showing the old lie, once showing the fallback.
//
// The throw is a CustomerFacingError now, which safe-error passes through by
// design. These assertions pin both halves, because either one silently undoes
// the other.
// ---------------------------------------------------------------------------
describe("the message reaches the shopper instead of the generic fallback", () => {
  it("is thrown as text written for a person, not as a bare Error", () => {
    const source = readFileSync(join(process.cwd(), "src/lib/payment-service.ts"), "utf8");
    expect(source).toContain("throw new CustomerFacingError(describeUnavailable(reservation.unavailable))");
    expect(source).not.toContain("throw new Error(describeUnavailable(reservation.unavailable))");
  });

  it("passes the sanitiser verbatim rather than being swallowed", async () => {
    const { CustomerFacingError, customerSafeMessage } = await import("@/lib/safe-error");
    const message = describeUnavailable([line()]);
    const shown = customerSafeMessage(new CustomerFacingError(message), "We couldn't start checkout just now.");
    expect(shown).toBe(message);
  });

  it("names no vendor and leaks nothing technical, so the class is not papering over a leak", async () => {
    const { isCustomerSafeMessage } = await import("@/lib/safe-error");
    // Everything except the length rule must still hold on its own merits.
    const message = describeUnavailable([line()]);
    expect(isCustomerSafeMessage(message.slice(0, 200))).toBe(true);
    expect(message.toLowerCase()).not.toMatch(/veyra|postgres|supabase|reserved_quantity|inventory_quantity/);
  });

  it("stays short enough to read in a checkout error line", () => {
    // Not a safety rule — a UX one. This renders as one small paragraph under
    // the pay button, and a 400-character wall of text there is its own dead end.
    expect(describeUnavailable([line()]).length).toBeLessThan(280);
  });
});

// ---------------------------------------------------------------------------
// THE ROUTE THAT THREW THE CLASS AWAY.
//
// /api/checkout/create-session did `const raw = error.message` and then handed
// that STRING to customerSafeMessage. Every other one of the thirty-odd callers
// in the app passes the error object. The difference only shows when the text is
// long or trips a heuristic: customerSafeMessage returns a CustomerFacingError's
// message untouched, and a string can never be one, so the class was discarded
// one line before the check that reads it.
//
// That is why the held-stock message was written, thrown, and still replaced by
// "We couldn't start checkout just now" on the harness.
// ---------------------------------------------------------------------------
describe("the checkout route preserves an error written for the shopper", () => {
  const route = () => {
    return readFileSync(join(process.cwd(), "src/app/api/checkout/create-session/route.ts"), "utf8")
      // Comments only, stripped: the note explaining this defect quotes the
      // defective call, and a source grep that reads prose as code would pass
      // on a file that had been reverted.
      .split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  };

  it("hands the error to the sanitiser, not a string it extracted first", () => {
    expect(route()).toMatch(/customerSafeMessage\(\s*error,/);
    expect(route()).not.toMatch(/customerSafeMessage\(\s*message,/);
  });

  it("still translates the underpayment guard into something a shopper can act on", () => {
    // The one message that must NOT be passed through raw.
    expect(route()).toContain('raw === "Altered total detected"');
    expect(route()).toMatch(/your total has been updated/i);
  });

  it("still falls back for anything technical", () => {
    expect(route()).toMatch(/We couldn't start checkout just now/);
  });
});
