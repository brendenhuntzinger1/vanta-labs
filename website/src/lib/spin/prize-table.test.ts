import { describe, expect, it } from "vitest";

import {
  SPIN_PRIZES,
  SPIN_TTL_DAYS,
  drawSpinPrize,
  giftConfigForPrize,
  prizeForOfferRow,
} from "@/lib/spin/prize-table";

// ---------------------------------------------------------------------------
// THE WHEEL AND THE TILL MUST AGREE.
//
// A wheel that advertises what checkout will not honour is the failure this
// store has already designed against once (storefront-offers.ts, bxgy-engine.ts
// "a bar that can advertise what checkout will not honour"). The wheel is the
// same hazard with a bigger promise: the wedge is a picture, the minimum is a
// number in a row, and nothing but a test keeps them in step.
//
// So this file asserts the table itself, not the rendering. The page renders
// SPIN_PRIZES directly and has no second list to drift from.
// ---------------------------------------------------------------------------

/**
 * Live dose costs, read from Admin on 2026-09-16 (product_doses.
 * product_cost_cents). A SNAPSHOT, deliberately — the guard below asks whether
 * the prize table is still affordable at the costs it was designed against,
 * and a value fetched at test time would move with the thing it is checking.
 *
 * When a real cost changes, update it here and let the guard re-decide.
 */
const COST_CENTS_AT_DESIGN_TIME: Record<string, number> = {
  "recon-water": 143,
  "ghk-cu": 365,
  "mt-2-melanotan-ii": 530,
  "glp-1": 383,
  "glp-2": 438,
  "glp-3": 632,
  semax: 586,
  "cjc-1295-ipamorelin": 1112,
  "hgh-gh-191": 1200,
  kisspeptin: 898,
  glow: 2154,
  klow: 2507,
};

describe("the prize table", () => {
  it("has exactly sixteen wedges", () => {
    expect(SPIN_PRIZES).toHaveLength(16);
  });

  it("gives every wedge a unique id", () => {
    const ids = SPIN_PRIZES.map((prize) => prize.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("never puts a losing wedge on the wheel", () => {
    // Every spin wins. This is not decoration: it is what keeps the promotion a
    // discount reveal rather than a sweepstakes, and it is load-bearing for the
    // compliance position in the spec.
    for (const prize of SPIN_PRIZES) {
      expect(prize.reward, `${prize.id} must grant something`).toBeTruthy();
    }
  });

  it("expires every prize in 72 hours", () => {
    expect(SPIN_TTL_DAYS).toBe(3);
    for (const prize of SPIN_PRIZES) {
      expect(giftConfigForPrize(prize).ttlDays).toBe(3);
    }
  });
});

describe("the minimum order on each wedge", () => {
  it("keeps every gift under a fifth of the order it requires", () => {
    // THE MARGIN FLOOR, AS A TEST RATHER THAN A CONVENTION.
    //
    // The spec's rule is that a gift's cost must stay under 20% of the order it
    // gates. Written down in prose it survives exactly until someone re-prices
    // a product or drops a cheaper minimum onto a wedge. Written here, that
    // edit fails CI instead of quietly costing margin on every redemption.
    for (const prize of SPIN_PRIZES) {
      const slug = productSlugOf(prize);
      if (!slug) continue;

      const cost = COST_CENTS_AT_DESIGN_TIME[slug];
      expect(cost, `no recorded cost for ${slug} — add it to the snapshot`).toBeDefined();

      const share = cost / prize.minSubtotalCents;
      expect(
        share,
        `${prize.id}: a $${(cost / 100).toFixed(2)} gift on a $${(prize.minSubtotalCents / 100).toFixed(0)} minimum is ${(share * 100).toFixed(1)}% — over the 20% floor`,
      ).toBeLessThan(0.2);
    }
  });

  it("asks for no minimum only where a small order cannot cost the store anything", () => {
    // A PERCENTAGE IS THE ONLY REWARD THAT IS SAFE AT ZERO.
    //
    // It scales with the basket, so a tiny order discounts a tiny amount and
    // there is no fixed cost to defend against. Every other reward here carries
    // one: a free vial costs its COGS whatever the order is, and a shipping
    // waiver costs $7.93 of postage. Those two get the $35 floor instead — see
    // the wedges themselves.
    const openToAll = SPIN_PRIZES.filter((prize) => prize.minSubtotalCents === 0).map((prize) => prize.id);
    expect(openToAll.sort()).toEqual(["percent_15_a", "percent_15_b", "percent_20"]);
  });

  it("never ships a free vial on an order that is not a real order", () => {
    // The guard the codebase already states as GIFT_MIN_SUBTOTAL_FOR_PRODUCT_CENTS
    // ($10). Held higher here, at the $35 the win-back catalogue uses, because
    // a $10 order plus a shipped vial is still a loss once postage is counted.
    for (const prize of SPIN_PRIZES) {
      if (prize.reward.kind !== "free_product" && prize.reward.kind !== "free_shipping") continue;
      expect(prize.minSubtotalCents, `${prize.id} ships something and must require a real order`).toBeGreaterThanOrEqual(3_500);
    }
  });

  it("matches the minimums the spec agreed, to the cent", () => {
    const minimums = Object.fromEntries(SPIN_PRIZES.map((prize) => [prize.id, prize.minSubtotalCents]));
    expect(minimums).toEqual({
      recon_water: 3_500,
      free_shipping: 3_500,
      percent_15_a: 0,
      percent_20: 0,
      percent_15_b: 0,
      ghk_cu: 7_500,
      mt_2: 7_500,
      glp_1: 9_900,
      glp_2: 9_900,
      glp_3: 9_900,
      semax: 9_900,
      cjc_ipamorelin: 12_500,
      hgh: 12_500,
      kisspeptin: 15_000,
      glow: 17_500,
      klow: 20_000,
    });
  });
});

describe("drawing a prize", () => {
  it("asks the generator for one index across the whole wheel", () => {
    // The bound matters more than it looks: an off-by-one here silently makes
    // the last wedge unwinnable, which no customer can ever report.
    const asked: number[] = [];
    drawSpinPrize((bound) => {
      asked.push(bound);
      return 0;
    });
    expect(asked).toEqual([16]);
  });

  it("returns the wedge the generator chose", () => {
    for (let index = 0; index < SPIN_PRIZES.length; index += 1) {
      expect(drawSpinPrize(() => index)).toBe(SPIN_PRIZES[index]);
    }
  });

  it("can land on every wedge, including the jackpot", () => {
    const reached = new Set<string>();
    for (let index = 0; index < SPIN_PRIZES.length; index += 1) {
      reached.add(drawSpinPrize(() => index).id);
    }
    expect(reached.size).toBe(16);
    expect(reached.has("klow")).toBe(true);
  });
});

describe("recognising a prize already won", () => {
  it("maps a stored offer row back to its wedge, so a returning visitor sees the same result", () => {
    const klow = SPIN_PRIZES.find((prize) => prize.id === "klow")!;
    const found = prizeForOfferRow({
      reward_kind: "free_product",
      product_slug: "klow",
      percent_off: null,
    });
    expect(found).toBe(klow);
  });

  it("maps a percentage row back to a percentage wedge", () => {
    const found = prizeForOfferRow({ reward_kind: "percent", product_slug: null, percent_off: 20 });
    expect(found?.id).toBe("percent_20");
  });

  it("returns null for a row the wheel never minted", () => {
    // A cart-recovery gift is a real live offer that this wheel did not produce.
    // Returning a wedge for it would animate the wheel to a prize the customer
    // never span for.
    expect(prizeForOfferRow({ reward_kind: "free_product", product_slug: "kpv", percent_off: null })).toBeNull();
  });
});

function productSlugOf(prize: (typeof SPIN_PRIZES)[number]): string | null {
  return prize.reward.kind === "free_product" ? prize.reward.productSlug : null;
}
