import { describe, expect, it } from "vitest";
import { computeRetainedCommission, getCommissionStateForRefund, getOrderStatusForEventType } from "@/lib/payment-webhook";

describe("computeRetainedCommission (partial-refund proportional commission)", () => {
  // Ambassador earns 15% of a $90 discounted subtotal = $13.50.
  it("keeps the full commission when nothing is refunded", () => {
    expect(computeRetainedCommission({ base: 90, percent: 15, refundedFraction: 0 })).toBe(13.5);
  });

  it("voids the commission on a full refund", () => {
    expect(computeRetainedCommission({ base: 90, percent: 15, refundedFraction: 1 })).toBe(0);
  });

  it("halves the commission when half the order value is refunded", () => {
    expect(computeRetainedCommission({ base: 90, percent: 15, refundedFraction: 0.5 })).toBe(6.75);
  });

  it("reduces proportionally for an arbitrary partial refund and rounds to cents", () => {
    // 30% refunded → keep 70% of $13.50 = $9.45
    expect(computeRetainedCommission({ base: 90, percent: 15, refundedFraction: 0.3 })).toBe(9.45);
  });

  it("clamps out-of-range fractions", () => {
    expect(computeRetainedCommission({ base: 100, percent: 10, refundedFraction: 1.5 })).toBe(0);
    expect(computeRetainedCommission({ base: 100, percent: 10, refundedFraction: -0.2 })).toBe(10);
  });
});

describe("payment webhook helpers", () => {
  it("maps successful payment events to paid status", () => {
    expect(getOrderStatusForEventType("payment.succeeded")).toBe("paid");
  });

  it("maps failed payment events to failed status", () => {
    expect(getOrderStatusForEventType("payment.failed")).toBe("payment_failed");
  });

  it("marks a pending commission as reversed on refund", () => {
    expect(getCommissionStateForRefund("pending")).toEqual({
      status: "reversed",
      reviewRequired: false,
      reviewReason: null,
    });
  });

  it("flags a paid commission for manual review on refund", () => {
    expect(getCommissionStateForRefund("paid")).toEqual({
      status: "manual_review",
      reviewRequired: true,
      reviewReason: "Refund received after commission payment",
    });
  });
});
