import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { FALLBACK_PROGRAM_TERMS } from "@/lib/public-program-terms";
import {
  formatPercent,
  formatThreshold,
  holdDuration,
  holdLabel,
} from "@/lib/public-program-terms-shared";

// ---------------------------------------------------------------------------
// THE TWO RECRUITMENT PAGES QUOTE NO NUMBER OF THEIR OWN.
//
// Same idiom, and the same justification, as
// no-hardcoded-programme-numbers.test.ts: vitest runs in a node environment,
// there are no .test.tsx files, and nothing in the suite renders either landing
// page. So the arithmetic is testable and the WIRING is not — reverting
// `{formatPercent(terms.commissionPercent)}` to the string "15%" leaves the
// whole suite green. That is precisely how the defect this file exists for got
// in: /ambassador and /partner both advertised a "15% Base Commission" while
// the programme default paid 10, because 15 is the TOP tier.
//
// Pins are about WIRING, not wording. Nobody should have to update this file to
// reword a benefit; they should have to update it to type a rate into one.
// ---------------------------------------------------------------------------

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

const ambassador = read("src/app/ambassador/ambassador-client.tsx");
const ambassadorPage = read("src/app/ambassador/page.tsx");
const partner = read("src/components/partner-program-landing.tsx");
const partnerPage = read("src/app/partner/page.tsx");

/** Comments describe the old literals on purpose; only live code is pinned. */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
}

describe("the server pages fetch the live programme terms", () => {
  it.each([
    ["/ambassador", ambassadorPage],
    ["/partner", partnerPage],
  ])("%s reads getPublicProgramTerms and hands it to the client", (_route, source) => {
    const code = codeOnly(source);
    expect(code).toContain("getPublicProgramTerms");
    expect(code).toContain("terms={terms}");
  });

  it("/ambassador is not statically cached, or it would keep quoting a stale rate", () => {
    expect(codeOnly(ambassadorPage)).toContain('export const dynamic = "force-dynamic"');
  });
});

describe("the ambassador page states every term from the resolved settings", () => {
  const code = codeOnly(ambassador);

  it.each([
    ["the commission rate", "formatPercent(terms.commissionPercent)"],
    ["the customer discount", "formatPercent(terms.customerDiscountPercent)"],
    ["the qualifying minimum", "formatThreshold(terms.minimumQualifyingOrder)"],
    ["the payout minimum", "formatThreshold(terms.minimumPayoutThreshold)"],
    ["the hold label", "holdLabel(terms.commissionHoldDays)"],
    ["the hold sentence", "holdDuration(terms.commissionHoldDays)"],
  ])("takes %s from the setting", (_what, binding) => {
    expect(code).toContain(binding);
  });

  it("opens the earnings estimator on the rate actually offered", () => {
    expect(code).toContain("useState(terms.commissionPercent)");
  });

  it("cannot model a rate BELOW the offered base, which would understate the deal", () => {
    expect(code).toContain("min={terms.commissionPercent}");
  });
});

describe("the partner page states its rates from the resolved settings", () => {
  const code = codeOnly(partner);

  it.each([
    ["the commission rate", "formatPercent(terms.commissionPercent)"],
    ["the customer discount", "formatPercent(terms.customerDiscountPercent)"],
    ["the ambassador's own discount", "formatPercent(terms.personalDiscountPercent)"],
    ["the hold period", "holdDuration(terms.commissionHoldDays)"],
  ])("takes %s from the setting", (_what, binding) => {
    expect(code).toContain(binding);
  });

  it("opens its calculator on the rate actually offered", () => {
    expect(code).toContain("useState(terms.commissionPercent)");
  });
});

describe("no live line on either page types a programme number", () => {
  // The exact literals that were wrong, plus the shapes they were written in.
  // A benefit list may still say "$100" about something that is not a
  // programme threshold, so these are anchored to the phrasing that was there.
  it.each([
    ["a base-commission literal", /\d+% Base Commission/],
    ["an earnings literal", /You earn \d+%/],
    ["an audience-saves literal", /audience saves \d+%/],
    ["a commission-benefit literal", /A \d+% commission on every/],
    ["an own-purchases literal", /\d+% discount on all of your own purchases/],
    ["an audience-discount literal", /gives your audience \d+% off/],
    ["a hold literal", /\d+-day hold|held \d+ days|payable \d+ days/],
  ])("%s appears in neither page", (_label, pattern) => {
    expect(codeOnly(ambassador)).not.toMatch(pattern);
    expect(codeOnly(partner)).not.toMatch(pattern);
  });

  it("neither page imports the hold-days constant any more — the setting supersedes it", () => {
    expect(codeOnly(ambassador)).not.toContain("DEFAULT_COMMISSION_HOLD_DAYS");
    expect(codeOnly(partner)).not.toContain("DEFAULT_COMMISSION_HOLD_DAYS");
  });
});

describe("the formatters say what an owner actually typed", () => {
  it("prints a whole rate without decimal noise", () => {
    expect(formatPercent(15)).toBe("15%");
    expect(formatPercent(10)).toBe("10%");
  });

  it("prints a half-point tier rate, which numeric(5,2) genuinely allows", () => {
    expect(formatPercent(12.5)).toBe("12.5%");
  });

  it("refuses to invent a number it does not have", () => {
    expect(formatPercent(Number.NaN)).toBe("—");
    expect(formatThreshold(Number.NaN)).toBe("—");
  });

  it("prints whole-dollar thresholds without cents", () => {
    expect(formatThreshold(100)).toBe("$100");
    expect(formatThreshold(99.5)).toBe("$99.50");
  });

  it("gets the singular right for a one-day hold", () => {
    expect(holdDuration(1)).toBe("1 day");
    expect(holdDuration(30)).toBe("30 days");
    expect(holdLabel(30)).toBe("30-day hold");
  });
});

describe("the fallback the pages render when config is unreachable", () => {
  it("matches the values the payout code itself falls back to", () => {
    // The page and the money must agree even when the database does not answer.
    expect(FALLBACK_PROGRAM_TERMS.commissionPercent).toBe(10);
    expect(FALLBACK_PROGRAM_TERMS.customerDiscountPercent).toBe(10);
    expect(FALLBACK_PROGRAM_TERMS.personalDiscountPercent).toBe(20);
    expect(FALLBACK_PROGRAM_TERMS.commissionHoldDays).toBe(30);
    expect(FALLBACK_PROGRAM_TERMS.minimumQualifyingOrder).toBe(100);
    expect(FALLBACK_PROGRAM_TERMS.minimumPayoutThreshold).toBe(100);
  });
});
