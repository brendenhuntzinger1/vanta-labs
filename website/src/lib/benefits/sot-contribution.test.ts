import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// SOT-CONTRIBUTION — one contribution formula, one home, never a second
// inlined copy.
//
// The SOT-08 precedent (phase11-bucket0.test.ts:275) exists because the profit
// FLOOR predicate had two homes and only one of them was the module documented
// as the guardrail. Contribution is a bigger version of the same risk: ten
// terms, three consumers, and an answer nobody can eyeball. A second copy would
// not announce itself — it would simply be a number on one screen that does not
// match the number on another, with no test failing anywhere.
//
// This is the M7 gate. M7 makes the commission floor real; the day it does, the
// only way `commission_capped_amount` may be derived is by calling
// `applyCommissionFloor`, and the only definition of contribution it may bound
// against is this one.
// ---------------------------------------------------------------------------

const SRC = join(process.cwd(), "src");
const CONTRIBUTION = "src/lib/benefits/contribution.ts";
const PROCESSOR_COST = "src/lib/benefits/processor-cost.ts";

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

const relative = (file: string) => file.replace(`${process.cwd()}/`, "");
const isTest = (file: string) => /\.test\.tsx?$/.test(file);

/** Every non-test source file, excluding the ones named. */
function productionSources(...except: string[]): Array<{ path: string; source: string }> {
  return walk(SRC)
    .filter((file) => !isTest(file))
    .map((file) => ({ path: relative(file), source: readFileSync(file, "utf8") }))
    .filter((entry) => !except.includes(entry.path));
}

const source = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

describe("the contribution arithmetic has exactly one home", () => {
  it.each([
    // The two terms no other formula in this codebase subtracts. Either one
    // appearing in a subtraction elsewhere is a second copy of this formula.
    ["a points-earned deduction", /-\s*(?:\w+\.)?pointsEarnedValue/],
    ["a store-credit-redeemed deduction", /-\s*(?:\w+\.)?storeCreditRedeemed\b/],
    ["a gift-COGS deduction", /-\s*(?:\w+\.)?giftCogs\b/],
    // The floor, in its two recognisable shapes.
    ["a commission cap", /commissionCapped\s*(?::\s*number\s*)?=[^=]/],
    ["a commission headroom clamp", /Math\.min\(\s*commissionCalculated/],
  ])("no module outside contribution.ts contains %s", (_label, pattern) => {
    const offenders = productionSources(CONTRIBUTION)
      .filter((entry) => pattern.test(entry.source))
      .map((entry) => entry.path);
    expect(
      offenders,
      `These files restate the contribution formula. It has ONE home: ${CONTRIBUTION}. `
        + "Call computeContributionBeforeCommission / applyCommissionFloor instead — see blueprint §D1.",
    ).toEqual([]);
  });

  it("contribution.ts actually contains the arithmetic it claims to own", () => {
    const owner = source(CONTRIBUTION);
    // A guard that only asserts absence elsewhere passes trivially if the owner
    // is gutted, so the owner is pinned too.
    expect(owner).toContain("revenueCents - deductionsCents");
    expect(owner).toContain("Math.min(calculated, headroom)");
    expect(owner).toContain("export function computeContributionBeforeCommission");
    expect(owner).toContain("export function applyCommissionFloor");
  });

  it("the live checkout CALLS it rather than restating it", () => {
    const quote = source("src/lib/quote-order.ts");
    expect(quote).toContain("computeContributionBeforeCommission({");
    // Every term is passed in by name; none is combined at the call site.
    for (const term of [
      "paidMerchandise:", "shippingCollected:", "handlingCollected:", "productCost:",
      "giftCogs:", "processingFee:", "shippingCost:", "storeCreditRedeemed:",
      "pointsRedeemedValue:", "pointsEarnedValue:",
    ]) {
      expect(quote, `quote-order must pass ${term}`).toContain(term);
    }
  });

  it("the checkout takes paidMerchandise from M4's base, not from its own subtraction", () => {
    const quote = source("src/lib/quote-order.ts");
    expect(quote).toContain("const contributionBases = deriveOrderBases({ subtotal, discountAmount })");
    expect(quote).toContain("paidMerchandise: contributionBases.paidMerchandise");
  });
});

describe("the cents boundary is a single, unexported point", () => {
  it("toContributionCents lives in contribution.ts, is not exported, and exists nowhere else", () => {
    const owner = source(CONTRIBUTION);
    expect(owner).toContain("function toContributionCents(");
    expect(owner).not.toContain("export function toContributionCents");

    const offenders = productionSources(CONTRIBUTION)
      .filter((entry) => /\btoContributionCents\b/.test(entry.source))
      .map((entry) => entry.path);
    expect(
      offenders,
      "The dollars-to-cents conversion for contribution has ONE point. A second one is a second rounding boundary.",
    ).toEqual([]);
  });

  it("is called once per term and nowhere else in the file", () => {
    const owner = source(CONTRIBUTION);
    const calls = owner.match(/toContributionCents\(/g) ?? [];
    // One definition + one call per input term (3 revenue, 7 deductions, 1
    // discount metadata). A change to this count is a change to the formula.
    expect(calls).toHaveLength(1 + 11);
  });
});

describe("the processor cost has exactly one home", () => {
  it("no module outside processor-cost.ts turns a fee percent into a fee", () => {
    const offenders = productionSources(PROCESSOR_COST)
      .filter((entry) => /processingFeePercent\s*\/\s*100/.test(entry.source))
      .map((entry) => entry.path);
    expect(
      offenders,
      `These files model the processor fee themselves. It has ONE home: ${PROCESSOR_COST}.`,
    ).toEqual([]);
  });

  it("no module outside processor-cost.ts decides which methods settle fee-free", () => {
    const offenders = productionSources(PROCESSOR_COST)
      .filter((entry) => /\bMANUAL_HINTS\b/.test(entry.source))
      .map((entry) => entry.path);
    expect(offenders).toEqual([]);
  });

  it("the three consumers call it", () => {
    for (const path of ["src/lib/profit-engine.ts", "src/lib/admin-profit.ts", "src/lib/quote-order.ts"]) {
      expect(source(path), `${path} must call processorCostFor`).toContain("processorCostFor({");
    }
  });

  it("the old inlined expressions are gone", () => {
    expect(source("src/lib/profit-engine.ts")).not.toContain("const feeBase =");
    expect(source("src/lib/admin-profit.ts")).not.toContain("config.processingFeePercent / 100");
  });
});

describe("M5 is reporting-only: the floor is defined but never applied", () => {
  it("nothing in production calls applyCommissionFloor", () => {
    // The M3 precedent (person-key-unused.test.ts): an unconsumed capability is
    // proven unconsumed, so the day something consumes it is a deliberate act
    // with a test of its own rather than a change that arrived with another one.
    const offenders = productionSources(CONTRIBUTION)
      .filter((entry) => /\bapplyCommissionFloor\b/.test(entry.source))
      .map((entry) => entry.path);
    expect(
      offenders,
      "applyCommissionFloor changes what an ambassador is PAID. That is M7, and it needs "
        + "referral_orders' audit columns (blueprint §C3) in the same change.",
    ).toEqual([]);
  });

  it("nothing in production consumes the contribution number either", () => {
    // It may be COMPUTED and CARRIED (quote-order does both) and READ BY NAME
    // for persistence. What it must not yet do is decide anything — so no
    // comparison against it exists outside its own module.
    const offenders = productionSources(CONTRIBUTION)
      .filter((entry) => /contributionBeforeCommissionCents\s*[<>]/.test(entry.source))
      .map((entry) => entry.path);
    expect(offenders).toEqual([]);
  });

  it("the floor snapshot carries contribution without recomputing the floor verdict", () => {
    const alert = source("src/lib/profit-floor-alert.ts");
    expect(alert).toContain("return { ...snapshot, contribution };");
    // withContribution must not touch the verdict — one call to meetsFloor, in
    // the builder, exactly as SOT-08 requires.
    expect((alert.match(/meetsFloor\(/g) ?? [])).toHaveLength(1);
  });
});
