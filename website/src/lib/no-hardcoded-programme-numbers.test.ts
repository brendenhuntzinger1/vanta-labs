import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// THE BINDINGS NOTHING ELSE CAN SEE.
//
// A source-text test is normally the weak kind, and this repo has said so
// repeatedly: `expect(webhook).toContain('"Ambassador is not active."')` stayed
// green through a sabotage that deleted the guard and left the string. Where a
// behavioural test is possible, it belongs there, and the arithmetic these
// bindings feed IS tested behaviourally — partner-dashboard-copy.test.ts and
// referral-program-gate.test.ts cover every value and every edge.
//
// What no test in this repo can reach is the BINDING. vitest.config.ts sets
// `environment: "node"`, there are no .test.tsx files, and nothing renders
// CartProvider or the partner dashboard. So reverting a prop to a literal, or
// deleting the line that stores the master switch, leaves the whole suite
// green. That is not hypothetical: this file exists because the first pass at
// the hold-copy fix replaced one literal and missed a second one in the same
// component, and only an adversarial read caught it.
//
// These pins are deliberately about WIRING, not wording — that a value comes
// from the resolved setting rather than from a number somebody typed. The
// repo's own idiom for exactly this is ambassador-dashboard-rates.test.ts.
// ---------------------------------------------------------------------------

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

const dashboard = read("src/components/partner-dashboard-client.tsx");
const cartContext = read("src/components/cart-context.tsx");
const promotionsRoute = read("src/app/api/catalog/promotions/route.ts");

/** Comments explain the old literals on purpose; only live code is pinned. */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
}

describe("the ambassador dashboard prints no programme number of its own", () => {
  const code = codeOnly(dashboard);

  it("takes the hold period from the resolved setting, in both places it says it", () => {
    expect(code).toContain("commissionHoldLabel(liveSummary.commissionHoldDays)");
    expect(code).toContain("commissionHoldDuration(liveSummary.commissionHoldDays)");
  });

  it("takes the ambassador's personal discount from the resolved setting", () => {
    expect(code).toContain("personalDiscountLabel(liveSummary.personalDiscountPercent)");
  });

  // The two literals that were actually wrong: production holds 30 days and
  // gives 20%, and this component said 14 and 15.
  it.each([
    ["14-day hold", /14-day hold/],
    ["14 days", /held for 14 days/],
    ["15% off your own orders", /15% off your own orders/],
  ])("no longer contains the literal %s", (_label, pattern) => {
    expect(code).not.toMatch(pattern);
  });

  // Any bare "N-day"/"N days" in this file is a programme number typed by hand.
  it("has no hand-typed hold period left anywhere in it", () => {
    expect(code).not.toMatch(/\b\d+[- ]days?\b/);
  });
});

describe("the cart carries the referral master switch", () => {
  const code = codeOnly(cartContext);

  it("stores what the promotions endpoint says about the programme", () => {
    expect(code).toContain("setReferralProgramEnabled(result.referralProgramEnabled)");
  });

  it("holds it as a tri-state, so 'unknown' is not 'off'", () => {
    expect(code).toContain("useState<boolean | null>(null)");
  });

  it("asks the shared gate rather than comparing the flag by hand", () => {
    expect(code).toContain("referralProgramAllowsCodes(referralProgramEnabled)");
    expect(code).toContain("referralProgramIsOff(referralProgramEnabled)");
    // A bare `=== false` / `!== false` here would be a fourth hand-written copy
    // of the rule the gate module exists to hold.
    expect(code).not.toMatch(/referralProgramEnabled\s*[=!]==?\s*(false|true)\b/);
  });

  it("gates the code's PRICE, not only its display", () => {
    // Both must be present: hiding the sentence while still pricing the
    // referral is the exact defect this work started from.
    expect(code).toMatch(/isReferralValid\(referralDetails\) && referralProgramAllowsCodes/);
    expect(code).toMatch(/referralDetails && referralProgramAllowsCodes/);
  });
});

describe("the promotions endpoint sends the switch", () => {
  const code = codeOnly(promotionsRoute);

  it("sends the live value on the success path", () => {
    expect(code).toContain("referralProgramEnabled: referralProgram.enabled");
  });

  // Lockstep with getReferralProgramConfig's own fallback: a failed read must
  // not strip a real discount from every referred shopper.
  it("falls back to ON, matching the server", () => {
    expect(code).toContain("referralProgramEnabled: true");
  });
});
