import { describe, expect, it } from "vitest";

import { resolvePointsRedemptionCents, resolveStoreCreditCents } from "@/lib/store-credit-redemption";

// ---------------------------------------------------------------------------
// THE TWO NUMBERS THAT MOVED WITHOUT A TEST.
//
// Store credit and points are computed three times — cart-context.tsx (the
// drawer and the cart page), checkout/page.tsx (what is posted as
// expectedTotal), and quote-order.ts (what the card is charged). All three must
// agree exactly: the server rejects a client total that is LOWER than its own
// ("Altered total detected"), and the express lane sends no expectedTotal at
// all, so a divergence there charges the wallet silently.
//
// They were three hand-written copies, and an adversarial review proved the
// obvious consequence: reverting the server gate alone left all 4,147 tests
// green, and reverting BOTH client gates alone did too. Nothing rendered
// CartProvider, so nothing could see the client half; and no test passed a
// referral code into quoteOrder alongside a store-credit balance, so nothing
// saw the server half either. Either side of a two-sided money rule could be
// moved on its own without a single test noticing.
//
// The arithmetic now lives here, in cents, once.
// ---------------------------------------------------------------------------

describe("resolveStoreCreditCents", () => {
  const base = {
    referralDiscountApplied: false,
    balanceCents: 5000,
    minOrderCents: 0,
    subtotalCents: 9999,
    redeemableCents: 11499,
  };

  it("redeems the whole balance when the order is big enough to absorb it", () => {
    expect(resolveStoreCreditCents(base)).toBe(5000);
  });

  it("never redeems more than the order is worth", () => {
    expect(resolveStoreCreditCents({ ...base, redeemableCents: 1200 })).toBe(1200);
  });

  it("redeems nothing when the balance is empty", () => {
    expect(resolveStoreCreditCents({ ...base, balanceCents: 0 })).toBe(0);
    expect(resolveStoreCreditCents({ ...base, balanceCents: -500 })).toBe(0);
  });

  // The tier's margin guardrail, and it reads the MERCHANDISE subtotal — not
  // the total, which shipping and tax would inflate past the threshold.
  it("respects the tier's redemption minimum, measured on merchandise only", () => {
    expect(resolveStoreCreditCents({ ...base, minOrderCents: 10000, subtotalCents: 9999 })).toBe(0);
    expect(resolveStoreCreditCents({ ...base, minOrderCents: 10000, subtotalCents: 10000 })).toBe(5000);
  });

  // ── the referral rule ────────────────────────────────────────────────────
  //
  // Store credit never stacks with a referral DISCOUNT. It has nothing to be
  // exclusive of when the referral is giving the shopper nothing, and taking
  // her own money in exchange for a $0.00 discount is the harm, not the rule.

  it("stands down when the referral discount is the one being applied", () => {
    expect(resolveStoreCreditCents({ ...base, referralDiscountApplied: true })).toBe(0);
  });

  it("applies when a referral code is attached but wins nothing", () => {
    // Every reachable case where the code is real, the ambassador is approved,
    // and the discount is still $0.00: below the minimum, a commission-only
    // ambassador, Buy-3-Get-1 taking over, quantity-bundle pricing competing it
    // to zero, or membership/bulk/personal winning instead. The caller resolves
    // which; from here they are one state.
    expect(resolveStoreCreditCents({ ...base, referralDiscountApplied: false })).toBe(5000);
  });

  it("refuses a corrupt redeemable total rather than inventing credit", () => {
    expect(resolveStoreCreditCents({ ...base, redeemableCents: Number.NaN })).toBe(0);
    expect(resolveStoreCreditCents({ ...base, redeemableCents: -100 })).toBe(0);
  });
});

describe("resolvePointsRedemptionCents", () => {
  const base = {
    referralDiscountApplied: false,
    requestedCents: 2000,
    redeemableCents: 5000,
  };

  it("redeems what the shopper asked for", () => {
    expect(resolvePointsRedemptionCents(base)).toBe(2000);
  });

  it("caps the redemption at what is still owed", () => {
    expect(resolvePointsRedemptionCents({ ...base, redeemableCents: 750 })).toBe(750);
  });

  it("stands down when the referral discount is the one being applied", () => {
    expect(resolvePointsRedemptionCents({ ...base, referralDiscountApplied: true })).toBe(0);
  });

  it("applies when a referral code is attached but wins nothing", () => {
    expect(resolvePointsRedemptionCents({ ...base, referralDiscountApplied: false })).toBe(2000);
  });

  it("redeems nothing for a request of zero or less", () => {
    expect(resolvePointsRedemptionCents({ ...base, requestedCents: 0 })).toBe(0);
    expect(resolvePointsRedemptionCents({ ...base, requestedCents: -300 })).toBe(0);
  });

  it("refuses a corrupt redeemable total rather than inventing a discount", () => {
    expect(resolvePointsRedemptionCents({ ...base, redeemableCents: Number.NaN })).toBe(0);
    expect(resolvePointsRedemptionCents({ ...base, requestedCents: Number.NaN })).toBe(0);
  });
});

// The order the two run in is itself a rule: credit comes off first, points
// then compete for what is LEFT. Reversed, a shopper with enough of both would
// spend points on money her credit was about to cover.
describe("credit before points, on one order", () => {
  it("leaves points only the balance store credit did not cover", () => {
    const credit = resolveStoreCreditCents({
      referralDiscountApplied: false,
      balanceCents: 5000,
      minOrderCents: 0,
      subtotalCents: 8000,
      redeemableCents: 8000,
    });
    const points = resolvePointsRedemptionCents({
      referralDiscountApplied: false,
      requestedCents: 5000,
      redeemableCents: 8000 - credit,
    });
    expect(credit).toBe(5000);
    expect(points).toBe(3000);
    expect(8000 - credit - points).toBe(0);
  });
});
