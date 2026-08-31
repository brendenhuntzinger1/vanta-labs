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

  /**
   * The email now states the three rates in a table rather than in prose, so
   * these read the value out of the row that NAMES each concept. That is
   * strictly stronger than the substring match this used to do: a swapped pair
   * fails here even if both numbers are still present somewhere in the body.
   */
  function rowValue(html: string, label: string): string | null {
    const m = html.match(new RegExp(`${label}</td>\\s*<td[^>]*>([0-9.]+)%`));
    return m ? m[1] : null;
  }

  it("attributes the PERSONAL percent to the ambassador's own purchases", () => {
    expect(rowValue(rendered.html, "Your own discount")).toBe("44");
    expect(rendered.html).toMatch(/Your own discount applies at the cart/);
    expect(rendered.text).toMatch(/Your own discount: 44% off your own purchases/);
  });

  it("attributes the CUSTOMER percent to people using the code", () => {
    expect(rendered.html).toMatch(/customers who use it get <strong>55% off/);
    expect(rendered.html).not.toMatch(/customers who use it get <strong>44% off/);
    expect(rowValue(rendered.html, "Your customers&apos; discount")
      ?? rowValue(rendered.html, "Your customers' discount")).toBe("55");
  });

  it("attributes the COMMISSION percent to completed referrals only", () => {
    expect(rowValue(rendered.html, "Your commission")).toBe("33");
    expect(rendered.html).toMatch(/You earn 33% of the merchandise total/);
    expect(rendered.html).not.toMatch(/You earn 44%/);
    expect(rendered.text).toMatch(/Your commission: 33% of the merchandise total/);
  });

  it("never describes the personal discount as something the customer receives", () => {
    // The defect this correction fixes, stated as an invariant: the personal
    // rate must never be attached to the customer-facing concept, in either part.
    expect(rendered.text).not.toMatch(/customers' discount: 44%/i);
    expect(rendered.text).toMatch(/Your customers' discount: 55%/);
    expect(rendered.html).not.toMatch(/customers who use it get <strong>44%/);
  });

  it("keeps all three rates distinct in the rendered output", () => {
    // If a refactor ever collapses two of them onto one variable, this is the
    // assertion that notices — regardless of wording.
    const values = ["Your commission", "Your own discount"].map((l) => rowValue(rendered.html, l));
    expect(new Set([...values, "55"]).size).toBe(3);
  });

  describe("when the caller supplies nothing (fallbacks)", () => {
    const fallback = ambassadorApprovedTemplate({
      name: "Test Ambassador",
      referralCode: "TESTCODE",
      dashboardUrl: "https://example.test/account/ambassador",
    });

    it("falls back to 20% personal, matching the program default", () => {
      expect(rowValue(fallback.html, "Your own discount")).toBe("20");
      expect(fallback.text).toMatch(/Your own discount: 20% off your own purchases/);
    });

    it("falls back to 10% for the customer discount, NOT 20%", () => {
      expect(fallback.text).toMatch(/Your customers' discount: 10%/);
      expect(fallback.text).not.toMatch(/Your customers' discount: 20%/);
    });

    it("falls back to 10% commission, NOT 20%", () => {
      expect(rowValue(fallback.html, "Your commission")).toBe("10");
      expect(fallback.html).not.toMatch(/You earn 20%/);
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
