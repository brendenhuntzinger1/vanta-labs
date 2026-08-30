import { describe, expect, it } from "vitest";
import {
  applyBxgyPromotion,
  collectEligibleUnitPrices,
  groupSize,
  isPromotionLive,
  isPromotionScheduled,
  isSlugEligible,
  liveBxgyPromotions,
  nextBxgyOpportunity,
  nextOpportunityForCart,
  selectPromotionForCart,
  progressMessage,
  promotionHeadline,
  rewardUnitCount,
  selectBxgyPromotion,
  storefrontDescription,
  unitsUntilNextReward,
  type BxgyLine,
  type BxgyPromotion,
} from "./bxgy-engine";
import {
  LEGACY_BUY_3_GET_1_ID,
  applyLegacyPromotionFlags,
  defaultBxgyPromotions,
  legacyFlagKeyFor,
  normalizeBxgyPromotion,
  resolveBxgyPromotions,
  serializeBxgyPromotions,
} from "./bxgy-config";

function promo(overrides: Partial<BxgyPromotion> = {}): BxgyPromotion {
  return {
    id: "test-promo",
    name: "Test Promo",
    enabled: true,
    buyQuantity: 2,
    getQuantity: 1,
    rewardPercent: 100,
    eligibility: { includeSlugs: [], excludeSlugs: [] },
    startsAt: null,
    endsAt: null,
    maxRedemptions: null,
    perCustomerLimit: null,
    maxRewardUnitsPerOrder: null,
    stackWithCoupon: false,
    stackWithBundlePricing: false,
    priority: 10,
    ...overrides,
  };
}

function line(slug: string, unitPrice: number, quantity: number): BxgyLine {
  return { slug, unitPrice, quantity };
}

/** The six promotions the centre ships, by id, all switched on. */
function builtIn(id: string, overrides: Partial<BxgyPromotion> = {}): BxgyPromotion {
  const found = defaultBxgyPromotions().find((entry) => entry.id === id);
  if (!found) throw new Error(`no built-in promotion ${id}`);
  return { ...found, enabled: true, ...overrides };
}

// ---------------------------------------------------------------------------
// THE ARITHMETIC, ONE PROMOTION SHAPE AT A TIME
// ---------------------------------------------------------------------------

describe("reward counts — the group rule every promotion shares", () => {
  it("earns one reward per complete group of X+Y", () => {
    const bogo = promo({ buyQuantity: 1, getQuantity: 1 });
    expect(groupSize(bogo)).toBe(2);
    expect(rewardUnitCount(1, bogo)).toBe(0);
    expect(rewardUnitCount(2, bogo)).toBe(1);
    expect(rewardUnitCount(3, bogo)).toBe(1);
    expect(rewardUnitCount(4, bogo)).toBe(2);
  });

  it("Buy 2 Get 1 rewards every third unit", () => {
    const p = promo({ buyQuantity: 2, getQuantity: 1 });
    expect([2, 3, 5, 6, 9].map((n) => rewardUnitCount(n, p))).toEqual([0, 1, 1, 2, 3]);
  });

  it("Buy 3 Get 2 rewards two units per group of five", () => {
    const p = promo({ buyQuantity: 3, getQuantity: 2 });
    expect(groupSize(p)).toBe(5);
    expect([4, 5, 9, 10, 15].map((n) => rewardUnitCount(n, p))).toEqual([0, 2, 2, 4, 6]);
  });

  it("Buy 3 Get 1 rewards every fourth unit — the store's original promotion, unchanged", () => {
    const p = promo({ buyQuantity: 3, getQuantity: 1 });
    // Exactly floor(n / 4), which is what calculateBuy3Get1Discount computed.
    for (let n = 0; n <= 40; n += 1) {
      expect(rewardUnitCount(n, p)).toBe(Math.floor(n / 4));
    }
  });

  it("caps rewards at maxRewardUnitsPerOrder", () => {
    const p = promo({ buyQuantity: 1, getQuantity: 1, maxRewardUnitsPerOrder: 2 });
    expect(rewardUnitCount(20, p)).toBe(2);
  });

  it("counts down to the next group", () => {
    const p = promo({ buyQuantity: 3, getQuantity: 1 });
    expect(unitsUntilNextReward(0, p)).toBe(0); // empty cart says nothing
    expect(unitsUntilNextReward(1, p)).toBe(3);
    expect(unitsUntilNextReward(3, p)).toBe(1);
    expect(unitsUntilNextReward(4, p)).toBe(0);
    expect(unitsUntilNextReward(5, p)).toBe(3);
  });
});

describe("the five promotions from the brief, priced on a real basket", () => {
  // Four units: $100, $80, $60, $40.
  const basket = [line("a", 100, 1), line("b", 80, 1), line("c", 60, 1), line("d", 40, 1)];

  it("Buy 2 Get 1 Free — cheapest of each group of three is free", () => {
    const result = applyBxgyPromotion(basket, builtIn("buy-2-get-1-free"));
    // 4 units → 1 complete group of 3 → the single cheapest unit ($40) is free.
    expect(result?.rewardUnits).toBe(1);
    expect(result?.discountAmount).toBe(40);
  });

  it("Buy 3 Get 2 Free", () => {
    const bigger = [...basket, line("e", 20, 1)];
    const result = applyBxgyPromotion(bigger, builtIn("buy-3-get-2-free"));
    // 5 units → one group → the two cheapest ($20 + $40) are free.
    expect(result?.rewardUnits).toBe(2);
    expect(result?.discountAmount).toBe(60);
  });

  it("Buy 1 Get 1 Free — BOGO halves an even basket by value of the cheapest half", () => {
    const result = applyBxgyPromotion(basket, builtIn("buy-1-get-1-free"));
    // 4 units → 2 groups → the two cheapest ($40 + $60) are free.
    expect(result?.rewardUnits).toBe(2);
    expect(result?.discountAmount).toBe(100);
  });

  it("Buy 1 Get 1 50% Off — second item half price", () => {
    const result = applyBxgyPromotion(basket, builtIn("buy-1-get-1-half-off"));
    // Two rewarded units at 50%: ($40 + $60) / 2.
    expect(result?.rewardUnits).toBe(2);
    expect(result?.discountAmount).toBe(50);
  });

  it("Buy 2 Get 1 50% Off", () => {
    const result = applyBxgyPromotion(basket, builtIn("buy-2-get-1-half-off"));
    expect(result?.rewardUnits).toBe(1);
    expect(result?.discountAmount).toBe(20); // half of the $40 unit
  });

  it("Buy 3 Get 1 Free still gives the cheapest of four away", () => {
    const result = applyBxgyPromotion(basket, builtIn(LEGACY_BUY_3_GET_1_ID));
    expect(result?.rewardUnits).toBe(1);
    expect(result?.discountAmount).toBe(40);
  });

  it("earns nothing on a basket short of a full group", () => {
    expect(applyBxgyPromotion([line("a", 100, 2)], builtIn("buy-3-get-2-free"))).toBeNull();
    expect(applyBxgyPromotion([], builtIn("buy-1-get-1-free"))).toBeNull();
  });
});

describe("mixed-price carts and quantities", () => {
  it("treats quantity on one line the same as separate lines", () => {
    const p = builtIn("buy-2-get-1-free");
    const asQuantity = applyBxgyPromotion([line("a", 50, 6)], p);
    const asLines = applyBxgyPromotion(
      [line("a", 50, 1), line("b", 50, 1), line("c", 50, 1), line("d", 50, 1), line("e", 50, 1), line("f", 50, 1)],
      p,
    );
    expect(asQuantity?.discountAmount).toBe(asLines?.discountAmount);
    expect(asQuantity?.discountAmount).toBe(100); // 2 groups → 2 free units
  });

  it("always rewards the cheapest units, never the expensive ones", () => {
    const result = applyBxgyPromotion(
      [line("cheap", 10, 3), line("dear", 500, 3)],
      builtIn("buy-1-get-1-free"),
    );
    // 6 units → 3 free → the three $10 units.
    expect(result?.rewardedUnitPrices).toEqual([10, 10, 10]);
    expect(result?.discountAmount).toBe(30);
  });

  it("rounds to cents rather than accumulating fractions", () => {
    const result = applyBxgyPromotion(
      [line("a", 33.33, 1), line("b", 33.33, 1)],
      builtIn("buy-1-get-1-half-off"),
    );
    expect(result?.discountAmount).toBe(16.67); // 33.33 * 0.5 = 16.665 → 16.67
  });

  it("ignores malformed lines instead of pricing them as NaN", () => {
    const result = applyBxgyPromotion(
      [line("a", Number.NaN, 4), line("b", 40, 2)],
      builtIn("buy-1-get-1-free"),
    );
    expect(result?.eligibleUnits).toBe(2);
    expect(result?.discountAmount).toBe(40);
  });

  it("counts a zero-priced unit but takes nothing off for it", () => {
    // A $0 line still fills a group; the reward is the cheapest unit, which is
    // the free one, so the promotion is worth nothing rather than worth the
    // next unit up.
    const result = applyBxgyPromotion([line("free-gift", 0, 1), line("a", 90, 1)], builtIn("buy-1-get-1-free"));
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// ELIGIBILITY AND EXCLUSIONS
// ---------------------------------------------------------------------------

describe("product eligibility and exclusions", () => {
  it("is store-wide when no include list is set", () => {
    const p = promo();
    expect(isSlugEligible(p, "anything")).toBe(true);
  });

  it("narrows to the include list", () => {
    const p = promo({ eligibility: { includeSlugs: ["alpha", "beta"], excludeSlugs: [] } });
    expect(isSlugEligible(p, "alpha")).toBe(true);
    expect(isSlugEligible(p, "gamma")).toBe(false);
  });

  it("lets an exclusion beat the include list", () => {
    const p = promo({ eligibility: { includeSlugs: ["alpha"], excludeSlugs: ["alpha"] } });
    expect(isSlugEligible(p, "alpha")).toBe(false);
  });

  it("matches slugs case- and whitespace-insensitively", () => {
    const p = promo({ eligibility: { includeSlugs: [" Alpha "], excludeSlugs: [] } });
    expect(isSlugEligible(p, "ALPHA")).toBe(true);
  });

  it("prices only the eligible units of a mixed cart", () => {
    const p = builtIn("buy-1-get-1-free", { eligibility: { includeSlugs: ["alpha"], excludeSlugs: [] } });
    const result = applyBxgyPromotion([line("alpha", 60, 2), line("omega", 10, 4)], p);
    expect(result?.eligibleUnits).toBe(2);
    expect(result?.discountAmount).toBe(60); // the excluded $10 units never become the free one
  });

  it("earns nothing when every eligible product is excluded", () => {
    const p = builtIn("buy-1-get-1-free", { eligibility: { includeSlugs: [], excludeSlugs: ["alpha"] } });
    expect(applyBxgyPromotion([line("alpha", 60, 4)], p)).toBeNull();
  });

  it("collects eligible units cheapest-first", () => {
    expect(collectEligibleUnitPrices([line("a", 90, 1), line("b", 10, 2)], promo())).toEqual([10, 10, 90]);
  });
});

// ---------------------------------------------------------------------------
// SCHEDULING: AUTOMATIC ACTIVATION AND EXPIRY
// ---------------------------------------------------------------------------

describe("scheduling", () => {
  const window = promo({ startsAt: "2026-09-01T00:00:00Z", endsAt: "2026-09-08T00:00:00Z" });

  it("is inert before the start", () => {
    expect(isPromotionScheduled(window, new Date("2026-08-31T23:59:59Z"))).toBe(false);
  });

  it("activates itself at the start instant", () => {
    expect(isPromotionScheduled(window, new Date("2026-09-01T00:00:00Z"))).toBe(true);
  });

  it("expires itself at the end instant, exclusive", () => {
    expect(isPromotionScheduled(window, new Date("2026-09-07T23:59:59Z"))).toBe(true);
    expect(isPromotionScheduled(window, new Date("2026-09-08T00:00:00Z"))).toBe(false);
  });

  it("treats a missing bound as open-ended", () => {
    const openEnded = promo({ startsAt: null, endsAt: null });
    expect(isPromotionScheduled(openEnded, new Date("1999-01-01T00:00:00Z"))).toBe(true);
    expect(isPromotionScheduled(openEnded, new Date("2999-01-01T00:00:00Z"))).toBe(true);
  });

  it("never expires a live promotion because a date was unparsable", () => {
    const broken = promo({ startsAt: "not a date", endsAt: "also not a date" });
    expect(isPromotionScheduled(broken, new Date())).toBe(true);
  });

  it("a scheduled promotion that is switched off is not live", () => {
    expect(isPromotionLive(promo({ enabled: false }), new Date())).toBe(false);
  });

  it("drops out of the live list once the window closes", () => {
    const live = liveBxgyPromotions([window], { now: new Date("2026-09-09T00:00:00Z") });
    expect(live).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// USAGE LIMITS AND SELECTION
// ---------------------------------------------------------------------------

describe("selection — one Buy X Get Y promotion per order", () => {
  const basket = [line("a", 100, 1), line("b", 80, 1), line("c", 60, 1), line("d", 40, 1)];

  it("picks the promotion worth the most on this basket", () => {
    const chosen = selectBxgyPromotion(basket, [
      builtIn("buy-2-get-1-free"),   // $40 off
      builtIn("buy-1-get-1-free"),   // $100 off
      builtIn(LEGACY_BUY_3_GET_1_ID), // $40 off
    ]);
    expect(chosen?.promotion.id).toBe("buy-1-get-1-free");
    expect(chosen?.application.discountAmount).toBe(100);
  });

  it("never applies two promotions at once", () => {
    const chosen = selectBxgyPromotion(basket, defaultBxgyPromotions().map((p) => ({ ...p, enabled: true })));
    expect(chosen?.application.discountAmount).toBe(100); // the single best, not a sum
  });

  it("breaks a tie on priority, then deterministically on id", () => {
    const a = promo({ id: "aaa", buyQuantity: 1, getQuantity: 1, priority: 5 });
    const b = promo({ id: "bbb", buyQuantity: 1, getQuantity: 1, priority: 9 });
    expect(selectBxgyPromotion(basket, [a, b])?.promotion.id).toBe("bbb");
    const sameP = { ...b, priority: 5 };
    expect(selectBxgyPromotion(basket, [a, sameP])?.promotion.id).toBe("aaa");
  });

  it("skips a promotion that has hit its usage limit", () => {
    const chosen = selectBxgyPromotion(basket, [builtIn("buy-1-get-1-free"), builtIn("buy-2-get-1-free")], {
      exhaustedIds: ["buy-1-get-1-free"],
    });
    expect(chosen?.promotion.id).toBe("buy-2-get-1-free");
    expect(chosen?.application.discountAmount).toBe(40);
  });

  it("applies nothing when every promotion is exhausted or off", () => {
    expect(selectBxgyPromotion(basket, [builtIn("buy-1-get-1-free")], { exhaustedIds: ["buy-1-get-1-free"] })).toBeNull();
    expect(selectBxgyPromotion(basket, [builtIn("buy-1-get-1-free", { enabled: false })])).toBeNull();
    expect(selectBxgyPromotion(basket, [])).toBeNull();
  });

  it("respects the schedule when selecting", () => {
    const future = builtIn("buy-1-get-1-free", { startsAt: "2099-01-01T00:00:00Z" });
    expect(selectBxgyPromotion(basket, [future, builtIn("buy-2-get-1-free")])?.promotion.id)
      .toBe("buy-2-get-1-free");
  });
});

describe("the cart nudge", () => {
  it("names the promotion the shopper is closest to unlocking", () => {
    const cart = [line("a", 50, 2)]; // 2 units
    const next = nextBxgyOpportunity(cart, [
      builtIn("buy-2-get-1-free"),    // 1 unit away
      builtIn("buy-3-get-2-free"),    // 3 units away
    ]);
    expect(next?.promotion.id).toBe("buy-2-get-1-free");
    expect(next?.unitsAway).toBe(1);
  });

  it("says nothing when a group is already complete", () => {
    expect(nextBxgyOpportunity([line("a", 50, 2)], [builtIn("buy-1-get-1-free")])).toBeNull();
  });

  it("says nothing about a promotion whose products are not in the cart", () => {
    const p = builtIn("buy-2-get-1-free", { eligibility: { includeSlugs: ["other"], excludeSlugs: [] } });
    expect(nextBxgyOpportunity([line("a", 50, 2)], [p])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// WORDING
// ---------------------------------------------------------------------------

describe("customer-facing wording", () => {
  it("builds the headline from the configuration", () => {
    expect(promotionHeadline({ buyQuantity: 2, getQuantity: 1, rewardPercent: 100 })).toBe("Buy 2 Get 1 Free");
    expect(promotionHeadline({ buyQuantity: 1, getQuantity: 1, rewardPercent: 50 })).toBe("Buy 1 Get 1 50% Off");
    expect(promotionHeadline({ buyQuantity: 3, getQuantity: 2, rewardPercent: 100 })).toBe("Buy 3 Get 2 Free");
  });

  it("describes what was actually applied", () => {
    const free = applyBxgyPromotion([line("a", 50, 4)], builtIn("buy-1-get-1-free"));
    expect(free?.message).toBe("Buy 1 Get 1 Free applied — 2 items free.");
    const half = applyBxgyPromotion([line("a", 50, 2)], builtIn("buy-1-get-1-half-off"));
    expect(half?.message).toBe("Buy 1 Get 1 50% Off applied — 50% off 1 item.");
  });

  it("writes the nudge in units the shopper can act on", () => {
    expect(progressMessage(builtIn("buy-2-get-1-free"), 1)).toBe("Add 1 more item to unlock an item free.");
    expect(progressMessage(builtIn("buy-3-get-2-free"), 2)).toBe("Add 2 more items to unlock 2 items free.");
    expect(progressMessage(builtIn("buy-1-get-1-half-off"), 1)).toBe("Add 1 more item to unlock 50% off an item.");
  });

  it("says whether a promotion is storewide or limited to selected products", () => {
    expect(storefrontDescription(builtIn("buy-2-get-1-free"))).toContain("storewide");
    const limited = builtIn("buy-2-get-1-free", { eligibility: { includeSlugs: ["alpha"], excludeSlugs: [] } });
    expect(storefrontDescription(limited)).toContain("on selected products");
  });

  it("never calls a promotion storewide when products are excluded from it", () => {
    // The shipped Buy 1 Get 1 Free excludes two SKUs, so "storewide" would be
    // a promise it does not keep — read on the product page of an excluded
    // product, it is simply false.
    const withExclusion = builtIn("buy-2-get-1-free", { eligibility: { includeSlugs: [], excludeSlugs: ["alpha"] } });
    const described = storefrontDescription(withExclusion);
    expect(described).toContain("on eligible products");
    expect(described).not.toContain("storewide");

    const bogo = defaultBxgyPromotions().find((p) => p.id === "buy-1-get-1-free")!;
    expect(storefrontDescription(bogo)).not.toContain("storewide");
  });
});

// ---------------------------------------------------------------------------
// CONFIGURATION
// ---------------------------------------------------------------------------

describe("configuration round-trips", () => {
  it("ships all six promotions, switched off", () => {
    const promotions = defaultBxgyPromotions();
    expect(promotions.map((p) => p.id)).toEqual([
      "buy-1-get-1-free",
      "buy-2-get-1-free",
      "buy-3-get-2-free",
      LEGACY_BUY_3_GET_1_ID,
      "buy-1-get-1-half-off",
      "buy-2-get-1-half-off",
    ]);
    expect(promotions.every((p) => !p.enabled)).toBe(true);
  });

  it("survives a serialize/normalize round trip unchanged", () => {
    const original = builtIn("buy-2-get-1-free", {
      enabled: true,
      startsAt: "2026-09-01T00:00:00.000Z",
      endsAt: "2026-09-30T00:00:00.000Z",
      maxRedemptions: 100,
      perCustomerLimit: 2,
      maxRewardUnitsPerOrder: 3,
      stackWithCoupon: true,
      stackWithBundlePricing: true,
      eligibility: { includeSlugs: ["alpha"], excludeSlugs: ["beta"] },
    });
    const [serialized] = serializeBxgyPromotions([original]);
    expect(normalizeBxgyPromotion(serialized)).toEqual(original);
  });

  it("reads a blank usage limit as unlimited, never as zero", () => {
    const p = normalizeBxgyPromotion({ id: "buy-2-get-1-free", maxRedemptions: "", perCustomerLimit: null });
    expect(p?.maxRedemptions).toBeNull();
    expect(p?.perCustomerLimit).toBeNull();
  });

  it("rejects records that are not promotions", () => {
    expect(normalizeBxgyPromotion(null)).toBeNull();
    expect(normalizeBxgyPromotion({})).toBeNull();
    expect(normalizeBxgyPromotion({ id: "   " })).toBeNull();
  });

  it("keeps a custom promotion an admin added", () => {
    const resolved = resolveBxgyPromotions([{ id: "buy-5-get-2-free", buyQuantity: 5, getQuantity: 2, enabled: true }]);
    const custom = resolved.find((p) => p.id === "buy-5-get-2-free");
    expect(custom?.name).toBe("Buy 5 Get 2 Free");
    expect(custom?.enabled).toBe(true);
    expect(resolved).toHaveLength(defaultBxgyPromotions().length + 1);
  });

  it("returns every built-in when nothing has ever been stored", () => {
    expect(resolveBxgyPromotions(undefined).map((p) => p.id))
      .toEqual(defaultBxgyPromotions().map((p) => p.id));
    expect(resolveBxgyPromotions("garbage").every((p) => !p.enabled)).toBe(true);
  });

  it("lets the legacy Buy 3 Get 1 switch decide that promotion, both ways", () => {
    const stored = resolveBxgyPromotions([{ id: LEGACY_BUY_3_GET_1_ID, enabled: false }]);
    const on = applyLegacyPromotionFlags(stored, { buy3Get1Enabled: true });
    expect(on.find((p) => p.id === LEGACY_BUY_3_GET_1_ID)?.enabled).toBe(true);
    const off = applyLegacyPromotionFlags(on, { buy3Get1Enabled: false });
    expect(off.find((p) => p.id === LEGACY_BUY_3_GET_1_ID)?.enabled).toBe(false);
  });

  it("wires the previously dormant Buy 2 Get 1 (50% off) control-centre switch", () => {
    const stored = resolveBxgyPromotions([]);
    const on = applyLegacyPromotionFlags(stored, { buy2Get1HalfEnabled: true });
    expect(on.find((p) => p.id === "buy-2-get-1-half-off")?.enabled).toBe(true);
  });

  it("leaves a promotion alone when its legacy flag is absent", () => {
    const stored = applyLegacyPromotionFlags(
      resolveBxgyPromotions([{ id: LEGACY_BUY_3_GET_1_ID, enabled: true }, { id: "buy-2-get-1-free", enabled: true }]),
      {},
    );
    expect(stored.find((p) => p.id === LEGACY_BUY_3_GET_1_ID)?.enabled).toBe(true);
    expect(stored.find((p) => p.id === "buy-2-get-1-free")?.enabled).toBe(true);
  });

  it("names the control key that owns each legacy promotion", () => {
    expect(legacyFlagKeyFor(LEGACY_BUY_3_GET_1_ID)).toBe("buy_3_get_1_enabled");
    expect(legacyFlagKeyFor("buy-2-get-1-half-off")).toBe("buy_2_get_1_half_enabled");
    expect(legacyFlagKeyFor("buy-1-get-1-free")).toBeNull();
  });

  it("clamps an absurd configured quantity rather than trusting it", () => {
    const p = normalizeBxgyPromotion({ id: "x", buyQuantity: 1e9, getQuantity: -4, rewardPercent: 5000 });
    expect(p?.buyQuantity).toBe(100);
    expect(p?.getQuantity).toBe(1);
    expect(p?.rewardPercent).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// THE SHARED ENTRY POINT
//
// selectPromotionForCart is what the cart preview AND the server quote both
// call. These pin the valuation rule that used to be written out at each of
// those call sites — the one whose drift would show a shopper a total the card
// is not charged.
// ---------------------------------------------------------------------------

describe("selectPromotionForCart — the one call the cart and the checkout share", () => {
  const cart = [
    { slug: "a", listUnitPrice: 100, bundledUnitPrice: 92, quantity: 2 },
    { slug: "b", listUnitPrice: 40, bundledUnitPrice: 40, quantity: 2 },
  ];

  it("values a rewarded unit at FULL price when bundle pricing may not combine", () => {
    const chosen = selectPromotionForCart(cart, [builtIn("buy-1-get-1-free")], { bundleStacking: false });
    // Four units, two rewarded: the two cheapest at their LIST price.
    expect(chosen?.application.discountAmount).toBe(80);
  });

  it("values it at the bundle price when the store-wide switch allows combining", () => {
    const bundled = [
      { slug: "a", listUnitPrice: 100, bundledUnitPrice: 92, quantity: 2 },
      { slug: "b", listUnitPrice: 40, bundledUnitPrice: 36, quantity: 2 },
    ];
    const chosen = selectPromotionForCart(bundled, [builtIn("buy-1-get-1-free")], { bundleStacking: true });
    expect(chosen?.application.discountAmount).toBe(72); // 36 + 36
  });

  it("lets a single promotion opt into bundle pricing on its own", () => {
    const bundled = [{ slug: "b", listUnitPrice: 40, bundledUnitPrice: 36, quantity: 2 }];
    const promotions = [builtIn("buy-1-get-1-free", { stackWithBundlePricing: true })];
    expect(selectPromotionForCart(bundled, promotions, { bundleStacking: false })?.application.discountAmount)
      .toBe(36);
  });

  it("prices each promotion against its own valuation in the same pass", () => {
    const lines = [{ slug: "b", listUnitPrice: 100, bundledUnitPrice: 10, quantity: 4 }];
    const chosen = selectPromotionForCart(lines, [
      // Free unit worth its bundle price ($10) — cheap for the store.
      builtIn("buy-1-get-1-free", { stackWithBundlePricing: true }),
      // Free unit worth full list ($100) on a smaller reward count.
      builtIn("buy-3-get-1-free"),
    ], { bundleStacking: false });
    // The second is worth more ($100 vs $20) and wins, which only works if the
    // two were valued differently within one selection.
    expect(chosen?.promotion.id).toBe(LEGACY_BUY_3_GET_1_ID);
    expect(chosen?.application.discountAmount).toBe(100);
  });

  it("answers null for an empty cart or an empty promotion list", () => {
    expect(selectPromotionForCart([], [builtIn("buy-1-get-1-free")])).toBeNull();
    expect(selectPromotionForCart(cart, [])).toBeNull();
    expect(nextOpportunityForCart([], [builtIn("buy-1-get-1-free")])).toBeNull();
  });

  it("nudges from the same lines it prices", () => {
    const lines = [{ slug: "b", listUnitPrice: 40, bundledUnitPrice: 40, quantity: 2 }];
    const next = nextOpportunityForCart(lines, [builtIn("buy-2-get-1-free")]);
    expect(next?.unitsAway).toBe(1);
  });

  it("skips an exhausted promotion here too", () => {
    const chosen = selectPromotionForCart(cart, [builtIn("buy-1-get-1-free"), builtIn("buy-3-get-1-free")], {
      exhaustedIds: ["buy-1-get-1-free"],
    });
    expect(chosen?.promotion.id).toBe(LEGACY_BUY_3_GET_1_ID);
  });
});
