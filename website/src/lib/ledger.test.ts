import { describe, it, expect } from "vitest";
import { isEarnedCommission, isPaidOrderStatus, netOrderRevenue, sumEarnedCommission } from "@/lib/ledger";

describe("canonical ledger predicates (reporting reconciliation)", () => {
  it("earned commission excludes only reversed/voided/manual_review (case-insensitive)", () => {
    for (const s of ["pending", "approved_for_payout", "paid", "commission_paid"]) {
      expect(isEarnedCommission(s)).toBe(true);
    }
    for (const s of ["reversed", "voided", "manual_review", "REVERSED", "Manual_Review"]) {
      expect(isEarnedCommission(s)).toBe(false);
    }
    expect(isEarnedCommission(null)).toBe(true);
    expect(isEarnedCommission(undefined)).toBe(true);
  });

  it("paid-order status is case-insensitive and covers the captured synonyms only", () => {
    for (const s of ["paid", "PAID", "completed", "succeeded"]) expect(isPaidOrderStatus(s)).toBe(true);
    for (const s of ["pending_payment", "awaiting_verification", "refunded", "canceled", "payment_failed", null, undefined]) {
      expect(isPaidOrderStatus(s)).toBe(false);
    }
  });

  it("net revenue subtracts refunds, is 2-decimal, and keeps its sign", () => {
    expect(netOrderRevenue({ amount_paid: 100, refund_amount: 0 })).toBe(100);
    expect(netOrderRevenue({ amount_paid: 100, refund_amount: 30 })).toBe(70);
    // OVER-REFUND IS SIGNED, NOT FLOORED. This asserted 0 while the profit
    // engine reported -50 for the same order, which is two definitions of
    // revenue in a module whose whole purpose is that there is one. A clamp
    // does not make the money come back. See revenue-clamp-agreement.test.ts.
    expect(netOrderRevenue({ amount_paid: 100, refund_amount: 150 })).toBe(-50);
    expect(netOrderRevenue({ amount_paid: 49.99, refund_amount: 0 })).toBe(49.99);
    expect(netOrderRevenue({ amount_paid: null, refund_amount: null })).toBe(0);
  });

  it("sumEarnedCommission ignores clawed-back rows — the ONE definition every surface shares", () => {
    const rows = [
      { commission_amount: 10, payment_status: "paid" },
      { commission_amount: 5, payment_status: "reversed" },
      { commission_amount: 7, payment_status: "pending" },
      { commission_amount: 3, payment_status: "manual_review" },
      { commission_amount: 4, payment_status: "voided" },
    ];
    expect(sumEarnedCommission(rows)).toBe(17); // 10 + 7 only
  });
});

// EMAIL-02 / EMAIL-03. "Is this revenue" (isSaleOrder) and "did they buy
// product" are different questions. A membership charge is revenue and is not a
// purchase of product; a replacement reship is neither.
describe("isProductPurchaseOrder", () => {
  it("a plain product order is a purchase, including a legacy row with no order_type", async () => {
    const { isProductPurchaseOrder } = await import("@/lib/ledger");
    expect(isProductPurchaseOrder({ order_type: "product" })).toBe(true);
    expect(isProductPurchaseOrder({ order_type: null })).toBe(true);
    expect(isProductPurchaseOrder({})).toBe(true);
    expect(isProductPurchaseOrder({ order_type: "product", replacement_of: null })).toBe(true);
  });

  it("a membership charge is not", async () => {
    const { isProductPurchaseOrder } = await import("@/lib/ledger");
    expect(isProductPurchaseOrder({ order_type: "membership" })).toBe(false);
    expect(isProductPurchaseOrder({ order_type: "Membership" })).toBe(false);
  });

  it("a replacement reship is not — by its type, or by the original it points at", async () => {
    const { isProductPurchaseOrder, isSaleOrder } = await import("@/lib/ledger");
    expect(isProductPurchaseOrder({ order_type: "replacement" })).toBe(false);
    expect(isProductPurchaseOrder({ order_type: "product", replacement_of: "order-original" })).toBe(false);
    // And the revenue predicate is untouched: a membership is still a sale.
    expect(isSaleOrder("membership")).toBe(true);
    expect(isSaleOrder("replacement")).toBe(false);
  });
});
