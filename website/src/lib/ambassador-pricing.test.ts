import { describe, expect, it } from "vitest";
import { calculateDiscountAmount } from "@/lib/referral-service";
import { roundMoney } from "@/lib/bundle-pricing";
import { resolveBestDiscount } from "@/lib/discount-resolution";

// Guards the fix for the client/server total divergence: the client
// (cart-context.tsx) computes each percentage discount as
// roundMoney(subtotal * pct/100); the server (payment-service.ts) uses
// calculateDiscountAmount. These MUST produce byte-identical cents for every
// input, or the "Altered total detected" tripwire can reject legit orders and
// manual-pay customers can be shown a fractionally-wrong amount.
describe("client/server discount rounding parity", () => {
  const subtotals = [0, 9.99, 33.33, 49.95, 100, 123.45, 199.99, 250, 1000.01, 8675.31];
  const percents = [10, 15, 12.5, 20, 25, 7];

  it("roundMoney(subtotal*pct/100) equals calculateDiscountAmount for all inputs", () => {
    for (const subtotal of subtotals) {
      for (const pct of percents) {
        const clientSide = roundMoney(subtotal * (pct / 100));
        const serverSide = calculateDiscountAmount(subtotal, pct);
        expect(clientSide).toBe(serverSide);
      }
    }
  });

  it("both sides always yield whole-cent amounts (rounding is idempotent)", () => {
    for (const subtotal of subtotals) {
      for (const pct of percents) {
        const amount = calculateDiscountAmount(subtotal, pct);
        expect(roundMoney(amount)).toBe(amount);
      }
    }
  });
});

// Guards the "only one percentage discount applies, greatest wins" rule with
// the ambassador candidate in the mix (payment-service.ts + cart-context.tsx
// feed identical candidate lists into this shared resolver).
describe("discount resolution with ambassador candidate", () => {
  it("picks the greatest single discount, never stacks", () => {
    const best = resolveBestDiscount([
      { type: "member_pricing", amount: 10 },
      { type: "ambassador", amount: 15 },
      { type: "coupon", amount: 12 },
    ]);
    expect(best?.type).toBe("ambassador");
    expect(best?.amount).toBe(15);
  });

  it("ignores zero-amount candidates (a gated-off ambassador discount)", () => {
    const best = resolveBestDiscount([
      { type: "ambassador", amount: 0 },
      { type: "coupon", amount: 8 },
    ]);
    expect(best?.type).toBe("coupon");
  });

  it("returns null when no candidate has a positive amount", () => {
    expect(resolveBestDiscount([{ type: "ambassador", amount: 0 }])).toBeNull();
  });
});
