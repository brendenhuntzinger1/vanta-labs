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

  it("net revenue subtracts refunds, is 2-decimal, and never goes below zero", () => {
    expect(netOrderRevenue({ amount_paid: 100, refund_amount: 0 })).toBe(100);
    expect(netOrderRevenue({ amount_paid: 100, refund_amount: 30 })).toBe(70);
    expect(netOrderRevenue({ amount_paid: 100, refund_amount: 150 })).toBe(0); // over-refund clamps to 0
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
