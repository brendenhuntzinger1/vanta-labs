import { describe, expect, it } from "vitest";

import {
  SPIN_PRIZES,
  SPIN_TTL_DAYS,
  doseRungFor,
  drawSpinPrize,
  entryDoseRung,
  giftConfigForPrize,
  prizeForOfferRow,
  prizeNeedsDoseChoice,
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
    // THE THREE GLP ENTRIES MOVED WITH THE DOSE LADDER, DELIBERATELY.
    //
    // They were a flat $99 when a wedge had one minimum. The ladder sets each
    // entry rung at twice the entry dose's retail — $90 for GLP-1's $44.99 5mg,
    // $100 for GLP-2 and GLP-3's $49.99 — and the scalar tracks the entry rung
    // so pre-claim surfaces show the cheapest, most reachable number. HGH keeps
    // its live $125: it is already set and moving it buys nothing.
    //
    // See docs/superpowers/specs/2026-09-18-dose-ladder-design.md. If you are
    // here because this failed, check the change was intended before editing —
    // that is what this test is for.
    const minimums = Object.fromEntries(SPIN_PRIZES.map((prize) => [prize.id, prize.minSubtotalCents]));
    expect(minimums).toEqual({
      recon_water: 3_500,
      free_shipping: 3_500,
      percent_15_a: 0,
      percent_20: 0,
      percent_15_b: 0,
      ghk_cu: 7_500,
      mt_2: 7_500,
      glp_1: 9_000,
      glp_2: 10_000,
      glp_3: 10_000,
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

// ---------------------------------------------------------------------------
// THE DOSE LADDER.
//
// Four products sell in more than one size, and a winner picks which one they
// want. The minimum rises with the dose — but NOT in proportion, and that is
// the entire mechanism. At a constant multiple k, stepping up costs
// k x delta-retail to gain delta-retail, so for any k > 1 every upgrade is a
// losing trade and the rational customer always takes the smallest vial. The
// ladder is priced so each extra dollar of free product costs 80c of extra
// spend, which makes every step up a gain by construction.
//
// These tests are what stop someone "tidying" a rung and quietly turning the
// choice back into a formality.
// ---------------------------------------------------------------------------

const LADDERED = ["glp_1", "glp_2", "glp_3", "hgh"] as const;

describe("the dose ladder", () => {
  it("puts a ladder on exactly the four multi-dose products", () => {
    const withDoses = SPIN_PRIZES.filter((prize) => (prize.doses?.length ?? 0) > 0).map((prize) => prize.id);
    expect(withDoses.sort()).toEqual([...LADDERED].sort());
  });

  it("leaves every single-dose prize without a picker", () => {
    for (const prize of SPIN_PRIZES) {
      if ((LADDERED as readonly string[]).includes(prize.id)) continue;
      expect(prizeNeedsDoseChoice(prize), `${prize.id} must not ask for a dose`).toBe(false);
    }
  });

  it("MAKES EVERY STEP UP WORTH TAKING — the whole point of the feature", () => {
    // If this fails the ladder is decorative: the customer is being asked for
    // more money than the extra vial is worth, and will always decline.
    for (const prize of SPIN_PRIZES) {
      const rungs = prize.doses ?? [];
      for (let i = 1; i < rungs.length; i++) {
        const stepCost = rungs[i].minSubtotalCents - rungs[i - 1].minSubtotalCents;
        const stepGain = rungs[i].retailCentsAtDesignTime - rungs[i - 1].retailCentsAtDesignTime;
        expect(
          stepCost,
          `${prize.id} ${rungs[i - 1].label}->${rungs[i].label}: asks $${(stepCost / 100).toFixed(0)} more `
            + `for $${(stepGain / 100).toFixed(0)} more product — nobody takes that step`,
        ).toBeLessThanOrEqual(stepGain);
      }
    }
  });

  it("keeps EVERY rung under a fifth of the order it gates, not just the entry dose", () => {
    // The per-slug snapshot this replaces could only ever check the default
    // dose's cost. A 30mg GLP-1 costs more than twice the 5mg, so the expensive
    // rungs went unguarded while the suite stayed green — a guard that passes
    // vacuously is worse than one that fails.
    for (const prize of SPIN_PRIZES) {
      for (const rung of prize.doses ?? []) {
        const share = rung.costCentsAtDesignTime / rung.minSubtotalCents;
        expect(
          share,
          `${prize.id} ${rung.label}: a $${(rung.costCentsAtDesignTime / 100).toFixed(2)} gift on a `
            + `$${(rung.minSubtotalCents / 100).toFixed(0)} minimum is ${(share * 100).toFixed(1)}%`,
        ).toBeLessThan(0.2);
      }
    }
  });

  it("orders the rungs cheapest first, so the entry dose is the one a scalar reader sees", () => {
    for (const prize of SPIN_PRIZES) {
      const rungs = prize.doses ?? [];
      for (let i = 1; i < rungs.length; i++) {
        expect(rungs[i].minSubtotalCents, `${prize.id} rungs out of order`).toBeGreaterThan(rungs[i - 1].minSubtotalCents);
        expect(rungs[i].retailCentsAtDesignTime).toBeGreaterThan(rungs[i - 1].retailCentsAtDesignTime);
      }
    }
  });

  it("keeps the prize's own minimum equal to the entry rung, so nothing over-promises", () => {
    // Every pre-claim surface reads prize.minSubtotalCents. If that drifted
    // above the cheapest rung the wheel would advertise a harder condition than
    // the customer can actually take; below it, an unreachable one.
    for (const prize of SPIN_PRIZES) {
      const entry = entryDoseRung(prize);
      if (!entry) continue;
      expect(prize.minSubtotalCents, `${prize.id}`).toBe(entry.minSubtotalCents);
    }
  });

  it("gives every rung a distinct label, because the label is the lookup key", () => {
    for (const prize of SPIN_PRIZES) {
      const labels = (prize.doses ?? []).map((rung) => rung.label.toLowerCase());
      expect(new Set(labels).size, `${prize.id} has a duplicate dose label`).toBe(labels.length);
    }
  });

  it("still ships a free vial only on a real order, at every rung", () => {
    for (const prize of SPIN_PRIZES) {
      for (const rung of prize.doses ?? []) {
        expect(rung.minSubtotalCents, `${prize.id} ${rung.label}`).toBeGreaterThanOrEqual(3_500);
      }
    }
  });
});

describe("resolving the dose a customer asked for", () => {
  const glp1 = SPIN_PRIZES.find((prize) => prize.id === "glp_1")!;
  const reconWater = SPIN_PRIZES.find((prize) => prize.id === "recon_water")!;

  it("finds a rung the prize actually offers", () => {
    expect(doseRungFor(glp1, "30mg")?.minSubtotalCents).toBe(17_000);
  });

  it("is case and whitespace insensitive, because the label round-trips through a form", () => {
    expect(doseRungFor(glp1, "  30MG ")?.label).toBe("30mg");
  });

  it("REFUSES a dose this prize does not offer — no falling back to the entry rung", () => {
    // Falling back is how a customer is billed against one minimum and shipped
    // another dose. Null forces the caller to refuse.
    expect(doseRungFor(glp1, "80mg")).toBeNull();
    expect(doseRungFor(glp1, "")).toBeNull();
    expect(doseRungFor(glp1, null)).toBeNull();
    expect(doseRungFor(glp1, "5e5900c3-b7f7-4063-b7eb-9d9dc9a4d73d")).toBeNull();
  });

  it("refuses any dose at all on a single-dose prize", () => {
    expect(doseRungFor(reconWater, "10mL")).toBeNull();
    expect(prizeNeedsDoseChoice(reconWater)).toBe(false);
  });

  it("falls back to the cheapest rung for a customer who never chose", () => {
    expect(entryDoseRung(glp1)?.label).toBe("5mg");
    expect(entryDoseRung(reconWater)).toBeNull();
  });
});
