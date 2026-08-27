import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { computeOrderProfit, marginPercentOf } from "@/lib/order-profit";

// ---------------------------------------------------------------------------
// A MARGIN PERCENT MUST NEVER MAKE A LOSS LOOK BETTER THAN IT IS.
//
// `marginPercent` was `revenue > 0 ? (profit / revenue) * 100 : 0`, so an order
// with negative revenue — an over-refund, or a redemption larger than the cash
// collected on a pass-through tax configuration — displayed "0.0%" next to a
// real dollar loss. Zero percent reads as "broke even".
//
// The naive repair is worse. Widen the guard to `revenue !== 0` and the
// division does this:
//
//     revenue -50, profit -80   ->   -80 / -50   =   +160%
//
// A loss of $80 presented as a 160% margin, because two negatives divided. That
// is the specific number money-recert finding 14 reports, and it is why this
// file asserts on BOTH failure directions rather than just the zero.
//
// THE CONVENTION: a margin is a proportion OF revenue, so it exists only when
// there is revenue to take a proportion of. At or below zero it is `null` —
// reported as "n/a" — which is the one answer that cannot flatter, cannot
// mislead, and cannot be averaged into a total by accident.
// ---------------------------------------------------------------------------

function order(overrides: Partial<Parameters<typeof computeOrderProfit>[0]> = {}) {
  return computeOrderProfit({
    netMerchandiseRevenue: 100,
    shippingRevenue: 0,
    shippingCost: 0,
    lines: [],
    commission: 0,
    processingFee: 0,
    refund: 0,
    countTaxAsProfit: true,
    ...overrides,
  });
}

describe("marginPercent on a normal order", () => {
  it("is the profit as a proportion of revenue", () => {
    const result = order({ netMerchandiseRevenue: 100, processingFee: 10 });
    expect(result.revenue).toBe(100);
    expect(result.profit).toBe(90);
    expect(result.marginPercent).toBe(90);
  });
});

describe("marginPercent when there is no revenue to take a proportion of", () => {
  it("is n/a on NEGATIVE revenue, not 0% and not a positive percentage", () => {
    // Paid 100, refunded 150, and $30 of costs already spent.
    const result = order({ netMerchandiseRevenue: 100, refund: 150, processingFee: 30 });
    expect(result.revenue).toBe(-50);
    expect(result.profit).toBe(-80);
    // 0 reads as "broke even"; +160 is what dividing two negatives produces.
    expect(result.marginPercent).toBeNull();
  });

  it("is n/a on ZERO revenue, where the proportion is undefined rather than zero", () => {
    const result = order({ netMerchandiseRevenue: 100, refund: 100, processingFee: 12 });
    expect(result.revenue).toBe(0);
    expect(result.profit).toBe(-12);
    expect(result.marginPercent).toBeNull();
  });

  it("a fully refunded order with no costs is still n/a, not 0%", () => {
    const result = order({ netMerchandiseRevenue: 100, refund: 100 });
    expect(result.revenue).toBe(0);
    expect(result.profit).toBe(0);
    expect(result.marginPercent).toBeNull();
  });

  it("renders as an empty CSV cell, not a zero", () => {
    // src/app/api/admin/orders/export/route.ts passes marginPercent straight to
    // csvEscape, which is `String(value ?? "")`. A 0 in a spreadsheet column of
    // margins averages in as "broke even" on an order that lost money; an empty
    // cell does not. Pinning the coercion here keeps that deliberate.
    const csvCell = (value: unknown) => String(value ?? "");
    expect(csvCell(order({ netMerchandiseRevenue: 100, refund: 150 }).marginPercent)).toBe("");
    expect(csvCell(order({ netMerchandiseRevenue: 100, processingFee: 10 }).marginPercent)).toBe("90");
  });

  it("never reports a positive margin on a negative profit", () => {
    // The property, across the whole sign space, rather than one example.
    for (const [revenue, refund] of [[100, 0], [100, 60], [100, 100], [100, 150], [100, 400]]) {
      const result = order({ netMerchandiseRevenue: revenue, refund, processingFee: 45 });
      if (result.profit < 0) {
        expect(result.marginPercent === null || result.marginPercent < 0).toBe(true);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// THE SAME CONVENTION WHEREVER A MARGIN IS RENDERED.
//
// There are two other margins on admin surfaces — the lifetime gross and net
// margins on /admin — and each carried its OWN `revenue > 0 ? ... : 0`
// expression. Three copies of a rule is how two of them end up disagreeing, and
// driving the whole profit dashboard through a double here would test the
// harness more than the rule. So the rule is unit-tested once, and each render
// site is pinned to it structurally.
// ---------------------------------------------------------------------------
const SRC = join(process.cwd(), "src");

describe("marginPercentOf is the one rule", () => {
  it("answers for positive revenue and refuses at or below zero", () => {
    expect(marginPercentOf(90, 100)).toBe(90);
    expect(marginPercentOf(-80, -50)).toBeNull();
    expect(marginPercentOf(-12, 0)).toBeNull();
    expect(marginPercentOf(1, Number.NaN)).toBeNull();
  });
});

describe("every margin on an admin surface goes through it", () => {
  it("the lifetime gross and net margins are not computed inline", () => {
    const adminProfit = readFileSync(join(SRC, "lib/admin-profit.ts"), "utf8");
    expect(adminProfit).toMatch(/grossMarginPercent:\s*marginPercentOf\(/);
    expect(adminProfit).toMatch(/netMarginPercent:\s*marginPercentOf\(/);
    // The shape that used to sit here, and that reports 0% on a loss.
    expect(adminProfit).not.toMatch(/MarginPercent:\s*grossRevenue > 0 \?/);
  });

  it("the dashboard renders a null margin as n/a rather than crashing on it", () => {
    const adminPage = readFileSync(join(SRC, "app/admin/page.tsx"), "utf8");
    expect(adminPage).toMatch(/\["Net margin", percent\(/);
    expect(adminPage).toMatch(/\["Gross margin", percent\(/);
    expect(adminPage).toMatch(/value === null \? "n\/a"/);
  });

  it("the order profit panel does the same", () => {
    const panel = readFileSync(join(SRC, "components/admin-order-profit-panel.tsx"), "utf8");
    expect(panel).toMatch(/marginPercent === null \? "margin n\/a"/);
  });
});
