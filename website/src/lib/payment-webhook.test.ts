import { describe, expect, it } from "vitest";
import { getCommissionStateForRefund, getOrderStatusForEventType } from "@/lib/payment-webhook";

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
