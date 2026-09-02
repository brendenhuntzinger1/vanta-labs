import { describe, expect, it } from "vitest";
import {
  advertisableBxgyPromotions,
  isPromotionLive,
  liveBxgyPromotions,
  selectPromotionForCart,
  nextOpportunityForCart,
  type BxgyPromotion,
} from "@/lib/bxgy-engine";
import { normalizeBxgyPromotion, serializeBxgyPromotions, defaultBxgyPromotions } from "@/lib/bxgy-config";

// ---------------------------------------------------------------------------
// ACTIVE + PUBLIC  -> prices the order AND appears on the storefront
// ACTIVE + PRIVATE -> prices the order, appears nowhere public
// INACTIVE         -> neither
//
// The store owner switched every promotion off believing they were switching
// off a BANNER, and the discount went with it — because `enabled` was the only
// switch and it gated both. That is the bug this file pins.
//
// The rule that keeps it fixed: `hidden` is read by the code that DESCRIBES a
// promotion and never by the code that PRICES one. Filtering it out of the
// pricing list would be worse than the original bug — the cart previews from
// /api/catalog/promotions while the server charges from quote-order, so hiding
// it from one and not the other makes the totals disagree and the altered-total
// guard refuses the sale outright.
// ---------------------------------------------------------------------------

function promo(over: Partial<BxgyPromotion> = {}): BxgyPromotion {
  return {
    id: "b2g1",
    name: "Buy 2 Get 1 Free",
    enabled: true,
    hidden: false,
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
    priority: 50,
    ...over,
  };
}

/** Three eligible units — enough for Buy 2 Get 1 to pay out. */
const CART = [{ slug: "bpc-157", listUnitPrice: 69, bundledUnitPrice: 69, quantity: 3 }];

describe("the three states, at the engine", () => {
  it("ACTIVE + PUBLIC: prices the cart and may be advertised", () => {
    const p = promo({ enabled: true, hidden: false });
    expect(isPromotionLive(p), "runs").toBe(true);
    expect(advertisableBxgyPromotions([p]), "advertised").toEqual([p]);
    expect(selectPromotionForCart(CART, liveBxgyPromotions([p]))?.application.discountAmount).toBe(69);
  });

  it("ACTIVE + PRIVATE: prices the cart identically, and is advertised nowhere", () => {
    const p = promo({ enabled: true, hidden: true });
    expect(isPromotionLive(p), "still runs — hidden is not disabled").toBe(true);
    expect(advertisableBxgyPromotions([p]), "never advertised").toEqual([]);
    // THE LOAD-BEARING ASSERTION. Same basket, same money, whether or not the
    // storefront is allowed to mention it.
    expect(selectPromotionForCart(CART, liveBxgyPromotions([p]))?.application.discountAmount).toBe(69);
  });

  it("INACTIVE: prices nothing and is advertised nowhere", () => {
    const p = promo({ enabled: false, hidden: false });
    expect(isPromotionLive(p)).toBe(false);
    expect(liveBxgyPromotions([p]), "not in the pricing list").toEqual([]);
    expect(selectPromotionForCart(CART, liveBxgyPromotions([p]))).toBeNull();
  });

  it("INACTIVE + PRIVATE is still just inactive", () => {
    const p = promo({ enabled: false, hidden: true });
    expect(liveBxgyPromotions([p])).toEqual([]);
    expect(advertisableBxgyPromotions(liveBxgyPromotions([p]))).toEqual([]);
  });
});

describe("hidden filters the advertising surfaces only", () => {
  it("keeps a private promotion out of the cart's upsell teaser", () => {
    // "Add one more and the next is free" advertises a promotion the shopper
    // has NOT earned yet, so a private promotion must not appear in it.
    const oneUnit = [{ slug: "bpc-157", listUnitPrice: 69, bundledUnitPrice: 69, quantity: 1 }];
    const pub = promo({ enabled: true, hidden: false });
    const priv = promo({ enabled: true, hidden: true });
    expect(nextOpportunityForCart(oneUnit, advertisableBxgyPromotions([pub]))).not.toBeNull();
    expect(nextOpportunityForCart(oneUnit, advertisableBxgyPromotions([priv]))).toBeNull();
  });

  it("shows a public promotion alongside a private one, never the private one", () => {
    const pub = promo({ id: "pub", name: "Buy 2 Get 1 Free", hidden: false });
    const priv = promo({ id: "priv", name: "Buy 1 Get 1 Free", hidden: true, buyQuantity: 1, priority: 90 });
    expect(advertisableBxgyPromotions(liveBxgyPromotions([pub, priv])).map((p) => p.id)).toEqual(["pub"]);
  });

  it("still lets the private one win the money when it is worth more", () => {
    // Advertising and pricing genuinely diverge here, and that is correct: the
    // shopper is quoted the better discount and simply was not advertised it.
    const pub = promo({ id: "pub", buyQuantity: 2, priority: 50, hidden: false });
    const priv = promo({ id: "priv", buyQuantity: 1, priority: 90, hidden: true });
    const live = liveBxgyPromotions([pub, priv]);
    expect(advertisableBxgyPromotions(live).map((p) => p.id)).toEqual(["pub"]);
    expect(selectPromotionForCart(CART, live)?.promotion.id, "the better discount still applies").toBe("priv");
  });
});

describe("the flag survives storage, and an old store stays public", () => {
  it("round-trips through serialize -> normalize", () => {
    for (const hidden of [true, false]) {
      const [stored] = serializeBxgyPromotions([promo({ hidden })]);
      expect(stored.hidden).toBe(hidden);
      expect(normalizeBxgyPromotion(stored)?.hidden).toBe(hidden);
    }
  });

  it("reads a promotion stored BEFORE this field existed as public", () => {
    // Every promotion in the live store predates the field. Defaulting to
    // hidden would silently stop advertising promotions that are running.
    const legacy = serializeBxgyPromotions([promo()])[0];
    delete legacy.hidden;
    expect("hidden" in legacy).toBe(false);
    expect(normalizeBxgyPromotion(legacy)?.hidden, "absent means public").toBe(false);
  });

  it("treats a junk value as public rather than hiding a live promotion", () => {
    for (const junk of ["true", 1, {}, null]) {
      expect(normalizeBxgyPromotion({ id: "x", hidden: junk })?.hidden).toBe(false);
    }
  });

  it("ships every built-in promotion public, so switching one on advertises it", () => {
    // The owner's requirement: enabling a promotion must not need a second
    // setting found somewhere else before the banner picks it up.
    expect(defaultBxgyPromotions().every((p) => p.hidden === false)).toBe(true);
  });
});
