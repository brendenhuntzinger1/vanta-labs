import { describe, expect, it } from "vitest";

import { SPIN_PRIZES } from "@/lib/spin/prize-table";
import {
  SPIN_EXPIRY_HOURS,
  distinctPrizeCount,
  SPIN_TERMS,
  describeExactCondition,
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
  it("lists PRIZES, not wedges — a reward on two wedges is one row", () => {
    const odds = spinOdds();
    // Sixteen wedges, fewer prizes: "15% off" occupies two of them.
    expect(odds.length).toBeLessThan(SPIN_PRIZES.length);
    expect(odds.length).toBe(distinctPrizeCount());
    expect(new Set(odds.map((e) => e.prize.id)).size).toBe(odds.length);
  });

  it("gives a doubled-up reward its REAL odds, not 1 in 16 twice", () => {
    // The bug this replaces: two rows each claiming "1 in 16" understated a
    // customer's real chance of a percentage, and implied 15% and 20% were
    // equally likely when one is twice the other.
    const fifteen = spinOdds().find((e) => e.prize.reward.kind === "percent" && e.prize.reward.percent === 15)!;
    const twenty = spinOdds().find((e) => e.prize.reward.kind === "percent" && e.prize.reward.percent === 20)!;
    expect(fifteen.wedges).toBe(2);
    expect(twenty.wedges).toBe(1);
    expect(fifteen.percent).toBeCloseTo(12.5, 2);
    expect(twenty.percent).toBeCloseTo(6.25, 2);
  });

  it("accounts for every wedge across the grouped rows", () => {
    expect(spinOdds().reduce((sum, e) => sum + e.wedges, 0)).toBe(SPIN_PRIZES.length);
    for (const entry of spinOdds()) expect(entry.outOf).toBe(SPIN_PRIZES.length);
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

  it("says how many WEDGES and how many PRIZES, because they differ", () => {
    // "16 prizes" would be false: sixteen wedges grant fifteen rewards.
    expect(SPIN_TERMS.some((term) => term.includes(`${SPIN_PRIZES.length} wedges`))).toBe(true);
    expect(SPIN_TERMS.some((term) => term.includes(`${distinctPrizeCount()} prizes`))).toBe(true);
    expect(distinctPrizeCount()).toBeLessThan(SPIN_PRIZES.length);
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
  it("NEVER names the minimum in the copy shown beside the wheel", () => {
    // A dollar minimum against every wedge reads as a price of entry before
    // anyone has won anything. The figure lives in the full terms and in the
    // cart; what the wheel states is that a purchase is required.
    for (const prize of SPIN_PRIZES) {
      const sentence = describeRedemptionCondition(prize);
      expect(sentence, prize.id).toMatch(/qualifying purchase/i);
      if (prize.minSubtotalCents > 0) {
        expect(sentence, prize.id).not.toContain(formatMoneyFromCents(prize.minSubtotalCents));
      }
    }
  });

  it("names the real minimum in the full terms, so nothing is actually hidden", () => {
    // The disclosure is softened, not removed. A minimum a customer only meets
    // at the till is what produces "bait and switch" complaints.
    for (const prize of SPIN_PRIZES) {
      const sentence = describeExactCondition(prize);
      if (prize.minSubtotalCents === 0) {
        expect(sentence, prize.id).toContain("any order");
      } else {
        expect(sentence, prize.id).toContain(formatMoneyFromCents(prize.minSubtotalCents));
      }
    }
  });

  it("keeps the percentage CEILING in the visible copy, unlike the minimum", () => {
    // A cap limits what they receive rather than what they must spend, so
    // discovering it at the till is exactly the surprise to avoid.
    for (const prize of SPIN_PRIZES) {
      if (prize.reward.kind !== "percent" || !prize.maxDiscountCents) continue;
      expect(describeRedemptionCondition(prize), prize.id)
        .toContain(`Up to ${formatMoneyFromCents(prize.maxDiscountCents)}`);
    }
  });

  it("states the ceiling on a percentage, because the till applies one", () => {
    // A percentage advertised without its cap is the one number here a customer
    // could reasonably feel misled by: they only meet it at checkout.
    for (const prize of SPIN_PRIZES) {
      if (prize.reward.kind !== "percent" || !prize.maxDiscountCents) continue;
      expect(describeExactCondition(prize), prize.id)
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

  it("still says a purchase is required in the terms list", () => {
    expect(SPIN_TERMS.some((term) => /qualifying purchase/i.test(term))).toBe(true);
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
