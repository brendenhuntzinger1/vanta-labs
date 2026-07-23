import { describe, expect, it } from "vitest";
import {
  MOCK_EVENT_TYPE_BY_OUTCOME,
  buildMockEventBody,
  buildMockWebhookRequest,
  outcomeForTestCard,
  resolveMockWebhookSecret,
  type MockOrderSnapshot,
} from "@/lib/payment-mock";
import { getOrderStatusForEventType } from "@/lib/payment-webhook";
import { verifyWebhookSignatureImpl } from "@/lib/payment-provider";

const ORDER: MockOrderSnapshot = {
  orderId: "order-abc",
  paymentId: "mock_pay_order-abc",
  customerEmail: "buyer@example.com",
  customerName: "Buyer One",
  shippingAddress: "1 Test St",
  city: "Testville",
  postalCode: "00000",
  currency: "USD",
  subtotal: 100,
  shippingAmount: 5,
  discountAmount: 10,
  amountPaid: 95,
  referralCode: "AMB10",
  ambassadorId: "amb-1",
  couponCode: null,
  customerUserId: "user-1",
  pointsRedeemed: 0,
  items: [
    { productId: "sku-1", productName: "Vial A", unitPrice: 50, quantity: 2, lineTotal: 100 },
  ],
};

describe("mock webhook event body (matches the webhook reader's field contract)", () => {
  it("serializes every field the webhook handler reads, with correct values", () => {
    const parsed = JSON.parse(buildMockEventBody(ORDER, "payment.succeeded"));

    expect(parsed.orderId).toBe("order-abc");
    expect(parsed.type).toBe("payment.succeeded");
    expect(parsed.paymentId).toBe("mock_pay_order-abc");
    expect(parsed.customer).toEqual({
      email: "buyer@example.com",
      fullName: "Buyer One",
      address: "1 Test St",
      city: "Testville",
      postalCode: "00000",
    });
    expect(parsed.amount).toBe(95);
    expect(parsed.subtotal).toBe(100);
    expect(parsed.shippingAmount).toBe(5);
    expect(parsed.discountAmount).toBe(10);
    expect(parsed.currency).toBe("USD");
    expect(parsed.referralCode).toBe("AMB10");
    expect(parsed.ambassadorId).toBe("amb-1");
    expect(parsed.customerUserId).toBe("user-1");
    expect(parsed.items).toEqual([
      { productId: "sku-1", productName: "Vial A", unitPrice: 50, quantity: 2, lineTotal: 100 },
    ]);
  });

  it("supplies a default paymentId and currency when the order omits them", () => {
    const parsed = JSON.parse(buildMockEventBody({ orderId: "order-x" }, "payment.succeeded"));
    expect(parsed.paymentId).toBe("mock_pay_order-x");
    expect(parsed.currency).toBe("USD");
    expect(parsed.amount).toBe(0);
    expect(parsed.items).toEqual([]);
  });
});

describe("mock outcome → order status contract", () => {
  it("maps each outcome to an event type the webhook resolves to the intended status", () => {
    expect(getOrderStatusForEventType(MOCK_EVENT_TYPE_BY_OUTCOME.approve)).toBe("paid");
    expect(getOrderStatusForEventType(MOCK_EVENT_TYPE_BY_OUTCOME.decline)).toBe("payment_failed");
    expect(getOrderStatusForEventType(MOCK_EVENT_TYPE_BY_OUTCOME.cancel)).toBe("canceled");
    expect(getOrderStatusForEventType(MOCK_EVENT_TYPE_BY_OUTCOME.refund)).toBe("refunded");
  });
});

describe("signed mock webhook request", () => {
  it("produces a body the shared verifier accepts with the same secret", () => {
    const req = buildMockWebhookRequest(ORDER, "approve", { secret: "s3cret", eventId: "evt-1" });
    expect(req.eventType).toBe("payment.succeeded");
    expect(req.eventId).toBe("evt-1");
    expect(verifyWebhookSignatureImpl(req.body, req.signature, "s3cret")).toBe(true);
  });

  it("does not verify under a different secret", () => {
    const req = buildMockWebhookRequest(ORDER, "approve", { secret: "s3cret", eventId: "evt-1" });
    expect(verifyWebhookSignatureImpl(req.body, req.signature, "wrong")).toBe(false);
  });

  it("generates a unique event id per call by default", () => {
    const a = buildMockWebhookRequest(ORDER, "approve", { secret: "s" });
    const b = buildMockWebhookRequest(ORDER, "approve", { secret: "s" });
    expect(a.eventId).not.toBe(b.eventId);
  });
});

describe("test card outcomes and secret fallback", () => {
  it("treats the standard success card as an approval and known decline cards as declines", () => {
    expect(outcomeForTestCard("4242 4242 4242 4242")).toBe("approve");
    expect(outcomeForTestCard("4000 0000 0000 0002")).toBe("decline");
    expect(outcomeForTestCard("4000000000009995")).toBe("decline");
  });

  it("falls back to a fixed dev secret only when none is configured", () => {
    expect(resolveMockWebhookSecret("real-secret")).toBe("real-secret");
    expect(resolveMockWebhookSecret("")).toBe("mock-webhook-secret");
    expect(resolveMockWebhookSecret(undefined)).toBe("mock-webhook-secret");
  });
});
