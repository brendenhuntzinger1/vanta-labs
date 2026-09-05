import { describe, expect, it } from "vitest";

import { describeCouponOutcome } from "@/lib/discount-resolution";

// ---------------------------------------------------------------------------
// A COUPON THAT DID NOT LOWER THE PRICE MUST NOT CLAIM IT DID.
//
// Reproduced in the browser. Cart: 8 vials at the 12% bundle tier, $344.96.
// Entering HARNESS10 (10% off) produced, in green:
//
//     "Coupon applied."
//     "HARNESS10 · 10% off"
//     "Remove code"
//
// ...while the total stayed at $344.96, because 12% off $392.00 ($344.96)
// beats 10% off ($352.80). The PRICING IS CORRECT -- the engine kept the
// better discount, exactly as designed. The copy is what lies: the customer is
// told a 10% coupon was applied to an order it did not reduce by a cent.
//
// The only hint was a generic "Your best available discount was applied
// automatically" line rendered elsewhere in the summary, which never names the
// coupon and never says the coupon lost.
//
// So: say which discount actually controls the price, by name.
// ---------------------------------------------------------------------------

describe("a coupon that wins says so plainly", () => {
  it("confirms the coupon when it is the discount controlling the price", () => {
    const outcome = describeCouponOutcome({
      code: "HARNESS10",
      offerLabel: "10% off",
      winnerType: "coupon",
      winnerLabel: "Promo code HARNESS10",
    });

    expect(outcome.controlsPrice).toBe(true);
    expect(outcome.message).toContain("HARNESS10");
    expect(outcome.message).toContain("10% off");
    expect(outcome.message).toMatch(/applied/i);
  });

  it("still confirms a winning coupon that has no offer label", () => {
    const outcome = describeCouponOutcome({
      code: "SAVE5",
      offerLabel: null,
      winnerType: "coupon",
      winnerLabel: "Promo code SAVE5",
    });

    expect(outcome.controlsPrice).toBe(true);
    expect(outcome.message).toContain("SAVE5");
  });
});

describe("a coupon that loses to a better discount says THAT plainly", () => {
  it("names the discount that actually controls the price", () => {
    // The exact reproduced case.
    const outcome = describeCouponOutcome({
      code: "HARNESS10",
      offerLabel: "10% off",
      winnerType: "bundle_pricing",
      winnerLabel: "Bundle pricing",
    });

    expect(outcome.controlsPrice).toBe(false);
    expect(outcome.message).toContain("HARNESS10");
    expect(outcome.message).toContain("Bundle pricing");
  });

  it("never claims the losing coupon was applied or reduced the total", () => {
    const outcome = describeCouponOutcome({
      code: "HARNESS10",
      offerLabel: "10% off",
      winnerType: "bundle_pricing",
      winnerLabel: "Bundle pricing",
    });

    // "Coupon applied." was the original copy. It must not survive in any form
    // that reads as "this coupon lowered your price".
    expect(outcome.message).not.toMatch(/coupon applied/i);
    expect(outcome.message).not.toMatch(/you saved/i);
    // The offer size must not be dangled as if it were in effect.
    expect(outcome.message).not.toMatch(/10% off/);
  });

  it("handles losing to membership pricing", () => {
    const outcome = describeCouponOutcome({
      code: "HARNESS10",
      offerLabel: "10% off",
      winnerType: "member_pricing",
      winnerLabel: "Membership discount",
    });

    expect(outcome.controlsPrice).toBe(false);
    expect(outcome.message).toContain("Membership discount");
  });

  it("is honest when an accepted coupon reduces nothing at all", () => {
    const outcome = describeCouponOutcome({
      code: "HARNESS10",
      offerLabel: "10% off",
      winnerType: null,
      winnerLabel: null,
    });

    expect(outcome.controlsPrice).toBe(false);
    expect(outcome.message).toMatch(/doesn't|does not/i);
    expect(outcome.message).not.toMatch(/coupon applied/i);
  });
});

// ---------------------------------------------------------------------------
// NEGATIVE CONTROL
//
// The old implementation was the constant string "Coupon applied." for every
// case. If describeCouponOutcome ever collapses back to a constant, these
// prove the suite notices: the winning and losing messages must differ, and
// the old constant must fail the losing-case assertions.
// ---------------------------------------------------------------------------
describe("negative control: the old constant copy would fail these tests", () => {
  const LEGACY_MESSAGE = "Coupon applied.";

  it("the legacy constant fails the losing-coupon assertion", () => {
    expect(() => expect(LEGACY_MESSAGE).not.toMatch(/coupon applied/i)).toThrow();
  });

  it("winning and losing produce genuinely different copy", () => {
    const won = describeCouponOutcome({
      code: "HARNESS10",
      offerLabel: "10% off",
      winnerType: "coupon",
      winnerLabel: "Promo code HARNESS10",
    });
    const lost = describeCouponOutcome({
      code: "HARNESS10",
      offerLabel: "10% off",
      winnerType: "bundle_pricing",
      winnerLabel: "Bundle pricing",
    });

    expect(won.message).not.toBe(lost.message);
    expect(won.controlsPrice).not.toBe(lost.controlsPrice);
  });
});

// ---------------------------------------------------------------------------
// PRICE-02. Shipping is not part of the discount race. A code flagged
// free_shipping can lose the percentage contest — or carry no percentage at
// all — and still take $15 off the order. The copy used to know nothing about
// that: a shipping-only code was reported as "doesn't lower the total on this
// order" while the server charged $0 shipping for it.
// ---------------------------------------------------------------------------
describe("a coupon that waives shipping is in the price", () => {
  it("a shipping-only code (no percentage) is confirmed, naming the waiver", () => {
    const outcome = describeCouponOutcome({ code: "SHIPFREE", offerLabel: null, winnerType: null, winnerLabel: null, waivesShipping: true });
    expect(outcome.controlsPrice).toBe(true);
    expect(outcome.message).toBe("Coupon applied — SHIPFREE · Free shipping.");
  });

  it("a code that lost the percentage race but waives shipping is still confirmed — for the waiver only", () => {
    const outcome = describeCouponOutcome({
      code: "VIP10", offerLabel: "10% off", winnerType: "bulk_savings", winnerLabel: "Bulk savings", waivesShipping: true,
    });
    expect(outcome.controlsPrice).toBe(true);
    expect(outcome.message).toContain("Free shipping");
    // The percentage is NOT in effect, so it is not quoted.
    expect(outcome.message).not.toContain("10% off");
  });

  it("a winning code that also waives shipping names both", () => {
    const outcome = describeCouponOutcome({
      code: "VIP10", offerLabel: "10% off", winnerType: "coupon", winnerLabel: "Promo code VIP10", waivesShipping: true,
    });
    expect(outcome.message).toBe("Coupon applied — VIP10 · 10% off + Free shipping.");
  });

  it("with no waiver the outcome is unchanged: a losing code still says it lost", () => {
    const outcome = describeCouponOutcome({
      code: "VIP10", offerLabel: "10% off", winnerType: "bulk_savings", winnerLabel: "Bulk savings", waivesShipping: false,
    });
    expect(outcome.controlsPrice).toBe(false);
    expect(outcome.message).toContain("Bulk savings");
  });
});
