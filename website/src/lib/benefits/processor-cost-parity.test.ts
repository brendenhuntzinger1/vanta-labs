import { describe, expect, it } from "vitest";

import { isManualPaymentMethod, processorCostFor } from "@/lib/benefits/processor-cost";

// ---------------------------------------------------------------------------
// M5 moved the processor-cost rule out of two private copies and into one
// module. The move is only worth making if it is PROVABLY the same arithmetic,
// so this file pins the new function against the exact expressions it replaced,
// over a swept input space rather than a handful of examples.
//
// The two originals, transcribed verbatim from the commits that preceded M5:
//
//   profit-engine.computeProfit
//     const feeBase = inputs.processingFeeIncludesTax === false ? revenue : amountCharged;
//     const processingFee = pct(feeBase, inputs.processingFeePercent);
//
//   admin-profit.processingFeeFor
//     if (isManualMethod(order.payment_method)) return 0;
//     const charged = Number(order.amount_paid ?? 0);
//     if (!Number.isFinite(charged) || charged <= 0) return 0;
//     const base = config.processingFeeIncludesTax
//       ? charged
//       : Math.max(0, charged - Number(order.tax_amount ?? 0));
//     return Math.max(0, base * (config.processingFeePercent / 100));
// ---------------------------------------------------------------------------

const round = (v: number) => Math.round(v * 100) / 100;
const pct = (subtotal: number, percent: number) => round(subtotal * (percent / 100));

/** The pre-M5 profit-engine expression. */
function legacyEngineFee(revenue: number, amountCharged: number, percent: number, includesTax?: boolean) {
  const feeBase = includesTax === false ? revenue : amountCharged;
  return pct(feeBase, percent);
}

/**
 * The pre-M5 admin-profit expression, wrapped in the rounding its only consumer
 * applied (`computeOrderProfit` does `round(Math.max(0, input.processingFee))`).
 * Comparing the raw unrounded value would be comparing something no surface
 * ever saw.
 */
function legacyReportFee(charged: number, tax: number, percent: number, includesTax: boolean, method: string | null) {
  const manual = ["cash", "zelle", "venmo", "paypal", "manual", "wire", "ach", "bank"]
    .some((hint) => (method ?? "").toLowerCase().includes(hint));
  if (manual) return 0;
  if (!Number.isFinite(charged) || charged <= 0) return 0;
  const base = includesTax ? charged : Math.max(0, charged - tax);
  return round(Math.max(0, base * (percent / 100)));
}

// Boundary cart values, the live 8% default, plausible real card rates, and a
// zero rate. Tax at 0 and at several real nexus rates.
const REVENUES = [0, 0.01, 5, 35, 39.99, 49.99, 74.99, 99.98, 142.48, 172.47,
                  199.99, 200, 229.96, 263.95, 377.16, 440.02, 742.82, 1000, 4999.99];
const TAX_RATES = [0, 0.0625, 0.07, 0.0825, 0.095];
const PERCENTS = [0, 2.9, 3, 8, 8.5, 15];

describe("processorCostFor reproduces the pre-M5 profit-engine expression", () => {
  it("matches on every swept (revenue, tax, rate, includesTax) combination", () => {
    let checked = 0;
    for (const revenue of REVENUES) {
      for (const rate of TAX_RATES) {
        const taxCollected = round(revenue * rate);
        const amountCharged = round(revenue + taxCollected);
        for (const percent of PERCENTS) {
          for (const includesTax of [undefined, true, false] as const) {
            const expected = legacyEngineFee(revenue, amountCharged, percent, includesTax);
            const actual = processorCostFor({
              cashCollected: amountCharged,
              taxCollected,
              percent,
              includesTax,
            });
            expect(actual, `engine @ rev ${revenue} tax ${taxCollected} pct ${percent} incl ${String(includesTax)}`)
              .toBe(expected);
            checked++;
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(800);
  });
});

describe("processorCostFor reproduces the pre-M5 admin-profit expression", () => {
  it("matches on every swept (charged, tax, rate, method) combination", () => {
    let checked = 0;
    for (const charged of REVENUES) {
      for (const rate of TAX_RATES) {
        const tax = round(charged * rate);
        for (const percent of PERCENTS) {
          for (const includesTax of [true, false]) {
            for (const method of [null, "card", "Card", "cash", "Zelle", "venmo", "bank transfer"]) {
              const expected = legacyReportFee(charged, tax, percent, includesTax, method);
              const actual = processorCostFor({
                cashCollected: charged,
                taxCollected: tax,
                paymentMethod: method,
                percent,
                includesTax,
              });
              expect(actual, `report @ charged ${charged} tax ${tax} pct ${percent} ${String(method)}`)
                .toBe(expected);
              checked++;
            }
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(3000);
  });
});

describe("the manual-method rule survived the move intact", () => {
  it.each(["cash", "Cash on delivery", "zelle", "VENMO", "PayPal", "manual review", "wire", "ACH", "bank transfer"])(
    "%s settles with no processor fee",
    (method) => {
      expect(isManualPaymentMethod(method)).toBe(true);
      expect(processorCostFor({ cashCollected: 500, percent: 8, paymentMethod: method })).toBe(0);
    },
  );

  it.each([null, undefined, "", "card", "credit card", "apple_pay"])("%s is charged", (method) => {
    expect(isManualPaymentMethod(method)).toBe(false);
    expect(processorCostFor({ cashCollected: 500, percent: 8, paymentMethod: method })).toBe(40);
  });
});

describe("degenerate inputs answer 0 rather than a negative or a NaN", () => {
  it.each([
    ["zero charge", { cashCollected: 0, percent: 8 }],
    ["negative charge", { cashCollected: -100, percent: 8 }],
    ["NaN charge", { cashCollected: Number.NaN, percent: 8 }],
    ["infinite charge", { cashCollected: Number.POSITIVE_INFINITY, percent: 8 }],
    ["zero rate", { cashCollected: 100, percent: 0 }],
    ["negative rate", { cashCollected: 100, percent: -8 }],
    ["NaN rate", { cashCollected: 100, percent: Number.NaN }],
  ])("%s", (_label, input) => {
    expect(processorCostFor(input as Parameters<typeof processorCostFor>[0])).toBe(0);
  });

  it("never lets a negative tax ENLARGE the fee base", () => {
    // The pre-M5 report expression did: `charged - (-5)` widened the base by $5.
    // Impossible from a numeric(12,2) tax column, and refused here regardless,
    // because a cost that grows when a value goes negative is a sign error
    // waiting for its first bad row.
    expect(processorCostFor({ cashCollected: 100, taxCollected: -5, percent: 8, includesTax: false }))
      .toBe(8);
  });

  it("clamps a tax larger than the charge instead of going negative", () => {
    expect(processorCostFor({ cashCollected: 10, taxCollected: 40, percent: 8, includesTax: false })).toBe(0);
  });
});

describe("the production configuration, stated as a test", () => {
  // Measured 2026-09-12: profit.processing_fee_percent is blank (so the 8%
  // default applies) and processing_fee_includes_tax is false.
  it("charges 8% of the ex-tax cash on a live order", () => {
    // $229.96 of goods, $16.10 of tax, nothing else.
    expect(processorCostFor({
      cashCollected: 246.06,
      taxCollected: 16.10,
      percent: 8,
      includesTax: false,
    })).toBe(18.40);
  });
});
