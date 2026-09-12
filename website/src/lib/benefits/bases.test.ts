import { describe, expect, it } from "vitest";

import {
  NO_FLAGS,
  deriveOrderBases,
  giftDisplacedRevenueFrom,
  type BenefitFlags,
} from "@/lib/benefits/bases";

// ---------------------------------------------------------------------------
// M4 is a STRUCTURAL NO-OP. The point of this file is not to show the three
// bases work; it is to show that with the flags off they are ONE number, and
// that the number is the one production has always used.
//
// So the central assertion is a property over a swept input space rather than a
// handful of examples: for every reachable (subtotal, discount, displaced)
// triple, all three bases equal `roundMoney(max(0, subtotal - discount))`.
// ---------------------------------------------------------------------------

const roundMoney = (v: number) => Math.round(v * 100) / 100;

/** The exact expression the three payment-webhook sites used before M4. */
const historicalBasis = (subtotal: number, discountAmount: number) =>
  roundMoney(Math.max(0, subtotal - discountAmount));

/** A line as the absorb bookkeeping sees it. */
const line = (quantity: number, price: number) => ({ quantity, product: { price } });

describe("M4 no-op: with flags off the three bases are one number", () => {
  it("equals the historical basis across a swept input space", () => {
    // Requirement 5, as a property. Boundary cart values, quantity-tier prices,
    // half-cent products, discounts up to and beyond the subtotal, and a
    // displaced amount present but unconsumed.
    const subtotals = [0, 0.01, 5, 35, 49.99, 60, 74.99, 99.98, 142.48, 172.47,
                       199.99, 200, 229.96, 250, 377.16, 440.02, 500, 742.82, 1000, 4999.99];
    const discounts = [0, 0.01, 3.75, 5, 7.5, 10.49, 15, 33.33, 50, 100, 250, 1000, 99999];
    const displaced = [0, 0.01, 14.99, 39.99, 57.49, 67.49, 1000];

    let checked = 0;
    for (const subtotal of subtotals) {
      for (const discountAmount of discounts) {
        for (const giftDisplacedRevenue of displaced) {
          for (const giftChannel of [null, "sms", "email"] as const) {
            const bases = deriveOrderBases({ subtotal, discountAmount, giftDisplacedRevenue, giftChannel });
            const expected = historicalBasis(subtotal, discountAmount);

            expect(bases.paidMerchandise, `paid @ ${subtotal}/${discountAmount}`).toBe(expected);
            expect(bases.rewardBase, `reward @ ${subtotal}/${discountAmount}`).toBe(expected);
            expect(bases.commissionableBase, `commission @ ${subtotal}/${discountAmount}`).toBe(expected);
            expect(bases.commissionUplifted).toBe(false);
            checked++;
          }
        }
      }
    }
    // Guard against the sweep silently shrinking to nothing.
    expect(checked).toBeGreaterThan(5000);
  });

  it("holds when the flags object is absent, empty, or explicitly false", () => {
    const cases: Array<BenefitFlags | undefined> = [
      undefined,
      NO_FLAGS,
      {},
      { giftDisplacedCommissionSms: false },
      { giftDisplacedCommissionEmail: false },
      { giftDisplacedCommissionSms: false, giftDisplacedCommissionEmail: false },
    ];
    for (const flags of cases) {
      const bases = deriveOrderBases({
        subtotal: 172.47, discountAmount: 7.5, giftDisplacedRevenue: 57.49,
        giftChannel: "sms", flags,
      });
      expect(bases.commissionableBase).toBe(bases.paidMerchandise);
      expect(bases.commissionableBase).toBe(historicalBasis(172.47, 7.5));
    }
  });

  it("never returns a negative base, however large the discount", () => {
    const bases = deriveOrderBases({ subtotal: 50, discountAmount: 500 });
    expect(bases.paidMerchandise).toBe(0);
    expect(bases.rewardBase).toBe(0);
    expect(bases.commissionableBase).toBe(0);
  });
});

describe("requirement 7: an added gift creates no fake displaced revenue", () => {
  it("reports zero when nothing was absorbed", () => {
    // An added gift is a $0 line; it absorbs nothing, so the bookkeeping array
    // is empty and the value is structurally zero rather than conditionally so.
    expect(giftDisplacedRevenueFrom([])).toBe(0);
  });

  it("keeps all three bases equal even with a flag ON, because displaced is zero", () => {
    // Requirement 7's real teeth: turning the flag on must not invent uplift
    // for a gift that displaced nothing.
    const bases = deriveOrderBases({
      subtotal: 229.96, discountAmount: 5, giftDisplacedRevenue: 0,
      giftChannel: "sms", flags: { giftDisplacedCommissionSms: true },
    });
    expect(bases.commissionableBase).toBe(bases.paidMerchandise);
    expect(bases.commissionUplifted).toBe(false);
  });
});

describe("giftDisplacedRevenueFrom — derived from the existing bookkeeping", () => {
  it("counts absorbed units at the price they carried before absorption", () => {
    // One unit taken from a line that had no surviving units.
    expect(giftDisplacedRevenueFrom([{ line: line(0, 0), quantity: 1, unitPrice: 39.99 }]))
      .toBe(39.99);
  });

  it("ALSO counts the repricing loss on the units that survived", () => {
    // Three units at the 8% tier ($68.99 each). Absorb one, and the remaining
    // two drop to the 5% tier ($71.24). The line loses one unit's price AND
    // $2.25 on each survivor — missing the second term is the subtle half.
    const displaced = giftDisplacedRevenueFrom([
      { line: line(2, 71.24), quantity: 1, unitPrice: 68.99 },
    ]);
    expect(displaced).toBe(roundMoney(68.99 + 2 * (68.99 - 71.24)));
    // The survivors got CHEAPER per unit at the lower tier, so the second term
    // is negative here and the total is below one unit's price.
    expect(displaced).toBeLessThan(68.99);
  });

  it("handles the tier moving the other way", () => {
    // Absorbing from a line whose survivors get MORE expensive per unit (a
    // higher tier lost) increases the displacement.
    const displaced = giftDisplacedRevenueFrom([
      { line: line(2, 60), quantity: 1, unitPrice: 68.99 },
    ]);
    expect(displaced).toBe(roundMoney(68.99 + 2 * 8.99));
  });

  it("sums across several absorbed lines", () => {
    expect(giftDisplacedRevenueFrom([
      { line: line(0, 0), quantity: 1, unitPrice: 39.99 },
      { line: line(0, 0), quantity: 2, unitPrice: 14.99 },
    ])).toBe(roundMoney(39.99 + 2 * 14.99));
  });

  it("never returns a negative amount", () => {
    // A pathological repricing that would net below zero is clamped rather
    // than becoming a commission DEDUCTION.
    expect(giftDisplacedRevenueFrom([{ line: line(10, 500), quantity: 1, unitPrice: 1 }])).toBe(0);
  });

  it("rounds to cents", () => {
    const displaced = giftDisplacedRevenueFrom([{ line: line(3, 33.333), quantity: 1, unitPrice: 33.333 }]);
    expect(Number.isInteger(Math.round(displaced * 100))).toBe(true);
    expect(displaced).toBe(roundMoney(displaced));
  });
});

describe("what the flags do when they are eventually turned on (M7/M9)", () => {
  it("SMS flag lifts commission only, and only for an SMS-funded gift", () => {
    const input = { subtotal: 172.47, discountAmount: 7.5, giftDisplacedRevenue: 57.49 };
    const on = deriveOrderBases({ ...input, giftChannel: "sms", flags: { giftDisplacedCommissionSms: true } });

    expect(on.commissionableBase).toBe(roundMoney(on.paidMerchandise + 57.49));
    expect(on.commissionUplifted).toBe(true);
    // THE POINT OF THREE BASES: rewards and accounting do not move with it.
    expect(on.paidMerchandise).toBe(historicalBasis(172.47, 7.5));
    expect(on.rewardBase).toBe(historicalBasis(172.47, 7.5));
  });

  it("the SMS flag does NOT lift an email-funded gift, and vice versa", () => {
    const input = { subtotal: 172.47, discountAmount: 7.5, giftDisplacedRevenue: 57.49 };
    const smsFlagEmailGift = deriveOrderBases({ ...input, giftChannel: "email", flags: { giftDisplacedCommissionSms: true } });
    expect(smsFlagEmailGift.commissionableBase).toBe(smsFlagEmailGift.paidMerchandise);

    const emailFlagSmsGift = deriveOrderBases({ ...input, giftChannel: "sms", flags: { giftDisplacedCommissionEmail: true } });
    expect(emailFlagSmsGift.commissionableBase).toBe(emailFlagSmsGift.paidMerchandise);
  });

  it("a gift with no channel is never uplifted by either flag", () => {
    const bases = deriveOrderBases({
      subtotal: 172.47, discountAmount: 7.5, giftDisplacedRevenue: 57.49, giftChannel: null,
      flags: { giftDisplacedCommissionSms: true, giftDisplacedCommissionEmail: true },
    });
    expect(bases.commissionableBase).toBe(bases.paidMerchandise);
  });

  it("rewards NEVER move, under any flag combination", () => {
    // Requirement 8: the future commission fix must not reach rewards.
    for (const flags of [
      { giftDisplacedCommissionSms: true },
      { giftDisplacedCommissionEmail: true },
      { giftDisplacedCommissionSms: true, giftDisplacedCommissionEmail: true },
    ]) {
      for (const giftChannel of ["sms", "email", null] as const) {
        const bases = deriveOrderBases({
          subtotal: 440.02, discountAmount: 0, giftDisplacedRevenue: 62.86, giftChannel, flags,
        });
        expect(bases.rewardBase, `rewards moved under ${JSON.stringify(flags)}/${giftChannel}`)
          .toBe(historicalBasis(440.02, 0));
        expect(bases.paidMerchandise).toBe(historicalBasis(440.02, 0));
      }
    }
  });
});
