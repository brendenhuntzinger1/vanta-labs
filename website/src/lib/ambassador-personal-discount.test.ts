import { describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// THREE PERCENTAGES THAT MUST NEVER MOVE TOGETHER.
//
//   A. PERSONAL   — what an approved ambassador saves on their OWN order (20%)
//   B. CUSTOMER   — what someone using the ambassador's code saves      (10%)
//   C. COMMISSION — what the ambassador earns on a referred order       (10%)
//
// They are numerically close, which is exactly why a careless "find 10, replace
// with 20" would silently give every referred customer double the discount and
// double the commission bill. This file pins each one separately, so raising
// one turns red only the assertion that names it.
//
// Negative control: setting DEFAULT_AMBASSADOR_PERSONAL_DISCOUNT_PERCENT back
// to 15, and separately raising DEFAULT_REFERRAL_DISCOUNT_PERCENT to 20, were
// each confirmed to fail the corresponding tests below.
// ---------------------------------------------------------------------------

vi.unmock("@/lib/admin-control");

const {
  DEFAULT_AMBASSADOR_PERSONAL_DISCOUNT_PERCENT,
  DEFAULT_REFERRAL_DISCOUNT_PERCENT,
  DEFAULT_AMBASSADOR_COMMISSION_PERCENT,
} = await import("@/lib/admin-control");

const { ambassadorApprovedTemplate } = await import("@/lib/email/templates");

describe("the three ambassador rates are distinct values", () => {
  it("an ambassador saves 20% on their OWN purchases", () => {
    expect(DEFAULT_AMBASSADOR_PERSONAL_DISCOUNT_PERCENT).toBe(20);
  });

  it("a referred CUSTOMER still saves 10% — unchanged by the personal raise", () => {
    expect(DEFAULT_REFERRAL_DISCOUNT_PERCENT).toBe(10);
  });

  it("COMMISSION is still 10% — a discount is not a payout", () => {
    expect(DEFAULT_AMBASSADOR_COMMISSION_PERCENT).toBe(10);
  });

  it("the personal discount is strictly larger than the customer discount", () => {
    // The whole point of the benefit: the ambassador does better than the
    // audience they send. If these ever equalise, one of them was edited by
    // accident.
    expect(DEFAULT_AMBASSADOR_PERSONAL_DISCOUNT_PERCENT).toBeGreaterThan(
      DEFAULT_REFERRAL_DISCOUNT_PERCENT,
    );
  });
});

describe("the approval email states each rate against the right concept", () => {
  // Deliberately distinct sentinel values so a swapped argument cannot pass by
  // coincidence.
  const rendered = ambassadorApprovedTemplate({
    name: "Test Ambassador",
    referralCode: "TESTCODE",
    dashboardUrl: "https://example.test/account/ambassador",
    commissionPercent: 33,
    personalDiscountPercent: 44,
    referralDiscountPercent: 55,
    holdDays: 14,
  });

  it("attributes the PERSONAL percent to the ambassador's own purchases", () => {
    expect(rendered.html).toMatch(/44% off your own purchases/);
    expect(rendered.text).toMatch(/44% off your own purchases/);
  });

  it("attributes the CUSTOMER percent to people using the code", () => {
    expect(rendered.html).toMatch(/customers who use it get <strong>55% off/);
    expect(rendered.html).not.toMatch(/customers who use it get <strong>44% off/);
  });

  it("attributes the COMMISSION percent to completed referrals only", () => {
    expect(rendered.html).toMatch(/33% commission/);
    expect(rendered.html).not.toMatch(/44% commission/);
  });

  it("never describes the personal discount as something the customer receives", () => {
    // The defect this correction fixes, stated as an invariant.
    expect(rendered.text).not.toMatch(/audience 44% off/);
    expect(rendered.text).toMatch(/audience 55% off/);
  });

  describe("when the caller supplies nothing (fallbacks)", () => {
    const fallback = ambassadorApprovedTemplate({
      name: "Test Ambassador",
      referralCode: "TESTCODE",
      dashboardUrl: "https://example.test/account/ambassador",
    });

    it("falls back to 20% personal, matching the program default", () => {
      expect(fallback.text).toMatch(/Personal discount: 20% off your own purchases/);
    });

    it("falls back to 10% for the customer discount, NOT 20%", () => {
      expect(fallback.text).toMatch(/customers get 10% off/);
      expect(fallback.text).not.toMatch(/customers get 20% off/);
    });

    it("falls back to 10% commission, NOT 20%", () => {
      expect(fallback.html).toMatch(/10% commission/);
      expect(fallback.html).not.toMatch(/20% commission/);
    });
  });
});

describe("the personal discount never becomes a commission", () => {
  it("resolveAmbassadorCustomerDiscount does not read the personal rate", async () => {
    const { resolveAmbassadorCustomerDiscount } = await import("@/lib/ambassador-discount");
    // Program default here is the CUSTOMER rate; passing 10 must yield 10 even
    // though the personal default is now 20.
    expect(resolveAmbassadorCustomerDiscount(null, 10)).toBe(10);
    expect(resolveAmbassadorCustomerDiscount(undefined, 10)).toBe(10);
    expect(DEFAULT_AMBASSADOR_PERSONAL_DISCOUNT_PERCENT).not.toBe(10);
  });
});
