import { describe, it, expect } from "vitest";
import { expectedOrderTotal, isTotalMismatch, maxShippingProtectionFee } from "@/lib/reconciliation-math";

const base = { subtotal: 100, shipping: 15, tax: 0, cardFee: 0, discount: 0, storeCredit: 0, pointsDollars: 0 };
// Per-order protection allowance: 3% of the merchandise subtotal.
const protection = maxShippingProtectionFee(base.subtotal); // $3 on a $100 subtotal

describe("expectedOrderTotal", () => {
  it("includes tax and card fee (the pre-fix omission that false-flagged taxed orders)", () => {
    expect(expectedOrderTotal({ ...base, tax: 8, cardFee: 3 })).toBe(126); // 100 + 15 + 8 + 3
  });
  it("subtracts discount, store credit, and points", () => {
    expect(expectedOrderTotal({ ...base, discount: 10, storeCredit: 5, pointsDollars: 2 })).toBe(98); // 115 - 10 - 5 - 2
  });
});

describe("maxShippingProtectionFee", () => {
  it("is the percentage protection fee for the order's subtotal", () => {
    expect(maxShippingProtectionFee(100)).toBe(3);
    expect(maxShippingProtectionFee(500)).toBe(15);
    expect(maxShippingProtectionFee(0)).toBe(0);
  });
});

describe("isTotalMismatch", () => {
  it("does NOT flag a taxed order that reconciles (regression: was flagged before the fix)", () => {
    const expected = expectedOrderTotal({ ...base, tax: 8 }); // 123
    expect(isTotalMismatch(123, expected, protection)).toBe(false);
  });
  it("does NOT flag an order that paid the shipping-protection fee on top", () => {
    const expected = expectedOrderTotal(base); // 115
    expect(isTotalMismatch(115 + protection, expected, protection)).toBe(false); // within the order's protection fee
  });
  it("FLAGS underpayment", () => {
    const expected = expectedOrderTotal({ ...base, tax: 8 }); // 123
    expect(isTotalMismatch(100, expected, protection)).toBe(true);
  });
  it("FLAGS an overage beyond the order's protection fee", () => {
    const expected = expectedOrderTotal(base); // 115
    expect(isTotalMismatch(115 + protection + 0.51, expected, protection)).toBe(true);
  });
  it("larger orders get a proportionally larger legitimate overage window", () => {
    const big = { ...base, subtotal: 1000 };
    const expected = expectedOrderTotal(big); // 1015
    const bigProtection = maxShippingProtectionFee(big.subtotal); // 30
    expect(isTotalMismatch(expected + bigProtection, expected, bigProtection)).toBe(false);
    expect(isTotalMismatch(expected + bigProtection + 0.5, expected, bigProtection)).toBe(true);
  });
});
