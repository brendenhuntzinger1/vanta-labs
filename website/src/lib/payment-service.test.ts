import { describe, expect, it } from "vitest";
import { createCheckoutSession } from "@/lib/payment-service";
import { processPaymentWebhook } from "@/lib/payment-webhook";

describe("payment service", () => {
  it("rejects altered prices", async () => {
    await expect(
      createCheckoutSession({
        items: [{ id: "bpc-157-10mg", quantity: 1 }],
        customer: {
          email: "client@example.com",
          fullName: "Alex Morgan",
          address: "88 Meridian Avenue",
          city: "Austin",
          postalCode: "78701",
          country: "United States",
        },
        expectedTotal: 999999,
      }),
    ).rejects.toThrow("Altered total detected");
  });

  it("rejects invalid product ids", async () => {
    await expect(
      createCheckoutSession({
        items: [{ id: "bad-id", quantity: 1 }],
        customer: {
          email: "client@example.com",
          fullName: "Alex Morgan",
          address: "88 Meridian Avenue",
          city: "Austin",
          postalCode: "78701",
          country: "United States",
        },
      }),
    ).rejects.toThrow("Invalid product id");
  });

  it("rejects expired promotions", async () => {
    await expect(
      createCheckoutSession({
        items: [{ id: "bpc-157-10mg", quantity: 1 }],
        customer: {
          email: "client@example.com",
          fullName: "Alex Morgan",
          address: "88 Meridian Avenue",
          city: "Austin",
          postalCode: "78701",
          country: "United States",
        },
        referralCode: "EXPIRED10",
      }),
    ).rejects.toThrow("Invalid referral code");
  });

  it("does not create duplicate orders from duplicate webhooks", async () => {
    const first = await processPaymentWebhook(
      JSON.stringify({ orderId: "demo-order", type: "payment.succeeded", paymentId: "pay-1" }),
      "sig",
      "secret",
      "evt-1",
    );
    const second = await processPaymentWebhook(
      JSON.stringify({ orderId: "demo-order", type: "payment.succeeded", paymentId: "pay-1" }),
      "sig",
      "secret",
      "evt-1",
    );

    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
  });

  it("does not mark failed payments as paid", async () => {
    const result = await processPaymentWebhook(
      JSON.stringify({ orderId: "demo-failed", type: "payment.failed", paymentId: "pay-2" }),
      "sig",
      "secret",
      "evt-2",
    );

    expect(result.status).toBe("payment_failed");
  });

  it("marks verified successful webhooks as paid", async () => {
    const result = await processPaymentWebhook(
      JSON.stringify({ orderId: "demo-paid", type: "payment.succeeded", paymentId: "pay-3" }),
      "sig",
      "secret",
      "evt-3",
    );

    expect(result.status).toBe("paid");
  });
});
