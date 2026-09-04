import { describe, expect, it } from "vitest";
import { couponOutcomeAgainstQuote } from "@/lib/discount-resolution";

// ---------------------------------------------------------------------------
// THE COUPON MESSAGE NEVER CONTRADICTS THE ORDER.
//
// The client works out the coupon's fate from the discounts it can see, and it
// cannot see the armed gift — that is priced only by the server's quote. So
// with a 15% gift armed and a 5% code typed, the client said "Coupon applied"
// while the order recorded no code. When a quote is present it is the
// authority: a code it did not record was not applied.
// ---------------------------------------------------------------------------

const applied = { controlsPrice: true, message: "Coupon applied — SAVE5 · 5% off." };

describe("couponOutcomeAgainstQuote", () => {
  it("keeps the client's answer when there is no quote", () => {
    expect(couponOutcomeAgainstQuote({ outcome: applied, couponCode: "SAVE5", quote: null })).toEqual(applied);
  });

  it("keeps the client's answer when the quote recorded the same code", () => {
    expect(couponOutcomeAgainstQuote({ outcome: applied, couponCode: "SAVE5", quote: { couponCode: "SAVE5", discountLabel: "Coupon" } })).toEqual(applied);
  });

  it("says the code was kept out when the quote did not record it, naming what won", () => {
    const out = couponOutcomeAgainstQuote({ outcome: applied, couponCode: "SAVE5", quote: { couponCode: null, discountLabel: "15% gift" } });
    expect(out?.controlsPrice).toBe(false);
    expect(out?.message).toBe("SAVE5 accepted — but your 15% gift saves you more, so we kept that.");
  });

  it("says the code did not lower the total when the quote recorded nothing and names no winner", () => {
    const out = couponOutcomeAgainstQuote({ outcome: applied, couponCode: "SAVE5", quote: { couponCode: null, discountLabel: null } });
    expect(out?.controlsPrice).toBe(false);
    expect(out?.message).toBe("SAVE5 accepted — but it doesn't lower the total on this order.");
  });

  it("has nothing to say without a coupon", () => {
    expect(couponOutcomeAgainstQuote({ outcome: null, couponCode: null, quote: { couponCode: null, discountLabel: "15% gift" } })).toBeNull();
  });
});
