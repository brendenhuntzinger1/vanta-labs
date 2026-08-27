import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// THE MASTER SWITCH HAS TO REACH THE BROWSER, NOT JUST EXIST IN THE DATABASE.
//
// Same lesson as referral-rate-delivery.test.ts, and the same shape of defect.
// The arithmetic was never wrong: quote-order.ts reads
// getReferralProgramConfig().enabled and refuses correctly. What was missing is
// that nothing ever handed the cart that boolean.
//
// /api/catalog/promotions is the ONLY channel the cart has for programme-level
// config, and it serialised referralDiscountPercent and referralMinimumOrder
// while dropping `enabled` on the floor. So the switch could be off, the cart
// would still preview "15% customer discount", and the pay button answered
// HTTP 400 — reproduced end to end against a production build.
//
// A gate the client cannot see is not a gate. This file tests the DELIVERY.
// ---------------------------------------------------------------------------

const state = {
  referralEnabled: true,
  throwOnConfig: false,
};

vi.mock("@/lib/admin-control", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@/lib/admin-control");
  return {
    ...actual,
    getHomepageControlConfig: async () => ({ promoBuy3Get1Enabled: false, bundleStacking: false, bundleConfig: null }),
    getSalesTaxSettings: async () => ({ nexusStates: [], rateOverrides: {}, provider: "builtin", taxjarApiKey: "", avalaraLicenseKey: "" }),
    getShippingConfig: async () => ({ domesticFee: 15, freeShippingThreshold: 200, internationalFee: 60, internationalFreeShippingThreshold: 600, handlingFeeRate: 0 }),
    getReferralProgramConfig: async () => {
      if (state.throwOnConfig) throw new Error("control read failed");
      return {
        enabled: state.referralEnabled,
        discountPercent: 10,
        bundleReferralPercent: 5,
        personalDiscountPercent: 20,
        defaultCommissionPercent: 10,
        commissionsPaused: false,
      };
    },
  };
});

vi.mock("@/lib/ambassador-settings", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@/lib/ambassador-settings");
  return {
    ...actual,
    getAmbassadorProgramSettings: async () => ({
      minimumQualifyingOrder: 100, minimumPayoutThreshold: 100, commissionHoldDays: 30,
      stored: { minimumQualifyingOrder: true, minimumPayoutThreshold: true, commissionHoldDays: true },
    }),
  };
});

vi.mock("@/lib/membership", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@/lib/membership");
  return { ...actual, getActiveMembershipTiers: async () => [] };
});

const { GET } = await import("@/app/api/catalog/promotions/route");

async function payload() {
  const response = await GET();
  return await response.json() as Record<string, unknown>;
}

beforeEach(() => {
  state.referralEnabled = true;
  state.throwOnConfig = false;
});

describe("the referral master switch reaches the cart", () => {
  it("reports the programme as on when it is on", async () => {
    state.referralEnabled = true;
    expect((await payload()).referralProgramEnabled).toBe(true);
  });

  // THE ONE THAT MATTERS. Without this field the cart advertises and applies a
  // discount that create-session then refuses with HTTP 400.
  it("reports the programme as off when it is off", async () => {
    state.referralEnabled = false;
    expect((await payload()).referralProgramEnabled).toBe(false);
  });

  it("sends a real boolean, never a string or a missing key", async () => {
    state.referralEnabled = false;
    const body = await payload();
    expect(Object.hasOwn(body, "referralProgramEnabled")).toBe(true);
    expect(typeof body.referralProgramEnabled).toBe("boolean");
  });

  // LOCKSTEP ON FAILURE. The route's catch answers with the same defaults the
  // server itself falls back to, so preview and charge cannot disagree during
  // an outage. getReferralProgramConfig's own fallback is `enabled: true`, so
  // answering false here would strip a real discount from every referred
  // shopper for the duration of a config hiccup.
  it("answers ON when the config read fails, matching the server's own fallback", async () => {
    state.throwOnConfig = true;
    const body = await payload();
    expect(body.success).toBe(true);
    expect(body.referralProgramEnabled).toBe(true);
  });

  it("still carries the rate and the minimum alongside the switch", async () => {
    state.referralEnabled = false;
    const body = await payload();
    expect(body.referralDiscountPercent).toBe(10);
    expect(body.referralMinimumOrder).toBe(100);
  });
});
