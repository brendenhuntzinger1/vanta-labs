import { describe, expect, it } from "vitest";
import { shouldLoadGoogleTag } from "./google-health-browser";

/**
 * The consent gate, exhaustively.
 *
 * Seven of eight combinations must refuse. This is the test that fails if a
 * gate is deleted, inverted, or computed and then ignored — which a source-text
 * assertion cannot detect.
 */
describe("shouldLoadGoogleTag", () => {
  const cases: { accepted: boolean; adsAllowed: boolean; conversionIdConfigured: boolean; expected: boolean }[] = [
    { accepted: true,  adsAllowed: true,  conversionIdConfigured: true,  expected: true  },
    { accepted: false, adsAllowed: true,  conversionIdConfigured: true,  expected: false },
    { accepted: true,  adsAllowed: false, conversionIdConfigured: true,  expected: false },
    { accepted: true,  adsAllowed: true,  conversionIdConfigured: false, expected: false },
    { accepted: false, adsAllowed: false, conversionIdConfigured: true,  expected: false },
    { accepted: false, adsAllowed: true,  conversionIdConfigured: false, expected: false },
    { accepted: true,  adsAllowed: false, conversionIdConfigured: false, expected: false },
    { accepted: false, adsAllowed: false, conversionIdConfigured: false, expected: false },
  ];

  for (const { expected, ...input } of cases) {
    it(`${JSON.stringify(input)} -> ${expected}`, () => {
      expect(shouldLoadGoogleTag(input)).toBe(expected);
    });
  }

  it("loads for exactly one of the eight combinations", () => {
    expect(cases.filter((c) => c.expected).length).toBe(1);
  });

  it("refuses when consent is absent even with everything else green", () => {
    expect(shouldLoadGoogleTag({ accepted: false, adsAllowed: true, conversionIdConfigured: true })).toBe(false);
  });

  it("refuses outside production even with consent given", () => {
    expect(shouldLoadGoogleTag({ accepted: true, adsAllowed: false, conversionIdConfigured: true })).toBe(false);
  });
});
