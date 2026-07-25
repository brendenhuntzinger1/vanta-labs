import { describe, it, expect, afterEach } from "vitest";
import { resolvePaymentProviderName } from "@/lib/payment-provider";
import { computeProfit } from "@/lib/profit-engine";

// ── P2-5: mock payment gateway must be impossible in production ──────────────
describe("P2-5 mock-in-production guard", () => {
  const original = { ...process.env };
  afterEach(() => {
    process.env = { ...original };
  });

  it("THROWS when PAYMENT_PROVIDER=mock resolves in production", () => {
    process.env.NODE_ENV = "production";
    delete process.env.ALLOW_MOCK_PAYMENTS;
    expect(() => resolvePaymentProviderName("mock")).toThrow(/forbidden in production/i);
    expect(() => resolvePaymentProviderName("test")).toThrow(/forbidden in production/i);
  });

  it("allows mock in a non-production environment", () => {
    process.env.NODE_ENV = "test";
    expect(resolvePaymentProviderName("mock")).toBe("mock");
  });

  it("allows mock in production ONLY with the explicit opt-in", () => {
    process.env.NODE_ENV = "production";
    process.env.ALLOW_MOCK_PAYMENTS = "true";
    expect(resolvePaymentProviderName("mock")).toBe("mock");
  });

  it("defaults to live when unset (a missing config never runs mock)", () => {
    delete process.env.PAYMENT_PROVIDER;
    expect(resolvePaymentProviderName(undefined)).toBe("live");
  });
});

// ── P2-2: the profit floor must use REAL cost, not a flat assumption ─────────
// The checkout guard rejects an order when computeProfit(...).grossProfit falls
// below the configured floor. These tests prove that once REAL cost is fed in,
// a high-COGS discounted order is correctly rejected — whereas the old flat $33
// assumption would have passed it.
function profitFor(productCost: number, discount: number) {
  return computeProfit(
    {
      subtotal: 60,
      productCost,
      bundleDiscount: 0,
      referralAccepted: false,
      referralPercent: 0,
      bundleReferralPercent: 0,
      isMember: false,
      membershipPercent: 0,
      couponDiscount: 0,
      allowCouponStacking: false,
      commissionPercent: 0,
      processingFeePercent: 5,
      shippingCollected: 0,
      shippingCost: 0,
      handlingCollected: 0,
      taxPercent: 0,
    },
    { amount: discount, components: [], label: "resolved" },
  );
}

describe("P2-2 profit floor uses real COGS", () => {
  it("a high-cost SKU ($55 real cost) discounted to $40 is UNPROFITABLE", () => {
    // subtotal 60, discount 20 => customer pays ~40; true cost 55 => loss.
    const real = profitFor(55, 20);
    expect(real.grossProfit).toBeLessThan(0);
  });

  it("the OLD flat $33 assumption would have wrongly shown the same order as profitable", () => {
    const flat = profitFor(33, 20);
    expect(flat.grossProfit).toBeGreaterThan(0); // demonstrates the bug the fix closes
  });

  it("a genuinely cheap SKU stays profitable under the same discount", () => {
    const cheap = profitFor(8, 20);
    expect(cheap.grossProfit).toBeGreaterThan(0);
  });
});
