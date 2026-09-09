import { describe, expect, it } from "vitest";
import {
  DEFAULT_RECOVERY_TIERS,
  MAX_GIFT_ITEMS_PER_STAGE,
  TIER_ABSOLUTE_FLOOR_CENTS,
  representativeCartCents,
  tierEconomics,
  tierForCart,
  validateRecoveryTiers,
  type RecoveryTier,
} from "@/lib/cart-recovery-tiers";
import { BAC_WATER_SLUG } from "@/lib/bac-water";

// ---------------------------------------------------------------------------
// THE LADDER USED TO BE FLAT, AND THE MONEY IS NOT.
//
// Measured against the real abandoned carts on 2026-09-08: 8 of 30 carts are
// $300+ and they hold 57% of every dollar this store has had walk out, while
// 12 carts under $100 hold 13%. One offer for both is wrong in both
// directions.
//
// These tests pin the two things a band table must never get wrong: which band
// a cart falls in (an off-by-one at a boundary silently up- or down-grades an
// offer), and what a band costs (the number the owner decides on).
// ---------------------------------------------------------------------------

// Keyed off the constant, never a literal. offers/customer-offers.ts records
// the last rename shipping a broken gift with a GREEN suite, because the
// catalogue mock carried the same stale slug the code did -- both sides wrong
// together, so nothing disagreed. Deriving the key makes that impossible here.
const SLUGS = new Set([BAC_WATER_SLUG, "ghk-cu", "klow", "glow"]);

// This store's real figures, from product_doses.product_cost_cents and the
// observed average postage. Deliberately the live numbers rather than round
// ones, so a change in the maths shows up as a change against reality.
const ECONOMICS = {
  productCostRatio: 0.163,
  postageCents: 793,
  giftCostCents: { [BAC_WATER_SLUG]: 143, "ghk-cu": 365, klow: 2507, glow: 2154 },
  giftRetailCents: { [BAC_WATER_SLUG]: 1499, "ghk-cu": 3999, klow: 11999, glow: 10999 },
};

describe("which band a cart falls in", () => {
  // Every boundary, from both sides. A cart one cent below a floor belongs to
  // the band below it — that is the whole meaning of an inclusive floor, and
  // it is the assertion that catches a `>` written where `>=` was meant.
  it.each([
    [3_499, null],
    [3_500, 3_500],
    [9_999, 3_500],
    [10_000, 10_000],
    [24_999, 10_000],
    [25_000, 25_000],
    [49_999, 25_000],
    [50_000, 50_000],
    [500_000, 50_000],
  ])("a cart of %i cents lands in the band starting at %s", (cart, expected) => {
    const tier = tierForCart(DEFAULT_RECOVERY_TIERS, cart);
    expect(tier?.minCents ?? null).toBe(expected);
  });

  it("gives nothing to a cart below the lowest band", () => {
    expect(tierForCart(DEFAULT_RECOVERY_TIERS, 100)).toBeNull();
  });

  it("does not depend on the stored order of the bands", () => {
    const shuffled = [...DEFAULT_RECOVERY_TIERS].reverse();
    expect(tierForCart(shuffled, 30_000)?.minCents).toBe(25_000);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY])("refuses %s rather than picking a band", (value) => {
    expect(tierForCart(DEFAULT_RECOVERY_TIERS, value as number)).toBeNull();
  });
});

describe("the shipped ladder", () => {
  it("validates against the live catalogue", () => {
    expect(validateRecoveryTiers(DEFAULT_RECOVERY_TIERS, SLUGS).ok).toBe(true);
  });

  // The two bands where the gift alone is a large share of the cart carry no
  // percentage, because a discount there costs more than it adds. This is the
  // core commercial decision in the ladder, so it is asserted rather than left
  // to whoever edits the defaults next.
  it("carries no percentage on the smallest and largest bands", () => {
    const [small, , , large] = DEFAULT_RECOVERY_TIERS;
    expect(small.stage4.percent).toBe(0);
    expect(large.stage4.percent).toBe(0);
  });

  it("carries a percentage on the two middle bands, where a gift alone reads thin", () => {
    expect(DEFAULT_RECOVERY_TIERS[1].stage4.percent).toBe(10);
    expect(DEFAULT_RECOVERY_TIERS[2].stage4.percent).toBe(10);
  });

  it("escalates: the top band's gift is worth more than the bottom band's", () => {
    const bottom = tierEconomics(DEFAULT_RECOVERY_TIERS[0], 6_119, ECONOMICS);
    const top = tierEconomics(DEFAULT_RECOVERY_TIERS[3], 51_990, ECONOMICS);
    expect(top.perceivedValueCents).toBeGreaterThan(bottom.perceivedValueCents * 3);
  });
});

describe("what a band costs, on its real cart", () => {
  // The numbers the owner signed off on. If the maths drifts, this is what says
  // so — and the figures are the ones quoted back to them, not approximations.
  it.each([
    // band index, representative cart, cost, net margin %, incentive share %
    [0, 6_119, 365, 64.8, 8.4],
    [1, 15_000, 2_008, 65.0, 17.1],
    [2, 38_005, 4_309, 70.3, 13.9],
    [3, 51_990, 3_015, 76.4, 7.1],
  ])("band %i on a %i-cent cart costs %i cents", (index, cart, cost, netMargin, share) => {
    const result = tierEconomics(DEFAULT_RECOVERY_TIERS[index], cart, ECONOMICS);
    expect(result.incentiveCents).toBe(cost);
    expect(result.netMarginPercent).toBeCloseTo(netMargin, 0);
    expect(result.incentiveShareOfContributionPercent).toBeCloseTo(share, 0);
  });

  // POSTAGE IS A FIXED COST, so it falls hardest on the smallest carts. Leaving
  // it out overstates the small band's margin by nearly thirteen points, which
  // is exactly the band most at risk of being over-served.
  it("counts postage, which costs the smallest band the most", () => {
    const withPostage = tierEconomics(DEFAULT_RECOVERY_TIERS[0], 6_119, ECONOMICS);
    const without = tierEconomics(DEFAULT_RECOVERY_TIERS[0], 6_119, { ...ECONOMICS, postageCents: 0 });
    expect(without.netMarginPercent - withPostage.netMarginPercent).toBeGreaterThan(12);
  });

  // The reason the ladder is gift-heavy: on the same cart, a percentage costs
  // far more than the product it could have given instead.
  it("shows a percentage costing more than the gift it replaces", () => {
    const cart = 51_990;
    const giftOnly = tierEconomics(DEFAULT_RECOVERY_TIERS[3], cart, ECONOMICS);
    const tenPercent: RecoveryTier = {
      ...DEFAULT_RECOVERY_TIERS[3],
      stage4: { gifts: [], percent: 10 },
    };
    const discountOnly = tierEconomics(tenPercent, cart, ECONOMICS);
    expect(discountOnly.incentiveCents).toBeGreaterThan(giftOnly.incentiveCents);
    expect(giftOnly.perceivedValueCents).toBeGreaterThan(discountOnly.perceivedValueCents);
  });

  it("counts an unknown slug as free rather than throwing, so a preview still renders", () => {
    const odd: RecoveryTier = {
      minCents: 3_500,
      stage3: [],
      stage4: { gifts: [{ slug: "not-a-product", quantity: 1 }], percent: 0 },
    };
    expect(tierEconomics(odd, 10_000, ECONOMICS).incentiveCents).toBe(0);
  });
});

describe("what the editor refuses", () => {
  const base = { minCents: 5_000, stage3: [], stage4: { gifts: [{ slug: "ghk-cu", quantity: 1 }], percent: 0 } };

  it("refuses an empty table", () => {
    expect(validateRecoveryTiers([], SLUGS).ok).toBe(false);
  });

  it("refuses a product that is not on sale", () => {
    const verdict = validateRecoveryTiers(
      [{ ...base, stage4: { gifts: [{ slug: "retired", quantity: 1 }], percent: 0 } }],
      SLUGS,
    );
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.error).toContain("retired");
  });

  it("refuses the same product listed twice in one gift", () => {
    const verdict = validateRecoveryTiers(
      [{ ...base, stage4: { gifts: [{ slug: "ghk-cu", quantity: 1 }, { slug: "ghk-cu", quantity: 1 }], percent: 0 } }],
      SLUGS,
    );
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.error).toContain("twice");
  });

  it("refuses two bands starting at the same value", () => {
    const verdict = validateRecoveryTiers([base, { ...base }], SLUGS);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.error).toContain("both start");
  });

  // A band below the code's own floor would show the operator a gift the sweep
  // then refuses to issue — the admin and the behaviour disagreeing silently.
  it(`refuses a band below the $${TIER_ABSOLUTE_FLOOR_CENTS / 100} floor`, () => {
    const verdict = validateRecoveryTiers([{ ...base, minCents: 1_000 }], SLUGS);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.error).toContain("no gift is ever issued");
  });

  it("refuses a band that gives nothing at all", () => {
    const verdict = validateRecoveryTiers(
      [{ minCents: 5_000, stage3: [], stage4: { gifts: [], percent: 0 } }],
      SLUGS,
    );
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.error).toContain("gives nothing");
  });

  it.each([-1, 101, 10.5])("refuses a %s%% discount", (percent) => {
    expect(validateRecoveryTiers([{ ...base, stage4: { gifts: [], percent } }], SLUGS).ok).toBe(false);
  });

  it.each([0, 6, -2])("refuses a gift quantity of %s", (quantity) => {
    expect(validateRecoveryTiers(
      [{ ...base, stage4: { gifts: [{ slug: "ghk-cu", quantity }], percent: 0 } }],
      SLUGS,
    ).ok).toBe(false);
  });

  it(`refuses more than ${MAX_GIFT_ITEMS_PER_STAGE} products in one gift`, () => {
    const gifts = [BAC_WATER_SLUG, "ghk-cu", "klow", "glow", BAC_WATER_SLUG].map((slug) => ({ slug, quantity: 1 }));
    expect(validateRecoveryTiers([{ ...base, stage4: { gifts, percent: 0 } }], SLUGS).ok).toBe(false);
  });

  // REFUSED, NOT REPAIRED. Silently sorting or clamping would mean the stored
  // configuration and the operator's intent differ with nobody told — and here
  // that difference is money given away.
  it("returns the bands sorted, but never invents one to fill a gap", () => {
    const verdict = validateRecoveryTiers(
      [{ ...base, minCents: 50_000 }, { ...base, minCents: 3_500 }],
      SLUGS,
    );
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.tiers.map((tier) => tier.minCents)).toEqual([3_500, 50_000]);
    }
  });

  it("skips the catalogue check when no catalogue is supplied, but keeps every other rule", () => {
    expect(validateRecoveryTiers([{ ...base, stage4: { gifts: [{ slug: "anything", quantity: 1 }], percent: 0 } }], null).ok).toBe(true);
    expect(validateRecoveryTiers([{ ...base, stage4: { gifts: [], percent: 500 } }], null).ok).toBe(false);
  });
});

describe("the cart a band is judged on", () => {
  it("is the midpoint to the next band", () => {
    expect(representativeCartCents(DEFAULT_RECOVERY_TIERS, 0)).toBe(6_750);
    expect(representativeCartCents(DEFAULT_RECOVERY_TIERS, 1)).toBe(17_500);
  });

  // The top band has no ceiling, so it needs a stated convention rather than
  // an infinite one.
  it("is 1.5x the floor for the open-ended top band", () => {
    expect(representativeCartCents(DEFAULT_RECOVERY_TIERS, 3)).toBe(75_000);
  });
});
