import { describe, expect, it } from "vitest";
import { resolveBestDiscount, type DiscountCandidate } from "./discount-resolution";

// These lock in the "one discount per order, greatest savings wins, no stacking"
// rule that both the client cart preview and the server checkout total share.
// The server adds a coupon ON TOP of this result only when the admin has turned
// on stacking (that additive step lives in payment-service.ts); everything else
// goes through this single resolver.

describe("resolveBestDiscount — greatest savings wins, never stacks", () => {
  it("returns null when there are no positive candidates", () => {
    expect(resolveBestDiscount([])).toBeNull();
    expect(resolveBestDiscount([{ type: "coupon", amount: 0 }])).toBeNull();
    expect(resolveBestDiscount([{ type: "referral", amount: -5 }])).toBeNull();
  });

  it("picks a referral discount when it's the only one", () => {
    const best = resolveBestDiscount([{ type: "referral", amount: 54 }]);
    expect(best).toEqual({ type: "referral", amount: 54 });
  });

  it("picks a coupon when it's the only one", () => {
    const best = resolveBestDiscount([{ type: "coupon", amount: 20 }]);
    expect(best).toEqual({ type: "coupon", amount: 20 });
  });

  it("never stacks — only the single largest discount applies", () => {
    const candidates: DiscountCandidate[] = [
      { type: "bulk_savings", amount: 30 },
      { type: "member_pricing", amount: 25 },
      { type: "referral", amount: 54 },
      { type: "coupon", amount: 15 },
    ];
    // Sum would be 124; the resolver must return ONLY the largest (54), proving
    // discounts don't stack.
    expect(resolveBestDiscount(candidates)).toEqual({ type: "referral", amount: 54 });
  });

  it("lets the ambassador personal discount compete and win when it's largest", () => {
    const best = resolveBestDiscount([
      { type: "bulk_savings", amount: 20 },
      { type: "ambassador_personal", amount: 60 },
      { type: "referral", amount: 54 },
    ]);
    expect(best).toEqual({ type: "ambassador_personal", amount: 60 });
  });

  it("Buy 3 Get 1 wins over a smaller referral discount (free item is the promo)", () => {
    const best = resolveBestDiscount([
      { type: "buy3get1", amount: 65 },
      { type: "referral", amount: 54 },
    ]);
    expect(best).toEqual({ type: "buy3get1", amount: 65 });
  });

  it("keeps the first candidate on an exact tie (deterministic)", () => {
    const best = resolveBestDiscount([
      { type: "member_pricing", amount: 40 },
      { type: "referral", amount: 40 },
    ]);
    expect(best).toEqual({ type: "member_pricing", amount: 40 });
  });

  it("ignores zero/negative candidates but still finds the best positive one", () => {
    const best = resolveBestDiscount([
      { type: "coupon", amount: 0 },
      { type: "bulk_savings", amount: -10 },
      { type: "member_pricing", amount: 12 },
    ]);
    expect(best).toEqual({ type: "member_pricing", amount: 12 });
  });
});
