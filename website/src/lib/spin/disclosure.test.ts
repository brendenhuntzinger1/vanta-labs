import { describe, expect, it } from "vitest";

import { SPIN_PRIZES } from "@/lib/spin/prize-table";
import {
  SPIN_EXPIRY_HOURS,
  SPIN_TERMS,
  describeRedemptionCondition,
  formatMoneyFromCents,
  spinMinimumTiers,
  spinOdds,
} from "@/lib/spin/disclosure";

// ---------------------------------------------------------------------------
// THE DISCLOSURE MUST DESCRIBE THE WHEEL THAT ACTUALLY EXISTS.
//
// A published odds table is the one piece of customer-facing copy that can be
// made false by a change somewhere else entirely — edit a wedge and the
// sentence about it is wrong with nothing to catch it. So every assertion here
// compares the disclosure against SPIN_PRIZES rather than against a literal.
// ---------------------------------------------------------------------------

describe("the published odds", () => {
  it("covers every wedge exactly once", () => {
    const odds = spinOdds();
    expect(odds).toHaveLength(SPIN_PRIZES.length);
    expect(odds.map((entry) => entry.prize.id)).toEqual(SPIN_PRIZES.map((prize) => prize.id));
  });

  it("is uniform, because the draw is", () => {
    for (const entry of spinOdds()) {
      expect(entry.oneIn).toBe(SPIN_PRIZES.length);
    }
  });

  it("sums to 100%, so nothing is unaccounted for", () => {
    const total = spinOdds().reduce((sum, entry) => sum + entry.percent, 0);
    expect(Math.round(total)).toBe(100);
  });

  it("publishes the same minimum the prize table enforces", () => {
    // The failure this catches: a wedge's minimum edited in the table while the
    // odds list keeps quoting the old one, so the customer is told a number the
    // checkout will not honour.
    for (const entry of spinOdds()) {
      expect(entry.minSubtotalCents).toBe(entry.prize.minSubtotalCents);
    }
  });
});

describe("the minimum-spend tiers", () => {
  it("derives them from the wheel rather than restating them", () => {
    expect(spinMinimumTiers()).toEqual([0, 3_500, 7_500, 9_900, 12_500, 15_000, 17_500, 20_000]);
  });

  it("lists each tier once, ascending", () => {
    const tiers = spinMinimumTiers();
    expect(new Set(tiers).size).toBe(tiers.length);
    expect([...tiers].sort((a, b) => a - b)).toEqual(tiers);
  });
});

describe("the terms shown before anyone spins", () => {
  it("states the expiry the service actually writes", () => {
    expect(SPIN_EXPIRY_HOURS).toBe(72);
    expect(SPIN_TERMS.some((term) => term.includes("72 hours"))).toBe(true);
  });

  it("states the real odds, not a rounded boast", () => {
    expect(SPIN_TERMS.some((term) => term.includes(`1 in ${SPIN_PRIZES.length}`))).toBe(true);
  });

  it("says every spin wins, which is what keeps this out of sweepstakes law", () => {
    expect(SPIN_TERMS.some((term) => /every spin wins/i.test(term))).toBe(true);
  });

  it("says the spin is one per customer and final", () => {
    expect(SPIN_TERMS.some((term) => /one spin per customer/i.test(term))).toBe(true);
  });

  it("distinguishes stacking for products from stacking for percentages", () => {
    // These two rules genuinely differ in quote-order.ts, and a single blanket
    // sentence would be false for one of them. Both must be stated.
    expect(SPIN_TERMS.some((term) => /free product is added on top/i.test(term))).toBe(true);
    expect(SPIN_TERMS.some((term) => /percentage prize replaces/i.test(term))).toBe(true);
  });

  it("warns that free shipping is only worth something where shipping is charged", () => {
    expect(SPIN_TERMS.some((term) => /shipping would otherwise be charged/i.test(term))).toBe(true);
  });
});

describe("what each prize requires", () => {
  it("names the real minimum for every wedge", () => {
    for (const prize of SPIN_PRIZES) {
      const sentence = describeRedemptionCondition(prize);
      if (prize.minSubtotalCents === 0) {
        expect(sentence, prize.id).toContain("any order");
      } else {
        expect(sentence, prize.id).toContain(formatMoneyFromCents(prize.minSubtotalCents));
      }
    }
  });

  it("states the ceiling on a percentage, because the till applies one", () => {
    // A percentage advertised without its cap is the one number here a customer
    // could reasonably feel misled by: they only meet it at checkout.
    for (const prize of SPIN_PRIZES) {
      if (prize.reward.kind !== "percent" || !prize.maxDiscountCents) continue;
      expect(describeRedemptionCondition(prize), prize.id)
        .toContain(`Up to ${formatMoneyFromCents(prize.maxDiscountCents)}`);
    }
  });

  it("caps 15% at $30 and 20% at $40", () => {
    const caps = Object.fromEntries(
      SPIN_PRIZES.filter((p) => p.reward.kind === "percent").map((p) => [p.id, p.maxDiscountCents]),
    );
    expect(caps).toEqual({ percent_15_a: 3_000, percent_20: 4_000, percent_15_b: 3_000 });
  });

  it("tells a percentage winner it replaces their other discounts", () => {
    const percentPrize = SPIN_PRIZES.find((prize) => prize.reward.kind === "percent")!;
    expect(describeRedemptionCondition(percentPrize)).toMatch(/replaces other discounts/i);
  });

  it("tells a product winner it is added on top", () => {
    const productPrize = SPIN_PRIZES.find((prize) => prize.reward.kind === "free_product")!;
    expect(describeRedemptionCondition(productPrize)).toMatch(/on top of any other discount/i);
  });
});

describe("money formatting", () => {
  it("drops the cents on a round number and keeps them otherwise", () => {
    expect(formatMoneyFromCents(20_000)).toBe("$200");
    expect(formatMoneyFromCents(3_500)).toBe("$35");
    expect(formatMoneyFromCents(9_900)).toBe("$99");
    expect(formatMoneyFromCents(4_999)).toBe("$49.99");
  });
});
