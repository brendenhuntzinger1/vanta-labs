import { describe, expect, it } from "vitest";
import {
  annualSavings,
  bestPaidTier,
  computeCartMembershipValue,
  parsePriceValue,
  quoteMemberPrice,
  type MembershipTierSummary,
} from "@/lib/member-pricing";

const tier = (over: Partial<MembershipTierSummary> = {}): MembershipTierSummary => ({
  slug: "pro",
  name: "Pro",
  discountPercent: 10,
  monthlyPriceCents: 2499,
  annualPriceCents: 24990,
  monthlyStoreCreditCents: 2500,
  storeCreditMinOrderCents: 10000,
  freeShipping: true,
  pointsPerDollar: 3,
  introPriceCents: 100,
  introDurationDays: 7,
  introOfferEnabled: false,
  ...over,
});

describe("parsePriceValue", () => {
  it("parses formatted price strings", () => {
    expect(parsePriceValue("$75.00")).toBe(75);
    expect(parsePriceValue("$1,299.99")).toBe(1299.99);
    expect(parsePriceValue("75")).toBe(75);
    expect(parsePriceValue(49.5)).toBe(49.5);
  });
  it("returns 0 for junk", () => {
    expect(parsePriceValue("")).toBe(0);
    expect(parsePriceValue(null)).toBe(0);
    expect(parsePriceValue("N/A")).toBe(0);
    expect(parsePriceValue(NaN)).toBe(0);
  });
});

describe("quoteMemberPrice", () => {
  it("computes dollars-first savings ($75 at 10% → $67.50, save $7.50)", () => {
    const quote = quoteMemberPrice("$75.00", 10);
    expect(quote).toEqual({ regularPrice: 75, memberPrice: 67.5, savings: 7.5, percent: 10 });
  });
  it("zero/invalid discount means no savings", () => {
    expect(quoteMemberPrice(75, 0).savings).toBe(0);
    expect(quoteMemberPrice(75, -5).savings).toBe(0);
    expect(quoteMemberPrice(75, NaN).savings).toBe(0);
  });
  it("caps runaway discounts at 90%", () => {
    expect(quoteMemberPrice(100, 500).memberPrice).toBe(10);
  });
  it("rounds to cents", () => {
    const quote = quoteMemberPrice(79.99, 8);
    expect(quote.memberPrice).toBe(73.59);
    expect(quote.savings).toBe(6.4);
  });
});

describe("bestPaidTier", () => {
  it("picks the highest-discount paid tier", () => {
    const best = bestPaidTier([
      tier({ slug: "core", discountPercent: 5 }),
      tier({ slug: "elite", discountPercent: 15 }),
      tier({ slug: "pro", discountPercent: 10 }),
    ]);
    expect(best?.slug).toBe("elite");
  });
  it("ignores free tiers and returns null when none qualify", () => {
    expect(bestPaidTier([tier({ monthlyPriceCents: 0 })])).toBeNull();
    expect(bestPaidTier([tier({ discountPercent: 0 })])).toBeNull();
    expect(bestPaidTier([])).toBeNull();
  });
});

describe("computeCartMembershipValue", () => {
  it("prices the full stack: discount + shipping + credit − cost", () => {
    const value = computeCartMembershipValue({ subtotal: 240, shipping: 15, tier: tier() });
    expect(value.discountSavings).toBe(24);
    expect(value.shippingSavings).toBe(15);
    expect(value.monthlyStoreCredit).toBe(25);
    expect(value.monthlyCost).toBe(24.99);
    expect(value.totalBenefit).toBe(64);
    expect(value.todayValue).toBe(39.01);
  });
  it("withholds store credit under the tier's redemption minimum", () => {
    const value = computeCartMembershipValue({ subtotal: 50, shipping: 15, tier: tier() });
    expect(value.monthlyStoreCredit).toBe(0);
  });
  it("no shipping savings for tiers without free shipping or when shipping is already 0", () => {
    expect(computeCartMembershipValue({ subtotal: 300, shipping: 0, tier: tier() }).shippingSavings).toBe(0);
    expect(computeCartMembershipValue({ subtotal: 100, shipping: 15, tier: tier({ freeShipping: false }) }).shippingSavings).toBe(0);
  });
  it("todayValue can be negative for a tiny cart (upsell must stay honest)", () => {
    const value = computeCartMembershipValue({ subtotal: 20, shipping: 15, tier: tier() });
    expect(value.todayValue).toBeLessThan(0);
  });
});

describe("annualSavings", () => {
  it("computes dollars, percent, and months free vs 12x monthly", () => {
    const result = annualSavings(tier({ monthlyPriceCents: 2500, annualPriceCents: 25000 }));
    expect(result.dollars).toBe(50);
    expect(result.percent).toBe(17);
    expect(result.monthsFree).toBe(2);
  });
  it("returns zeros when annual pricing isn't a deal", () => {
    expect(annualSavings(tier({ annualPriceCents: 0 }))).toEqual({ dollars: 0, percent: 0, monthsFree: 0 });
    expect(annualSavings(tier({ monthlyPriceCents: 2000, annualPriceCents: 24000 }))).toEqual({ dollars: 0, percent: 0, monthsFree: 0 });
  });
});
