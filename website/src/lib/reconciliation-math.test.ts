import { describe, it, expect } from "vitest";
import { expectedOrderTotal, isTotalMismatch } from "@/lib/reconciliation-math";

const base = { subtotal: 100, shipping: 15, tax: 0, cardFee: 0, discount: 0, storeCredit: 0, pointsDollars: 0 };

describe("expectedOrderTotal", () => {
  it("includes tax and card fee (the pre-fix omission that false-flagged taxed orders)", () => {
    expect(expectedOrderTotal({ ...base, tax: 8, cardFee: 3 })).toBe(126); // 100 + 15 + 8 + 3
  });
  it("subtracts discount, store credit, and points", () => {
    expect(expectedOrderTotal({ ...base, discount: 10, storeCredit: 5, pointsDollars: 2 })).toBe(98); // 115 - 10 - 5 - 2
  });
});

describe("isTotalMismatch", () => {
  it("does NOT flag a taxed order that reconciles (regression: was flagged before the fix)", () => {
    const expected = expectedOrderTotal({ ...base, tax: 8 }); // 123
    expect(isTotalMismatch(123, expected)).toBe(false);
  });
  it("does NOT flag an order that paid the shipping-protection fee on top", () => {
    const expected = expectedOrderTotal(base); // 115
    expect(isTotalMismatch(115 + 4.99, expected)).toBe(false); // within max protection fee
  });
  it("FLAGS underpayment", () => {
    const expected = expectedOrderTotal({ ...base, tax: 8 }); // 123
    expect(isTotalMismatch(100, expected)).toBe(true);
  });
  it("FLAGS an overage beyond the max protection fee", () => {
    const expected = expectedOrderTotal(base); // 115
    expect(isTotalMismatch(115 + 5.5, expected)).toBe(true);
  });
});
