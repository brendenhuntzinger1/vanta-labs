import { describe, expect, it } from "vitest";

import {
  CONTRIBUTION_DEDUCTION_KEYS,
  CONTRIBUTION_FORMULA_VERSION,
  applyCommissionFloor,
  computeContributionBeforeCommission,
  type ContributionInput,
} from "@/lib/benefits/contribution";
import { deriveOrderBases } from "@/lib/benefits/bases";

// ---------------------------------------------------------------------------
// M5 — THE CONTRIBUTION FORMULA.
//
// The blueprint's §C1 definition and §C2 tables were produced by
// docs/sms-economics-model.mjs, which is analysis code that imports nothing
// from src/. This file is where the two meet: the same baskets, line by line,
// run through the PRODUCTION implementation. If they ever disagree, one of the
// two is wrong and the disagreement is visible rather than assumed away.
// ---------------------------------------------------------------------------

const cents = (dollars: number) => Math.round(dollars * 100);

/** A complete, unremarkable order. Every test below perturbs exactly one term. */
const BASE: ContributionInput = {
  paidMerchandise: 89.98,
  shippingCollected: 15,
  handlingCollected: 0,
  productCost: 17.88,
  giftCogs: 0,
  processingFee: 8.40,
  shippingCost: 7.93,
  storeCreditRedeemed: 0,
  pointsRedeemedValue: 0,
  pointsEarnedValue: 1.79,
  basis: "quote",
};

const contributionOf = (patch: Partial<ContributionInput> = {}) =>
  computeContributionBeforeCommission({ ...BASE, ...patch }).contributionBeforeCommissionCents;

// ===========================================================================
// 1. The formula, reproduced against the blueprint's own numbers.
// ===========================================================================
describe("1. the §C2 floor-triggering table, line by line", () => {
  // Vanta Black (12% off, 5 pts/$, $75 credit, $250 min, free shipping) +
  // ambassador referral at the 20% commission tier + an SMS gift absorbing a
  // unit. Every line dumped from docs/sms-economics-model.mjs.
  const ROWS = [
    { label: "$50", paidMerchandise: 0, shippingCollected: 0, productCost: 0, giftCogs: 3.65, processingFee: 0, shippingCost: 7.93, storeCreditRedeemed: 0, pointsEarnedValue: 0, contribution: -11.58 },
    { label: "$100", paidMerchandise: 43.99, shippingCollected: 0, productCost: 9.41, giftCogs: 3.65, processingFee: 3.52, shippingCost: 7.93, storeCreditRedeemed: 0, pointsEarnedValue: 2.19, contribution: 17.29 },
    { label: "$150", paidMerchandise: 65.99, shippingCollected: 0, productCost: 14.12, giftCogs: 3.65, processingFee: 5.28, shippingCost: 7.93, storeCreditRedeemed: 0, pointsEarnedValue: 3.29, contribution: 31.72 },
    { label: "$250", paidMerchandise: 164.97, shippingCollected: 0, productCost: 32.48, giftCogs: 3.65, processingFee: 13.20, shippingCost: 7.93, storeCreditRedeemed: 0, pointsEarnedValue: 8.24, contribution: 99.47 },
    { label: "$500", paidMerchandise: 377.15, shippingCollected: 0, productCost: 71.02, giftCogs: 3.65, processingFee: 30.17, shippingCost: 7.93, storeCreditRedeemed: 75, pointsEarnedValue: 18.85, contribution: 170.53 },
    { label: "$1,000", paidMerchandise: 742.82, shippingCollected: 0, productCost: 139.87, giftCogs: 3.65, processingFee: 59.43, shippingCost: 7.93, storeCreditRedeemed: 75, pointsEarnedValue: 37.14, contribution: 419.80 },
  ];

  it.each(ROWS)("$label basket lands on $contribution", (row) => {
    const result = computeContributionBeforeCommission({ ...row, basis: "quote" });
    expect(result.contributionBeforeCommissionCents).toBe(cents(row.contribution));
  });
});

describe("2. the §C2 'must not touch ordinary orders' table", () => {
  // Same referral, NO gift, 15% commission tier, free-tier 2 pts/$.
  const ROWS = [
    { label: "$50", paidMerchandise: 44.99, shippingCollected: 15, productCost: 9.41, processingFee: 4.80, shippingCost: 7.93, pointsEarnedValue: 0.89, contribution: 36.96, commissionCalculated: 6.75 },
    { label: "$100", paidMerchandise: 89.98, shippingCollected: 15, productCost: 17.88, processingFee: 8.40, shippingCost: 7.93, pointsEarnedValue: 1.79, contribution: 68.98, commissionCalculated: 13.50 },
    { label: "$150", paidMerchandise: 134.98, shippingCollected: 15, productCost: 26.83, processingFee: 12.00, shippingCost: 7.93, pointsEarnedValue: 2.69, contribution: 100.53, commissionCalculated: 20.25 },
    { label: "$250", paidMerchandise: 224.96, shippingCollected: 0, productCost: 43.30, processingFee: 18.00, shippingCost: 7.93, pointsEarnedValue: 4.49, contribution: 151.24, commissionCalculated: 33.74 },
    { label: "$500", paidMerchandise: 440.02, shippingCollected: 0, productCost: 82.86, processingFee: 35.20, shippingCost: 7.93, pointsEarnedValue: 8.80, contribution: 305.23, commissionCalculated: 66.00 },
    { label: "$1,000", paidMerchandise: 799.96, shippingCollected: 0, productCost: 150.63, processingFee: 64.00, shippingCost: 7.93, pointsEarnedValue: 15.99, contribution: 561.41, commissionCalculated: 119.99 },
  ];

  it.each(ROWS)("$label basket lands on $contribution and leaves commission untouched", (row) => {
    const result = computeContributionBeforeCommission({ ...row, basis: "quote" });
    expect(result.contributionBeforeCommissionCents).toBe(cents(row.contribution));

    const floor = applyCommissionFloor({
      commissionCalculatedCents: cents(row.commissionCalculated),
      contributionBeforeCommissionCents: result.contributionBeforeCommissionCents,
    });
    expect(floor.commissionPayableCents).toBe(cents(row.commissionCalculated));
    expect(floor.commissionCappedCents).toBe(0);
    expect(floor.capReason).toBeNull();
  });
});

// ===========================================================================
// 3. Each INCLUDED term moves the answer by exactly its own amount.
// ===========================================================================
describe("3. every included term is a real term, with the right sign", () => {
  const baseline = contributionOf();

  it.each([
    ["paidMerchandise", "paidMerchandise", +1],
    ["shippingCollected", "shippingCollected", +1],
    ["handlingCollected", "handlingCollected", +1],
    ["productCost", "productCost", -1],
    ["giftCogs", "giftCogs", -1],
    ["processingFee", "processingFee", -1],
    ["shippingCost", "shippingCost", -1],
    ["storeCreditRedeemed", "storeCreditRedeemed", -1],
    ["pointsRedeemedValue", "pointsRedeemedValue", -1],
    ["pointsEarnedValue", "pointsEarnedValue", -1],
  ] as Array<[string, keyof ContributionInput, 1 | -1]>)(
    "adding $10 to %s moves contribution by %s$10",
    (_label, key, sign) => {
      const bumped = contributionOf({ [key]: (BASE[key] as number ?? 0) + 10 } as Partial<ContributionInput>);
      expect(bumped - baseline).toBe(sign * 1000);
    },
  );
});

// ===========================================================================
// 4. Each EXCLUDED term is structurally absent — it cannot be passed at all.
// ===========================================================================
describe("4. the exclusions are structural, not a rule someone must remember", () => {
  it("has no input for tax, commission, membership revenue, refunds or the card surcharge", () => {
    // The strongest form this assertion can take: an input the type does not
    // accept cannot be included by accident, and the surplus keys below are
    // simply ignored by the arithmetic.
    const withForbidden = computeContributionBeforeCommission({
      ...BASE,
      // @ts-expect-error — none of these are terms of this formula.
      taxCollected: 99, commission: 99, membershipRevenue: 99, refund: 99, cardProcessingFee: 99,
    });
    expect(withForbidden.contributionBeforeCommissionCents).toBe(contributionOf());
  });

  it("exposes no field named for an excluded term", () => {
    const keys = Object.keys(computeContributionBeforeCommission(BASE))
      // The one field that names commission does so to say it is NOT in there.
      .filter((k) => k !== "contributionBeforeCommissionCents");
    for (const forbidden of ["tax", "commission", "membership", "refund", "cardProcessing", "surcharge"]) {
      expect(
        keys.filter((k) => k.toLowerCase().includes(forbidden.toLowerCase())),
        `${forbidden} must not appear on the breakdown`,
      ).toEqual([]);
    }
  });
});

// ===========================================================================
// 5. "Discount impact" is inside paidMerchandise, never a second subtraction.
// ===========================================================================
describe("5. the discount is inside paidMerchandise and is not subtracted twice", () => {
  it("is invariant to discountAmount once paidMerchandise is fixed", () => {
    const without = contributionOf({ discountAmount: 0 });
    const with50 = contributionOf({ discountAmount: 50 });
    expect(with50).toBe(without);
  });

  it("carries the discount as metadata so the admin can still show it", () => {
    expect(computeContributionBeforeCommission({ ...BASE, discountAmount: 12.34 }).discountAmountCents).toBe(1234);
  });

  it("takes paidMerchandise from deriveOrderBases, so the discount arrives once", () => {
    // The whole point of M4's base: `subtotal − discount` has one home. A $30
    // discount on a $120 subtotal reduces contribution by exactly $30, through
    // the base and nowhere else.
    const full = deriveOrderBases({ subtotal: 120, discountAmount: 0 });
    const discounted = deriveOrderBases({ subtotal: 120, discountAmount: 30 });
    const delta = contributionOf({ paidMerchandise: full.paidMerchandise, discountAmount: 0 })
      - contributionOf({ paidMerchandise: discounted.paidMerchandise, discountAmount: 30 });
    expect(delta).toBe(3000);
  });
});

// ===========================================================================
// 6. Gift COGS — at cost, never retail, and zero when there is no gift.
// ===========================================================================
describe("6. gift COGS is charged at cost and only when a gift exists", () => {
  it("charges the GHK-Cu gift at its $3.65 dose cost, not its $39.99 retail", () => {
    const atCost = contributionOf({ giftCogs: 3.65 });
    const atRetail = contributionOf({ giftCogs: 39.99 });
    expect(contributionOf({ giftCogs: 0 }) - atCost).toBe(365);
    // Valuing the gift at retail would understate contribution by $36.34 —
    // enough to flip several of the §C2 rows negative on their own.
    expect(atCost - atRetail).toBe(3634);
  });

  it("is zero on an order with no gift, so no order pays for a gift it did not get", () => {
    expect(computeContributionBeforeCommission(BASE).giftCogsCents).toBe(0);
    expect(computeContributionBeforeCommission({ ...BASE, giftCogs: undefined }).giftCogsCents).toBe(0);
  });

  it("is a SEPARATE line from productCost, so the two can never double-count", () => {
    // Paid-line COGS and gift COGS partition the order's lines. An absorbed
    // unit moves from one to the other; it is never in both.
    const split = computeContributionBeforeCommission({ ...BASE, productCost: 14.23, giftCogs: 3.65 });
    expect(split.productCostCents).toBe(1423);
    expect(split.giftCogsCents).toBe(365);
    expect(split.productCostCents + split.giftCogsCents).toBe(1788);
    // …and the combined figure is worth the same as the split one.
    expect(split.contributionBeforeCommissionCents).toBe(contributionOf({ productCost: 17.88, giftCogs: 0 }));
  });
});

// ===========================================================================
// 7. Points earned — the accrual, and the one departure from cash basis.
// ===========================================================================
describe("7. points EARNED is an accrued liability of this order", () => {
  it("costs 2% of the reward base at the free tier's live 2 points/$ rate", () => {
    // Measured 2026-09-12: membership_tiers.free.points_per_dollar = 2, and
    // POINTS_PER_DOLLAR_REDEMPTION = 100 — so 2 points per dollar is 2 cents
    // of liability per dollar of reward base.
    const rewardBase = 89.98;
    const pointsEarnedValue = Math.floor(rewardBase * 2) / 100;
    expect(pointsEarnedValue).toBe(1.79);
    expect(contributionOf({ pointsEarnedValue: 0 }) - contributionOf({ pointsEarnedValue })).toBe(179);
  });

  it("costs 5% at Vanta Black's 5 points/$ rate", () => {
    const rewardBase = 89.98;
    const pointsEarnedValue = Math.floor(rewardBase * 5) / 100;
    expect(pointsEarnedValue).toBe(4.49);
    expect(contributionOf({ pointsEarnedValue: 0 }) - contributionOf({ pointsEarnedValue })).toBe(449);
  });

  it("is a SEPARATE line from points redeemed — the two are opposite ends of one dollar", () => {
    const both = computeContributionBeforeCommission({ ...BASE, pointsEarnedValue: 4.49, pointsRedeemedValue: 10 });
    expect(both.pointsEarnedValueCents).toBe(449);
    expect(both.pointsRedeemedValueCents).toBe(1000);
    // Both deducted. Per order that is right; across a lifetime it is the
    // double count the module docblock warns is not a P&L.
    expect(both.contributionBeforeCommissionCents).toBe(contributionOf({ pointsEarnedValue: 14.49 }));
  });
});

// ===========================================================================
// 8. Non-cash tender is contra-revenue.
// ===========================================================================
describe("8. store credit and redeemed points reduce contribution dollar for dollar", () => {
  it("a $75 Vanta Black credit costs the order $75 of contribution", () => {
    expect(contributionOf({ storeCreditRedeemed: 0 }) - contributionOf({ storeCreditRedeemed: 75 })).toBe(7500);
  });

  it("is deducted even though the customer's invoice was the same size", () => {
    // The merchandise left the building at list price; the cash did not arrive.
    // This is the same treatment order-profit.ts gives a redemption, and the
    // one place the two engines agree exactly.
    const redeemed = computeContributionBeforeCommission({ ...BASE, storeCreditRedeemed: 20, pointsRedeemedValue: 5 });
    expect(redeemed.revenueCents).toBe(computeContributionBeforeCommission(BASE).revenueCents);
    expect(redeemed.contributionBeforeCommissionCents).toBe(contributionOf() - 2500);
  });
});

// ===========================================================================
// 9. The cents boundary.
// ===========================================================================
describe("9. every number that leaves this module is an integer number of cents", () => {
  it("returns integers for every field on every swept input", () => {
    const values = [0, 0.01, 0.005, 1 / 3, 3.65, 7.93, 39.99, 49.99, 89.98, 142.485, 377.16, 1000.001];
    let checked = 0;
    for (const a of values) {
      for (const b of values) {
        const result = computeContributionBeforeCommission({
          paidMerchandise: a * 7, shippingCollected: b, handlingCollected: a,
          productCost: b * 3, giftCogs: a, processingFee: b, shippingCost: a,
          storeCreditRedeemed: b, pointsRedeemedValue: a, pointsEarnedValue: b,
          basis: "quote",
        });
        for (const [key, value] of Object.entries(result)) {
          if (typeof value !== "number") continue;
          expect(Number.isInteger(value), `${key} = ${value} is not an integer`).toBe(true);
        }
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(100);
  });

  it("sums in integers, so ten terms cannot lose a cent between them", () => {
    // Each of the ten terms is a value a float sum rounds badly: 0.1 + 0.2 in
    // doubles is 0.30000000000000004, and ten of those compound.
    const result = computeContributionBeforeCommission({
      paidMerchandise: 0.1, shippingCollected: 0.2, handlingCollected: 0.1,
      productCost: 0.1, giftCogs: 0.1, processingFee: 0.1, shippingCost: 0.1,
      storeCreditRedeemed: 0.1, pointsRedeemedValue: 0.1, pointsEarnedValue: 0.1,
      basis: "quote",
    });
    expect(result.revenueCents).toBe(40);
    expect(result.deductionsCents).toBe(70);
    expect(result.contributionBeforeCommissionCents).toBe(-30);
  });

  it("holds revenue − deductions === contribution on every swept input", () => {
    const values = [0, 0.01, 5, 39.99, 89.98, 250.5, 742.82, 4999.99];
    let checked = 0;
    for (const a of values) {
      for (const b of values) {
        const r = computeContributionBeforeCommission({
          paidMerchandise: a, shippingCollected: b, handlingCollected: 0,
          productCost: b, giftCogs: 3.65, processingFee: a * 0.08, shippingCost: 7.93,
          storeCreditRedeemed: 0, pointsRedeemedValue: 0, pointsEarnedValue: a * 0.05,
          basis: "quote",
        });
        expect(r.revenueCents - r.deductionsCents).toBe(r.contributionBeforeCommissionCents);
        expect(r.paidMerchandiseCents + r.shippingCollectedCents + r.handlingCollectedCents).toBe(r.revenueCents);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(60);
  });
});

// ===========================================================================
// 10. A negative answer is the signal, and is never clamped.
// ===========================================================================
describe("10. negative contribution is representable", () => {
  it("reports the §C2 $50 row at exactly −$11.58 rather than 0", () => {
    const result = computeContributionBeforeCommission({
      paidMerchandise: 0, shippingCollected: 0, productCost: 0, giftCogs: 3.65,
      processingFee: 0, shippingCost: 7.93, basis: "quote",
    });
    expect(result.contributionBeforeCommissionCents).toBe(-1158);
  });

  it("a gift that absorbs the only paid unit leaves nothing to earn on", () => {
    // The case the blueprint says the FLOOR cannot fix — the gift minimum is
    // the guard for it, and the two are not substitutes.
    const result = computeContributionBeforeCommission({
      paidMerchandise: 0, shippingCollected: 0, productCost: 0, giftCogs: 3.65,
      processingFee: 0, shippingCost: 7.93, basis: "quote",
    });
    expect(result.revenueCents).toBe(0);
    expect(result.contributionBeforeCommissionCents).toBeLessThan(0);
  });
});

// ===========================================================================
// 11. bindingConstraint — why the order was thin.
// ===========================================================================
describe("11. bindingConstraint names the largest single deduction", () => {
  it.each([
    ["productCost", { productCost: 500 }],
    ["giftCogs", { giftCogs: 500 }],
    ["processingFee", { processingFee: 500 }],
    ["shippingCost", { shippingCost: 500 }],
    ["storeCreditRedeemed", { storeCreditRedeemed: 500 }],
    ["pointsRedeemedValue", { pointsRedeemedValue: 500 }],
    ["pointsEarnedValue", { pointsEarnedValue: 500 }],
  ])("names %s when it dominates", (key, patch) => {
    expect(computeContributionBeforeCommission({ ...BASE, ...patch }).bindingConstraint).toBe(key);
  });

  it("is null when there are no deductions at all", () => {
    const result = computeContributionBeforeCommission({
      paidMerchandise: 100, shippingCollected: 0, productCost: 0, processingFee: 0,
      shippingCost: 0, basis: "quote",
    });
    expect(result.bindingConstraint).toBeNull();
  });

  it("breaks a tie toward the earlier key, so the answer is stable", () => {
    const tied = computeContributionBeforeCommission({
      ...BASE, productCost: 50, giftCogs: 50, processingFee: 50, shippingCost: 50,
      storeCreditRedeemed: 50, pointsRedeemedValue: 50, pointsEarnedValue: 50,
    });
    expect(tied.bindingConstraint).toBe(CONTRIBUTION_DEDUCTION_KEYS[0]);
  });

  it("names the postage on the §C2 $50 row — the real reason that order loses money", () => {
    const result = computeContributionBeforeCommission({
      paidMerchandise: 0, shippingCollected: 0, productCost: 0, giftCogs: 3.65,
      processingFee: 0, shippingCost: 7.93, basis: "quote",
    });
    expect(result.bindingConstraint).toBe("shippingCost");
  });
});

// ===========================================================================
// 12. Degenerate inputs fail toward a known answer, never a flipped sign.
// ===========================================================================
describe("12. a bad input is clamped to zero rather than flipping a sign", () => {
  it.each([
    ["negative", -50],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["-Infinity", Number.NEGATIVE_INFINITY],
  ])("%s productCost contributes nothing instead of ADDING to contribution", (_label, value) => {
    const result = computeContributionBeforeCommission({ ...BASE, productCost: value });
    expect(result.productCostCents).toBe(0);
    expect(Number.isInteger(result.contributionBeforeCommissionCents)).toBe(true);
  });

  it("treats a missing optional term as zero rather than NaN", () => {
    const result = computeContributionBeforeCommission({
      paidMerchandise: 100, shippingCollected: 0, productCost: 0,
      processingFee: 0, shippingCost: 0, basis: "quote",
    });
    expect(result.contributionBeforeCommissionCents).toBe(10000);
    expect(result.giftCogsCents).toBe(0);
    expect(result.pointsEarnedValueCents).toBe(0);
    expect(result.handlingCollectedCents).toBe(0);
  });
});

// ===========================================================================
// 13-14. Provenance: basis and formula version travel with the number.
// ===========================================================================
describe("13. the basis is recorded and changes no arithmetic", () => {
  it.each(["quote", "settled"] as const)("%s produces the same number", (basis) => {
    const result = computeContributionBeforeCommission({ ...BASE, basis });
    expect(result.basis).toBe(basis);
    expect(result.contributionBeforeCommissionCents).toBe(contributionOf());
  });
});

describe("14. the formula version is stamped on every result", () => {
  it("is the current version", () => {
    expect(computeContributionBeforeCommission(BASE).formulaVersion).toBe(CONTRIBUTION_FORMULA_VERSION);
    expect(CONTRIBUTION_FORMULA_VERSION).toBe(1);
  });

  it("carries the estimated-cost flag rather than hiding an assumption", () => {
    expect(computeContributionBeforeCommission(BASE).costIsEstimated).toBe(false);
    expect(computeContributionBeforeCommission({ ...BASE, costIsEstimated: true }).costIsEstimated).toBe(true);
  });
});

// ===========================================================================
// 15-16. The commission floor (defined at M5, consumed at M7).
// ===========================================================================
describe("15. applyCommissionFloor caps commission and nothing else", () => {
  it("reproduces the §C2 $100 row: $17.80 calculated, $17.29 payable, $0.51 withheld", () => {
    const floor = applyCommissionFloor({
      commissionCalculatedCents: 1780,
      contributionBeforeCommissionCents: 1729,
    });
    expect(floor.commissionPayableCents).toBe(1729);
    expect(floor.commissionCappedCents).toBe(51);
    expect(floor.capReason).toBe("contribution_floor");
  });

  it("leaves a healthy order completely untouched", () => {
    const floor = applyCommissionFloor({
      commissionCalculatedCents: 2670,
      contributionBeforeCommissionCents: 3172,
    });
    expect(floor.commissionPayableCents).toBe(2670);
    expect(floor.commissionCappedCents).toBe(0);
    expect(floor.capReason).toBeNull();
  });

  it("honours a positive minRetainedContribution", () => {
    // $5 must survive: $31.72 of contribution funds $26.70 of commission with
    // $5.02 left, so a $5 floor is met exactly and nothing is capped.
    expect(applyCommissionFloor({
      commissionCalculatedCents: 2670, contributionBeforeCommissionCents: 3172,
      minRetainedContributionCents: 500,
    }).commissionCappedCents).toBe(0);
    // Raise it to $10 and $4.98 has to come off.
    expect(applyCommissionFloor({
      commissionCalculatedCents: 2670, contributionBeforeCommissionCents: 3172,
      minRetainedContributionCents: 1000,
    }).commissionCappedCents).toBe(498);
  });
});

describe("16. the floor CANNOT rescue an already-negative order", () => {
  it("reproduces the §C2 $50 row: commission to $0 and contribution still −$11.58", () => {
    const contribution = -1158;
    const floor = applyCommissionFloor({
      commissionCalculatedCents: 1000,
      contributionBeforeCommissionCents: contribution,
    });
    expect(floor.commissionPayableCents).toBe(0);
    expect(floor.commissionCappedCents).toBe(1000);
    expect(floor.capReason).toBe("contribution_floor");
    // The floor's only output is commission. Contribution is unchanged.
    expect(contribution - floor.commissionPayableCents).toBe(-1158);
  });

  it("never returns a negative payable or a negative cap", () => {
    for (const calculated of [0, 1, 500, 17_999]) {
      for (const contribution of [-99_999, -1158, 0, 1, 1729, 999_999]) {
        const floor = applyCommissionFloor({
          commissionCalculatedCents: calculated,
          contributionBeforeCommissionCents: contribution,
        });
        expect(floor.commissionPayableCents).toBeGreaterThanOrEqual(0);
        expect(floor.commissionCappedCents).toBeGreaterThanOrEqual(0);
        expect(floor.commissionPayableCents + floor.commissionCappedCents).toBe(calculated);
        expect(floor.commissionPayableCents).toBeLessThanOrEqual(calculated);
      }
    }
  });
});

// ===========================================================================
// 17. The relationship to M4's bases, and to order-profit's different question.
// ===========================================================================
describe("17. contribution consumes M4's base and never re-derives it", () => {
  it("uses paidMerchandise, not commissionableBase — a gift uplift is not revenue", () => {
    // M7 may raise commissionableBase above paidMerchandise for an SMS gift.
    // Contribution must not follow it: the store never collected that money.
    const bases = deriveOrderBases({
      subtotal: 100, discountAmount: 10, giftDisplacedRevenue: 44.99,
      giftChannel: "sms", flags: { giftDisplacedCommissionSms: true },
    });
    expect(bases.commissionableBase).toBeGreaterThan(bases.paidMerchandise);

    const result = computeContributionBeforeCommission({
      paidMerchandise: bases.paidMerchandise,
      shippingCollected: 0, productCost: 0, processingFee: 0, shippingCost: 0,
      basis: "quote",
    });
    expect(result.paidMerchandiseCents).toBe(9000);
    expect(result.contributionBeforeCommissionCents).toBe(9000);
  });

  it("is not comparable to computeOrderProfit, and the shapes say so", () => {
    // A guard against someone reaching for the wrong number: contribution
    // reports in CENTS and has no `profit`, `revenue` (dollars), `margin` or
    // `expenses` field, so it cannot be dropped into a profit surface by
    // mistake and quietly render as dollars.
    const keys = Object.keys(computeContributionBeforeCommission(BASE));
    for (const profitField of ["profit", "margin", "expenses", "grossRevenue", "totalExpenses"]) {
      expect(keys).not.toContain(profitField);
    }
    for (const key of keys) {
      if (["formulaVersion", "basis", "bindingConstraint", "costIsEstimated"].includes(key)) continue;
      expect(key.endsWith("Cents"), `${key} must be explicit about its units`).toBe(true);
    }
  });
});
