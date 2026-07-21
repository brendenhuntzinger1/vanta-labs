import { createHmac } from "crypto";
import { describe, expect, it } from "vitest";
import { createCheckoutSession } from "@/lib/payment-service";
import { processPaymentWebhook } from "@/lib/payment-webhook";

// Webhook signatures are now real HMAC-SHA256 of the payload keyed with the
// secret; tests sign their payloads the same way a real processor would.
function sign(payload: string, secret = "secret") {
  return createHmac("sha256", secret).update(payload, "utf8").digest("hex");
}

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
        // Claiming a total far BELOW the real price (an underpayment attempt)
        // must be rejected. Overpayment claims are harmless because the server
        // charges its own authoritative total, so only underpayment is blocked.
        expectedTotal: 0.01,
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
    const payload = JSON.stringify({ orderId: "demo-order", type: "payment.succeeded", paymentId: "pay-1" });
    const first = await processPaymentWebhook(payload, sign(payload), "secret", "evt-1");
    const second = await processPaymentWebhook(payload, sign(payload), "secret", "evt-1");

    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
  });

  it("does not mark failed payments as paid", async () => {
    const payload = JSON.stringify({ orderId: "demo-failed", type: "payment.failed", paymentId: "pay-2" });
    const result = await processPaymentWebhook(payload, sign(payload), "secret", "evt-2");

    expect(result.status).toBe("payment_failed");
  });

  it("marks verified successful webhooks as paid", async () => {
    const payload = JSON.stringify({ orderId: "demo-paid", type: "payment.succeeded", paymentId: "pay-3" });
    const result = await processPaymentWebhook(payload, sign(payload), "secret", "evt-3");

    expect(result.status).toBe("paid");
  });

  it("rejects webhooks with an invalid signature", async () => {
    const payload = JSON.stringify({ orderId: "demo-bad", type: "payment.succeeded" });
    await expect(processPaymentWebhook(payload, "deadbeef", "secret", "evt-bad")).rejects.toThrow("Invalid webhook signature");
  });
});
