import { describe, expect, it } from "vitest";
import { describeEffectiveRate, parseRatePercent } from "@/lib/admin-control";

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

// ---------------------------------------------------------------------------
// THE LABEL AND THE APPLIED RATE MUST BE THE SAME FUNCTION — FIX WAVE 3.
//
// describeEffectiveRate had its own copy of the parsing rule and getProfitSettings
// had another, and they disagreed on every input a text box can actually
// produce: "-5" displayed "-5% in effect" while 8% was applied, and "8%"
// displayed "NaN% in effect" while 8% was applied. This is the feature whose
// entire purpose is to say what is in effect.
//
// And `num()` had a lower bound but NO UPPER ONE, so "800" was accepted
// verbatim: an 800% modelled fee puts every order below the profit floor and
// blocks all checkout, from a typo in a free-text field with no validation on
// the PATCH route either.
// ---------------------------------------------------------------------------
describe("describeEffectiveRate agrees with the rate that is actually applied", () => {
  const cases = ["", "   ", "0", "2.9", "8", "100", "-5", "8%", "800", "abc", "1e3", "-0.01", "100.01"];

  it("never claims a rate parseRatePercent would reject", () => {
    for (const stored of cases) {
      const applied = parseRatePercent(stored) ?? 8;
      const shown = describeEffectiveRate(stored, 8);
      if (shown.endsWith("% in effect")) {
        expect(Number(shown.replace("% in effect", ""))).toBe(applied);
      } else {
        // Anything else is a "the default applies" message, and the default
        // must be what is applied.
        expect(applied).toBe(8);
        expect(shown).toContain("8%");
      }
    }
  });

  it("does not display a negative rate as being in effect", () => {
    expect(describeEffectiveRate("-5", 8)).not.toContain("-5% in effect");
    expect(parseRatePercent("-5")).toBeNull();
  });

  it("does not display NaN for a value with a stray percent sign", () => {
    expect(describeEffectiveRate("8%", 8)).not.toContain("NaN");
    expect(parseRatePercent("8%")).toBeNull();
  });

  it("refuses a rate above 100%, which would block every checkout", () => {
    expect(parseRatePercent("800")).toBeNull();
    expect(describeEffectiveRate("800", 8)).toContain("8%");
  });

  it("still accepts the whole legitimate range", () => {
    expect(parseRatePercent("0")).toBe(0);
    expect(parseRatePercent("8")).toBe(8);
    expect(parseRatePercent("2.9")).toBe(2.9);
    expect(parseRatePercent("100")).toBe(100);
  });

  it("treats a blank or whitespace value as unset, exactly as the resolver does", () => {
    expect(parseRatePercent("")).toBeNull();
    expect(parseRatePercent("   ")).toBeNull();
    expect(parseRatePercent(null)).toBeNull();
    expect(parseRatePercent(undefined)).toBeNull();
  });
});
