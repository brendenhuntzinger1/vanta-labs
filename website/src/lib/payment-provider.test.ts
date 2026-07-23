import { describe, expect, it } from "vitest";
import {
  LivePaymentProvider,
  MockPaymentProvider,
  getPaymentProvider,
  isMockPaymentMode,
  resolvePaymentProviderName,
  signWebhookPayload,
  verifyWebhookSignatureImpl,
} from "@/lib/payment-provider";

describe("payment provider selection (swap-by-config)", () => {
  it("returns the mock gateway for mock/test names", () => {
    expect(getPaymentProvider("mock")).toBeInstanceOf(MockPaymentProvider);
    expect(getPaymentProvider("test")).toBeInstanceOf(MockPaymentProvider);
    expect(getPaymentProvider("MOCK")).toBeInstanceOf(MockPaymentProvider);
  });

  it("returns the live provider for live/unknown names and defaults to live", () => {
    expect(getPaymentProvider("live")).toBeInstanceOf(LivePaymentProvider);
    expect(getPaymentProvider("stripe")).toBeInstanceOf(LivePaymentProvider);
    expect(getPaymentProvider("")).toBeInstanceOf(LivePaymentProvider);
  });

  it("normalizes provider names", () => {
    expect(resolvePaymentProviderName("mock")).toBe("mock");
    expect(resolvePaymentProviderName(" Test ")).toBe("mock");
    expect(resolvePaymentProviderName("live")).toBe("live");
    expect(resolvePaymentProviderName(undefined)).toBe("live");
  });

  it("reports mock mode only for the mock provider", () => {
    expect(isMockPaymentMode("mock")).toBe(true);
    expect(isMockPaymentMode("live")).toBe(false);
  });
});

describe("mock gateway checkout session", () => {
  it("routes the shopper to the internal sandbox pay page", async () => {
    const provider = new MockPaymentProvider();
    const result = await provider.createCheckoutSession({
      orderId: "order-123",
      customerEmail: "a@b.com",
      amount: 4999,
      currency: "USD",
    });

    expect(result.paymentId).toBe("mock_pay_order-123");
    expect(result.hostedCheckoutUrl).toContain("/pay/mock/order-123");
  });
});

describe("webhook signature (shared sign/verify)", () => {
  const secret = "test-secret";
  const body = JSON.stringify({ orderId: "o1", type: "payment.succeeded" });

  it("verifies a signature it produced", () => {
    const sig = signWebhookPayload(body, secret);
    expect(verifyWebhookSignatureImpl(body, sig, secret)).toBe(true);
  });

  it("tolerates a sha256= prefix", () => {
    const sig = signWebhookPayload(body, secret);
    expect(verifyWebhookSignatureImpl(body, `sha256=${sig}`, secret)).toBe(true);
  });

  it("rejects a tampered body, wrong secret, or missing pieces", () => {
    const sig = signWebhookPayload(body, secret);
    expect(verifyWebhookSignatureImpl(`${body} `, sig, secret)).toBe(false);
    expect(verifyWebhookSignatureImpl(body, sig, "other-secret")).toBe(false);
    expect(verifyWebhookSignatureImpl(body, "", secret)).toBe(false);
    expect(verifyWebhookSignatureImpl(body, sig, "")).toBe(false);
  });

  it("both providers verify with the same shared implementation", () => {
    const sig = signWebhookPayload(body, secret);
    expect(new MockPaymentProvider().verifyWebhookSignature(body, sig, secret)).toBe(true);
    expect(new LivePaymentProvider().verifyWebhookSignature(body, sig, secret)).toBe(true);
  });
});
