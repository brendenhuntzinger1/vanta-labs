import { describe, expect, it, afterEach, vi } from "vitest";
import { getBillingProvider, MockBillingProvider, NoopBillingProvider } from "@/lib/billing-provider";

// MockBillingProvider.chargeCard succeeds for any paymentMethodRef that is not a
// decline test card, and startMembershipSignup passes `paymentMethodRef: null`.
// So BILLING_PROVIDER=mock in production would hand a fully active membership —
// plus a succeeded billing event at the full tier price and a welcome email — to
// any authenticated customer who POSTs /api/membership/subscribe without a card
// token. The one-time order lane has guarded this for a while; the recurring
// lane had not.

function setNodeEnv(value: string) {
  vi.stubEnv("NODE_ENV", value);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("getBillingProvider production guard", () => {
  it("refuses the mock recurring provider in production", () => {
    setNodeEnv("production");
    vi.stubEnv("ALLOW_MOCK_PAYMENTS", "");
    expect(() => getBillingProvider("mock")).toThrow(/forbidden in production/);
    expect(() => getBillingProvider("test")).toThrow(/forbidden in production/);
  });

  it("names the actual consequence so the error is actionable", () => {
    setNodeEnv("production");
    vi.stubEnv("ALLOW_MOCK_PAYMENTS", "");
    expect(() => getBillingProvider("mock")).toThrow(/without charging/);
  });

  it("allows mock outside production", () => {
    setNodeEnv("development");
    expect(getBillingProvider("mock")).toBeInstanceOf(MockBillingProvider);
    setNodeEnv("test");
    expect(getBillingProvider("mock")).toBeInstanceOf(MockBillingProvider);
  });

  it("honours the explicit non-prod opt-in escape hatch", () => {
    setNodeEnv("production");
    vi.stubEnv("ALLOW_MOCK_PAYMENTS", "true");
    expect(getBillingProvider("mock")).toBeInstanceOf(MockBillingProvider);
  });

  it("defaults to the noop provider, which never reports a charge as succeeded", async () => {
    setNodeEnv("production");
    const provider = getBillingProvider(undefined);
    expect(provider).toBeInstanceOf(NoopBillingProvider);
    const result = await provider.chargeCard({
      billingProviderCustomerId: null, paymentMethodRef: null, amountCents: 24990,
      currency: "usd", description: "annual", idempotencyKey: "k",
    });
    expect(result.success).toBe(false);
  });

  it("an unrecognised provider name falls back to noop, never to mock", () => {
    setNodeEnv("production");
    expect(getBillingProvider("stripe-someday")).toBeInstanceOf(NoopBillingProvider);
    expect(getBillingProvider("")).toBeInstanceOf(NoopBillingProvider);
  });

  it("the mock still declines a decline-marked card outside production", async () => {
    setNodeEnv("development");
    const result = await new MockBillingProvider().chargeCard({
      billingProviderCustomerId: null, paymentMethodRef: "decline", amountCents: 999,
      currency: "usd", description: "monthly", idempotencyKey: "k",
    });
    expect(result.success).toBe(false);
  });

  it("documents the hole: a null payment ref succeeds on the mock", async () => {
    setNodeEnv("development");
    const result = await new MockBillingProvider().chargeCard({
      billingProviderCustomerId: null, paymentMethodRef: null, amountCents: 24990,
      currency: "usd", description: "annual", idempotencyKey: "k",
    });
    // This is exactly why the production guard above must exist.
    expect(result.success).toBe(true);
  });
});
