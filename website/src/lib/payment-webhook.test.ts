import { describe, expect, it } from "vitest";
import { computeRetainedCommission, getCommissionStateForRefund, getOrderStatusForEventType, resolveRefundOutcome } from "@/lib/payment-webhook";

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

describe("resolveRefundOutcome (F2/A5 — partial refunds & chargebacks)", () => {
  // Order: merchandise $100, +$10 ship +$8 tax → charged $118.
  const base = { amountPaid: 118, merchandiseBase: 100, existingRefundAmount: 0 };

  it("records a FULL refund as refunded with the full amount and full reversal", () => {
    const o = resolveRefundOutcome({ eventType: "refund.completed", nextStatus: "refunded", refundEventAmount: 118, ...base });
    expect(o.paymentStatus).toBe("refunded");
    expect(o.recordedRefundAmount).toBe(118);
    expect(o.refundedFraction).toBe(1);
    expect(o.shouldRestock).toBe(true);
  });

  it("treats a refund event with no amount as a full refund (processor omitted it)", () => {
    const o = resolveRefundOutcome({ eventType: "refund.completed", nextStatus: "refunded", refundEventAmount: 0, ...base });
    expect(o.paymentStatus).toBe("refunded");
    expect(o.recordedRefundAmount).toBe(118);
    expect(o.isFullRefund).toBe(true);
  });

  it("records a PARTIAL refund as partially_refunded with only the returned amount", () => {
    const o = resolveRefundOutcome({ eventType: "refund.completed", nextStatus: "refunded", refundEventAmount: 30, ...base });
    expect(o.paymentStatus).toBe("partially_refunded");
    expect(o.recordedRefundAmount).toBe(30); // NOT the full 118
    expect(o.refundedFraction).toBeCloseTo(0.3); // 30 / 100 merchandise base
    expect(o.shouldRestock).toBe(false); // never over-restock on partial
  });

  it("accumulates repeated partial refunds and never exceeds the amount paid", () => {
    const o = resolveRefundOutcome({ eventType: "refund.completed", nextStatus: "refunded", refundEventAmount: 30, ...base, existingRefundAmount: 100 });
    expect(o.recordedRefundAmount).toBe(118); // min(118, 100 + 30)
    expect(o.paymentStatus).toBe("partially_refunded");
  });

  it("prorates commission on the CUMULATIVE refunded amount across multiple partials", () => {
    // Two partials on the same order: 30% of merchandise, then another 40%.
    // Cumulative = 70% refunded, so the ambassador must retain 30% of commission.
    const first = resolveRefundOutcome({ eventType: "refund.completed", nextStatus: "refunded", refundEventAmount: 30, ...base, existingRefundAmount: 0 });
    expect(first.refundedFraction).toBeCloseTo(0.3);

    const second = resolveRefundOutcome({ eventType: "refund.completed", nextStatus: "refunded", refundEventAmount: 40, ...base, existingRefundAmount: 30 });
    // Was 0.4 (this-event-only) before the fix; must be 0.7 cumulative.
    expect(second.refundedFraction).toBeCloseTo(0.7);

    // Commission on $100 merch @ 10% = $10 original; after 70% refunded → $3 retained.
    expect(computeRetainedCommission({ base: 100, percent: 10, refundedFraction: second.refundedFraction })).toBeCloseTo(3);
  });

  it("always treats a chargeback as a FULL reversal even with a partial amount (A5)", () => {
    const o = resolveRefundOutcome({ eventType: "chargeback.created", nextStatus: "refunded", refundEventAmount: 30, ...base });
    expect(o.isChargeback).toBe(true);
    expect(o.paymentStatus).toBe("refunded");
    expect(o.refundedFraction).toBe(1);
    expect(o.recordedRefundAmount).toBe(118);
    expect(o.shouldRestock).toBe(true);
  });

  it("treats a cancel as a full reversal that records no refund dollars", () => {
    const o = resolveRefundOutcome({ eventType: "payment.canceled", nextStatus: "canceled", refundEventAmount: 0, ...base });
    expect(o.paymentStatus).toBe("canceled");
    expect(o.recordedRefundAmount).toBe(0);
    expect(o.refundedFraction).toBe(1);
    expect(o.shouldRestock).toBe(true);
  });

  it("is a no-op for a non-refund (paid) event", () => {
    const o = resolveRefundOutcome({ eventType: "payment.succeeded", nextStatus: "paid", refundEventAmount: 0, ...base });
    expect(o.isRefundEvent).toBe(false);
    expect(o.paymentStatus).toBe("paid");
    expect(o.shouldRestock).toBe(false);
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
