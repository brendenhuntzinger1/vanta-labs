import { createHmac } from "crypto";
import { describe, expect, it, vi } from "vitest";
import { createCheckoutSession } from "@/lib/payment-service";
import { processPaymentWebhook } from "@/lib/payment-webhook";

// These two fakes used to live in vitest.setup.ts, where they were applied to
// every suite in the repo. They belong to this suite, so this suite asks for them.
vi.mock("@/lib/catalog", async () => (await import("@/test-support/payment-suite-fakes")).catalogModule());
vi.mock("@/lib/supabase-server", async () => (await import("@/test-support/payment-suite-fakes")).supabaseServerModule());


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
          state: "TX",
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
          state: "TX",
          postalCode: "78701",
          country: "United States",
        },
      }),
    ).rejects.toThrow("Invalid product id");
  });

  it("drops an invalid/stale referral instead of hard-blocking checkout", async () => {
    // A referral that has gone stale (unknown code, or an ambassador removed
    // AFTER the customer applied it) must never fail the sale. It is dropped
    // (no discount, no commission) and checkout proceeds — here it advances PAST
    // referral validation into the card provider, which then fails for its own
    // reason (this test env configures no gateway credentials). What is being
    // asserted is that the failure is NOT "Invalid referral code": the stale code
    // was dropped rather than blocking the sale.
    //
    // Matched on the referral message rather than the provider's, so this stays
    // true as the card provider evolves — it previously asserted the pre-Veyra
    // stub's wording and broke the moment a real processor was wired in.
    const error = await createCheckoutSession({
      items: [{ id: "bpc-157-10mg", quantity: 1 }],
      customer: {
        email: "client@example.com",
        fullName: "Alex Morgan",
        address: "88 Meridian Avenue",
        city: "Austin",
        state: "TX",
        postalCode: "78701",
        country: "United States",
      },
      referralCode: "EXPIRED10",
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain("Invalid referral code");
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
