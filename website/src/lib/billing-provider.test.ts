import { describe, expect, it } from "vitest";
import {
  MockBillingProvider,
  NoopBillingProvider,
  getBillingProvider,
  type ChargeCardInput,
} from "@/lib/billing-provider";

const baseCharge: ChargeCardInput = {
  billingProviderCustomerId: "mock_cus_x",
  paymentMethodRef: "pm_test",
  amountCents: 2999,
  currency: "USD",
  description: "Membership renewal",
  idempotencyKey: "idem-1",
};

describe("billing provider selection (swap-by-config)", () => {
  it("returns the mock provider for mock/test and noop otherwise", () => {
    expect(getBillingProvider("mock")).toBeInstanceOf(MockBillingProvider);
    expect(getBillingProvider("test")).toBeInstanceOf(MockBillingProvider);
    expect(getBillingProvider("noop")).toBeInstanceOf(NoopBillingProvider);
    expect(getBillingProvider(undefined)).toBeInstanceOf(NoopBillingProvider);
  });
});

describe("mock billing provider (fake recurring charges)", () => {
  it("creates a deterministic customer id from the email", async () => {
    const provider = new MockBillingProvider();
    const result = await provider.createCustomer({ email: "Buyer@Example.com", name: "Buyer" });
    expect(result.success).toBe(true);
    expect(result.billingProviderCustomerId).toBe("mock_cus_buyerexamplecom");
  });

  it("succeeds on a normal charge", async () => {
    const provider = new MockBillingProvider();
    const result = await provider.chargeCard(baseCharge);
    expect(result.success).toBe(true);
    expect(result.providerChargeId).toBe("mock_ch_idem-1");
  });

  it("declines when the payment method marks a decline test card", async () => {
    const provider = new MockBillingProvider();
    const declined = await provider.chargeCard({ ...baseCharge, paymentMethodRef: "pm_decline" });
    expect(declined.success).toBe(false);
    expect(declined.error).toContain("declined");
  });
});

describe("noop billing provider stays honest", () => {
  it("always reports failure so no unbacked charge is invented", async () => {
    const provider = new NoopBillingProvider();
    expect((await provider.chargeCard(baseCharge)).success).toBe(false);
    expect((await provider.createCustomer({ email: "a@b.com" })).success).toBe(false);
  });
});
