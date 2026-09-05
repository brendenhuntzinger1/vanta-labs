import { describe, expect, it } from "vitest";
import { boundedCardFeePercent, MAX_CARD_FEE_PERCENT } from "@/lib/admin-control";

// ADM-08, read side: whatever is stored, checkout never applies a fee above
// the ceiling or below zero, and garbage falls back to the default.
describe("boundedCardFeePercent", () => {
  it("passes a sane rate through unchanged", () => {
    expect(boundedCardFeePercent(3, 3)).toBe(3);
    expect(boundedCardFeePercent("2.9", 3)).toBe(2.9);
    expect(boundedCardFeePercent(0, 3)).toBe(0);
  });
  it("clamps a typo to the ceiling and a negative to zero", () => {
    expect(boundedCardFeePercent(50, 3)).toBe(MAX_CARD_FEE_PERCENT);
    expect(boundedCardFeePercent(-4, 3)).toBe(0);
  });
  it("falls back to the default for anything unparseable", () => {
    expect(boundedCardFeePercent("abc", 3)).toBe(3);
    expect(boundedCardFeePercent(undefined, 3)).toBe(3);
    expect(boundedCardFeePercent(null, 3)).toBe(3);
    expect(boundedCardFeePercent("", 3)).toBe(3);
  });
});
