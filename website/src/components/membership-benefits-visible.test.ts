import { describe, expect, it } from "vitest";

import { visibleBenefits } from "@/components/membership-landing";
import type { MembershipTier } from "@/lib/membership";

// ---------------------------------------------------------------------------
// "SEE ALL 0 BENEFITS".
//
// The membership card renders its bullet list and, on mobile, a toggle labelled
// `See all ${...length} benefits`. Both sides filtered the tier's benefits
// independently, and neither checked the result for empty — so a tier with
// nothing left to show still drew a toggle that advertised zero items and
// expanded onto a blank list.
//
// It is not only the harness's empty seed that reaches this. restatesStructuredPerk
// deliberately drops any bullet that merely repeats a perk the card already
// displays structurally, so a tier whose bullets are exactly its structured
// perks — an ordinary way for an operator to fill the field in — filters down to
// nothing while `benefits` is non-empty in the database.
// ---------------------------------------------------------------------------

function tier(overrides: Partial<MembershipTier> = {}): MembershipTier {
  return {
    id: "t1",
    slug: "core",
    name: "Core Member",
    monthlyPriceCents: 2900,
    annualPriceCents: 29000,
    compareMonthlyPriceCents: 0,
    pointsPerDollar: 1,
    freeShipping: false,
    priorityShipping: false,
    earlyAccess: false,
    exclusivePricing: false,
    referralBonusPoints: 0,
    benefits: [],
    introPriceCents: 100,
    introDurationDays: 7,
    introOfferEnabled: true,
    memberDiscountPercent: 10,
    monthlyStoreCreditCents: 0,
    storeCreditMinOrderCents: 0,
    position: 1,
    isActive: true,
    ...overrides,
  } as MembershipTier;
}

describe("visibleBenefits", () => {
  it("is empty when the tier carries no bullets at all", () => {
    expect(visibleBenefits(tier({ benefits: [] }))).toEqual([]);
  });

  it("is empty when every bullet merely restates a structured perk", () => {
    // Each of these is already drawn on the card as its own field.
    const t = tier({
      memberDiscountPercent: 10,
      freeShipping: true,
      benefits: ["10% member discount", "Free shipping on every order", "1x points per $1"],
    });
    expect(visibleBenefits(t)).toEqual([]);
  });

  it("keeps a bullet that says something the card does not", () => {
    const t = tier({
      benefits: ["Invitation to quarterly research webinars", "10% member discount"],
    });
    expect(visibleBenefits(t)).toEqual(["Invitation to quarterly research webinars"]);
  });
});
