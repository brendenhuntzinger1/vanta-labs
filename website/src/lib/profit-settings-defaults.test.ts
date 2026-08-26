import { describe, expect, it } from "vitest";
import { describeEffectiveRate } from "@/lib/admin-control";

// A BLANK FIELD AND "8%" LOOK IDENTICAL ON SCREEN. The stored value is the
// empty string, which falls through to DEFAULT_PROFIT_CONFIG.processingFeePercent.
// The fee was always adjustable; what was missing was any way to see what was
// actually in effect.
describe("describeEffectiveRate", () => {
  it("names the default when the field is blank", () => {
    expect(describeEffectiveRate("", 8)).toBe("Using the 8% default");
  });

  it("names the default when the field is whitespace", () => {
    expect(describeEffectiveRate("   ", 8)).toBe("Using the 8% default");
  });

  it("reports an explicit value as in effect", () => {
    expect(describeEffectiveRate("2.9", 8)).toBe("2.9% in effect");
  });

  it("treats an explicit zero as a real choice, not a blank", () => {
    expect(describeEffectiveRate("0", 8)).toBe("0% in effect");
  });
});
