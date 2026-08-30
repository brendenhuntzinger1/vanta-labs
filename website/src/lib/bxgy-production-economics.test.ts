import { describe, expect, it } from "vitest";
import {
  DEFAULT_BUNDLE_CONFIG,
  getBundleDiscountedUnitPrice,
  roundMoney,
} from "@/lib/bundle-pricing";
import { selectPromotionForCart, type BxgyCartLine, type BxgyPromotion } from "@/lib/bxgy-engine";
import { defaultBxgyPromotions } from "@/lib/bxgy-config";
import { computeProfit, meetsFloor, resolveCustomerDiscount } from "@/lib/profit-engine";
import { calculateShipping } from "@/lib/shipping";

// ---------------------------------------------------------------------------
// WILL THESE PROMOTIONS SELL BELOW COST ON THE REAL CATALOGUE?
//
// The profit guard (quote-order.ts) refuses any order whose gross profit falls
// under the floor with "Promotion unavailable on this order." That is correct
// behaviour and nothing here weakens it. The question these tests answer is a
// different one: on the STORE'S ACTUAL PRICES AND COSTS, which promotions can a
// shopper build a losing basket out of, and which SKUs are the ones that do it.
//
// PROVENANCE OF THE NUMBERS. Every price and cost below is production, read
// read-only from `products` / `product_doses` on 2026-08-30, restricted to
// published products and their DEFAULT dose — which is what a shopper adds from
// a catalogue card, and which is the cost the guard prices against (it prefers
// the chosen dose's cost and refuses the stale parent figure on any slug that
// has doses). Catalogue prices are public; unit costs are the owner's and stay
// in this repo. Nothing here reads or writes production at run time.
//
// SETTINGS ARE PRODUCTION'S TOO, read from admin_control_current the same day:
//   profit.min_profit_percent      blank -> 0      (floor is break-even)
//   profit.min_profit_dollars      blank -> 0
//   profit.processing_fee_percent  blank -> 8%
//   profit.shipping_cost_estimate  blank -> $6/order
//   promotions.bundle_stacking     false           (promo competes with bundle)
//   promotions.bundle_*_percent    blank -> 5/8/12/20
//   coupons.allow_stacking         false
//   sales_tax                      no rows -> no nexus -> 0% tax
//   shipping                       $15 flat, free over $200
// ---------------------------------------------------------------------------

interface Sku {
  slug: string;
  /** List price of the default dose, dollars. */
  price: number;
  /** The default dose's own cost, dollars — what the guard charges COGS at. */
  cost: number;
}

/** Published products, default dose. Production, 2026-08-30. */
const CATALOGUE: Sku[] = [
  { slug: "bacteriostatic-water", price: 14.99, cost: 1.43 },
  { slug: "bpc-157", price: 39.99, cost: 4.84 },
  { slug: "ghrp-2", price: 39.99, cost: 4.84 },
  { slug: "mt-2-melanotan-ii", price: 39.99, cost: 5.30 },
  { slug: "ghk-cu", price: 39.99, cost: 3.65 },
  { slug: "epithalon", price: 44.99, cost: 5.49 },
  { slug: "glp-1", price: 44.99, cost: 3.83 },
  { slug: "glp-2", price: 49.99, cost: 4.38 },
  { slug: "snap-8", price: 49.99, cost: 4.84 },
  { slug: "b12", price: 49.99, cost: 5.95 },
  { slug: "glp-3", price: 49.99, cost: 6.32 },
  { slug: "mots-c", price: 49.99, cost: 7.68 },
  { slug: "selank", price: 49.99, cost: 6.78 },
  { slug: "ghrp-6", price: 49.99, cost: 5.21 },
  { slug: "semax", price: 49.99, cost: 5.86 },
  { slug: "pt-141", price: 49.99, cost: 7.40 },
  { slug: "kpv", price: 54.99, cost: 6.22 },
  { slug: "l-carnitine", price: 59.99, cost: 6.68 },
  { slug: "dsip", price: 59.99, cost: 9.26 },
  { slug: "glutathione", price: 59.99, cost: 8.80 },
  { slug: "thymosin-alpha-1", price: 60.00, cost: 10.10 },
  { slug: "lipo-c", price: 64.99, cost: 13.08 },
  { slug: "ss-31", price: 64.99, cost: 8.98 },
  { slug: "nad", price: 64.99, cost: 6.96 },
  { slug: "hgh-gh-191", price: 64.99, cost: 12.00 },
  { slug: "hcg", price: 69.99, cost: 8.98 },
  { slug: "cjc-1295-no-dac", price: 69.99, cost: 13.45 },
  { slug: "cjc-1295-ipamorelin", price: 69.99, cost: 11.12 },
  { slug: "pinealon", price: 72.99, cost: 35.00 },
  { slug: "kisspeptin", price: 74.99, cost: 8.98 },
  { slug: "tesamorelin", price: 74.99, cost: 20.33 },
  { slug: "cerebrolysin", price: 74.99, cost: 35.00 },
  { slug: "cagrilintide", price: 79.99, cost: 21.82 },
  { slug: "5-amino-1mq", price: 79.99, cost: 10.66 },
  { slug: "bpc-157-tb-500", price: 104.99, cost: 18.66 },
  { slug: "glow", price: 109.99, cost: 21.54 },
  { slug: "klow", price: 119.99, cost: 25.07 },
  { slug: "igf-1-lr3", price: 119.99, cost: 23.96 },
];

const BY_SLUG = new Map(CATALOGUE.map((sku) => [sku.slug, sku]));
function sku(slug: string): Sku {
  const found = BY_SLUG.get(slug);
  if (!found) throw new Error(`unknown production slug ${slug}`);
  return found;
}

/** Production profit settings, as getProfitSettings resolves them today. */
const PROD_PROFIT = {
  minProfitPercent: 0,
  minProfitDollars: 0,
  // Unused by these baskets — every published SKU has a real per-dose cost —
  // but part of the settings object, and production leaves it at the default.
  worstCaseUnitCost: 33,
  processingFeePercent: 8,
  processingFeeIncludesTax: true,
  shippingCostPerOrder: 6,
};

/** Production shipping config: $15 flat, free over $200. */
const PROD_SHIPPING = {
  domesticFee: 15,
  freeShippingThreshold: 200,
  northAmericaFee: 25,
  northAmericaFreeShippingThreshold: 400,
  internationalFee: 60,
  internationalFreeShippingThreshold: 600,
  handlingFeeRate: 0,
};

interface BasketLine { slug: string; quantity: number }

interface Outcome {
  promotionId: string;
  subtotal: number;
  discount: number;
  charged: number;
  cogs: number;
  grossProfit: number;
  /** True when quote-order would throw "Promotion unavailable on this order." */
  refused: boolean;
}

/**
 * Price a basket exactly as quoteOrder does, and run the same profit floor.
 *
 * Deliberately assembled from the SAME functions the checkout calls —
 * bundle-pricing, selectPromotionForCart, resolveCustomerDiscount,
 * computeProfit, meetsFloor — rather than restating any of their arithmetic. If
 * one of them changes, this moves with it.
 */
function priceBasket(lines: BasketLine[], promotions: BxgyPromotion[]): Outcome {
  const priced = lines.map((line) => {
    const item = sku(line.slug);
    return {
      slug: line.slug,
      quantity: line.quantity,
      listUnitPrice: item.price,
      bundledUnitPrice: getBundleDiscountedUnitPrice(item.price, line.quantity, DEFAULT_BUNDLE_CONFIG),
      cost: item.cost,
    };
  });

  const subtotal = roundMoney(priced.reduce((sum, l) => sum + l.bundledUnitPrice * l.quantity, 0));
  const fullSubtotal = roundMoney(priced.reduce((sum, l) => sum + l.listUnitPrice * l.quantity, 0));
  // bundle_stacking is false in production.
  const quantityBundleSavings = roundMoney(Math.max(0, fullSubtotal - subtotal));

  const cartLines: BxgyCartLine[] = priced.map((l) => ({
    slug: l.slug,
    listUnitPrice: l.listUnitPrice,
    bundledUnitPrice: l.bundledUnitPrice,
    quantity: l.quantity,
  }));
  const selected = selectPromotionForCart(cartLines, promotions, { bundleStacking: false });
  const promotionDiscount = selected?.application.discountAmount ?? 0;

  const discount = resolveCustomerDiscount(
    {
      subtotal,
      fullSubtotal,
      quantityBundleSavings,
      productCost: 0,
      bundleDiscount: promotionDiscount,
      referralAccepted: false,
      referralPercent: 0,
      isMember: false,
      membershipPercent: 0,
      couponDiscount: 0,
      allowCouponStacking: false,
      commissionPercent: 0,
      processingFeePercent: 0,
      shippingCollected: 0,
      shippingCost: 0,
      handlingCollected: 0,
      taxPercent: 0,
    },
    new Set(["coupon", "referral", "bundle", "membership"]),
  );

  const shipping = roundMoney(calculateShipping(subtotal, "US", PROD_SHIPPING));
  const cogs = roundMoney(priced.reduce((sum, l) => sum + l.cost * l.quantity, 0));

  const profit = computeProfit(
    {
      subtotal,
      productCost: cogs,
      bundleDiscount: 0,
      referralAccepted: false,
      referralPercent: 0,
      isMember: false,
      membershipPercent: 0,
      couponDiscount: 0,
      allowCouponStacking: false,
      commissionPercent: 0,
      processingFeePercent: PROD_PROFIT.processingFeePercent,
      processingFeeIncludesTax: PROD_PROFIT.processingFeeIncludesTax,
      shippingCollected: shipping,
      shippingCost: PROD_PROFIT.shippingCostPerOrder,
      handlingCollected: 0,
      taxPercent: 0, // no nexus states configured
    },
    { amount: discount.amount, components: [], label: "resolved" },
  );

  return {
    promotionId: selected?.promotion.id ?? "(none)",
    subtotal,
    discount: discount.amount,
    charged: roundMoney(subtotal - discount.amount + shipping),
    cogs,
    grossProfit: profit.grossProfit,
    refused: !meetsFloor(profit, PROD_PROFIT),
  };
}

function promo(id: string, overrides: Partial<BxgyPromotion> = {}): BxgyPromotion {
  const found = defaultBxgyPromotions().find((p) => p.id === id);
  if (!found) throw new Error(`no built-in ${id}`);
  return { ...found, enabled: true, ...overrides };
}

const ALL_IDS = [
  "buy-1-get-1-free",
  "buy-2-get-1-free",
  "buy-3-get-2-free",
  "buy-3-get-1-free",
  "buy-1-get-1-half-off",
  "buy-2-get-1-half-off",
] as const;

/** Cost as a share of price — the number that decides whether a promotion can lose money. */
function costRatio(slug: string): number {
  const item = sku(slug);
  return item.cost / item.price;
}

// ---------------------------------------------------------------------------

describe("the production catalogue's cost structure", () => {
  it("has two SKUs whose cost is nearly half their price — the whole risk", () => {
    const worst = [...CATALOGUE].sort((a, b) => (b.cost / b.price) - (a.cost / a.price)).slice(0, 3);
    expect(worst.map((s) => s.slug)).toEqual(["pinealon", "cerebrolysin", "cagrilintide"]);
    expect(costRatio("pinealon")).toBeGreaterThan(0.47);
    expect(costRatio("cerebrolysin")).toBeGreaterThan(0.46);
    // Everything else sits at or below ~27%.
    expect(costRatio("cagrilintide")).toBeLessThan(0.28);
  });

  it("is otherwise a high-margin catalogue: the median SKU costs under 15% of its price", () => {
    const ratios = CATALOGUE.map((s) => s.cost / s.price).sort((a, b) => a - b);
    const median = ratios[Math.floor(ratios.length / 2)];
    expect(median).toBeLessThan(0.15);
  });
});

describe("50%-off promotions never sell below cost on this catalogue", () => {
  // A 50%-off reward removes at most half of one unit in X+Y, so the deepest it
  // can cut is 1/(2*(X+Y)) of the basket — 25% for Buy 1 Get 1 50% Off, 16.7%
  // for Buy 2 Get 1 50% Off. Both sit well above the worst cost ratio.
  for (const id of ["buy-1-get-1-half-off", "buy-2-get-1-half-off"] as const) {
    it(`${id} clears the floor on every published SKU, 2-12 units`, () => {
      const failures: string[] = [];
      for (const item of CATALOGUE) {
        for (const quantity of [2, 3, 4, 6, 8, 10, 12]) {
          const outcome = priceBasket([{ slug: item.slug, quantity }], [promo(id)]);
          if (outcome.refused) failures.push(`${item.slug} x${quantity} (profit ${outcome.grossProfit})`);
        }
      }
      expect(failures).toEqual([]);
    });
  }
});

describe("Buy 3 Get 1 Free — the store's existing promotion — is safe as it stands", () => {
  it("clears the floor on every published SKU, 4-12 units", () => {
    const failures: string[] = [];
    for (const item of CATALOGUE) {
      for (const quantity of [4, 5, 8, 10, 12]) {
        const outcome = priceBasket([{ slug: item.slug, quantity }], [promo("buy-3-get-1-free")]);
        if (outcome.refused) failures.push(`${item.slug} x${quantity} (profit ${outcome.grossProfit})`);
      }
    }
    expect(failures).toEqual([]);
  });
});

describe("Buy 2 Get 1 Free clears the floor everywhere", () => {
  it("is safe on every published SKU, 3-12 units", () => {
    const failures: string[] = [];
    for (const item of CATALOGUE) {
      for (const quantity of [3, 4, 6, 9, 12]) {
        const outcome = priceBasket([{ slug: item.slug, quantity }], [promo("buy-2-get-1-free")]);
        if (outcome.refused) failures.push(`${item.slug} x${quantity} (profit ${outcome.grossProfit})`);
      }
    }
    expect(failures).toEqual([]);
  });
});

describe("THE TWO PROMOTIONS THAT CAN LOSE MONEY, AND EXACTLY WHERE", () => {
  // Buy 1 Get 1 Free gives away 50% of the units and Buy 3 Get 2 Free gives
  // away 40%. Against a SKU costing ~47% of its price, that is a loss — not a
  // bug in the promotion, an arithmetic fact about the price of that SKU.
  it("Buy 1 Get 1 Free is refused on pinealon and cerebrolysin", () => {
    const refused: string[] = [];
    for (const item of CATALOGUE) {
      for (const quantity of [2, 4, 6, 8, 10]) {
        const outcome = priceBasket([{ slug: item.slug, quantity }], [promo("buy-1-get-1-free")]);
        if (outcome.refused && !refused.includes(item.slug)) refused.push(item.slug);
      }
    }
    expect(refused.sort()).toEqual(["cerebrolysin", "pinealon"]);
  });

  it("names the smallest losing basket for each", () => {
    // Four cerebrolysin: $299.96 list, 8% bundle -> $275.96 charged before the
    // promotion; two units free at list is $149.98, competed to $125.98 against
    // the $24.00 the bundle already gave. $149.98 is charged against $140.00 of
    // goods, $12.00 of card fees and $6.00 of shipping cost.
    const cerebrolysin = priceBasket([{ slug: "cerebrolysin", quantity: 4 }], [promo("buy-1-get-1-free")]);
    expect(cerebrolysin.refused).toBe(true);
    expect(cerebrolysin.grossProfit).toBeLessThan(0);

    const pinealon = priceBasket([{ slug: "pinealon", quantity: 4 }], [promo("buy-1-get-1-free")]);
    expect(pinealon.refused).toBe(true);
    expect(pinealon.grossProfit).toBeLessThan(0);
  });

  it("Buy 3 Get 2 Free stays above the floor even on those two SKUs — thinly", () => {
    // Worth checking rather than assuming: Buy 3 Get 2 gives away 40% of the
    // UNITS, which sounds worse than BOGO's 50%, but it is competed against the
    // 12% quantity-bundle tier a five-unit basket has already earned, so the
    // shopper pays 60% of list rather than BOGO's 50%. On a SKU costing 47%
    // that is the difference between a small profit and a loss.
    const refused: string[] = [];
    for (const item of CATALOGUE) {
      for (const quantity of [5, 10, 15]) {
        const outcome = priceBasket([{ slug: item.slug, quantity }], [promo("buy-3-get-2-free")]);
        if (outcome.refused && !refused.includes(item.slug)) refused.push(item.slug);
      }
    }
    expect(refused).toEqual([]);

    // Thin is the right word, and the margin is recorded so a future price or
    // cost change that crosses zero shows up here as a failure rather than as a
    // refused order in production.
    const cerebrolysin = priceBasket([{ slug: "cerebrolysin", quantity: 5 }], [promo("buy-3-get-2-free")]);
    expect(cerebrolysin.refused).toBe(false);
    expect(cerebrolysin.grossProfit).toBeGreaterThan(0);
    expect(cerebrolysin.grossProfit).toBeCloseTo(25.97, 2); // on a $224.99 order
  });

  it("EXCLUDING those two SKUs makes every promotion safe across the catalogue", () => {
    // This is the remedy, and it is a configuration rather than a code change:
    // the promotion centre's "Excluded products" field is exactly for this.
    const exclusion = { includeSlugs: [], excludeSlugs: ["pinealon", "cerebrolysin"] };
    const failures: string[] = [];
    for (const id of ALL_IDS) {
      for (const item of CATALOGUE) {
        for (const quantity of [2, 4, 5, 6, 8, 10, 12]) {
          const outcome = priceBasket([{ slug: item.slug, quantity }], [promo(id, { eligibility: exclusion })]);
          if (outcome.refused) failures.push(`${id}: ${item.slug} x${quantity} (profit ${outcome.grossProfit})`);
        }
      }
    }
    expect(failures).toEqual([]);
  });
});

describe("mixed-price baskets", () => {
  it("cheapest-first allocation protects margin on a mixed basket", () => {
    // The expensive unit is never the free one, so a basket mixing a
    // high-cost-ratio SKU with cheap ones stays profitable.
    const outcome = priceBasket(
      [{ slug: "cerebrolysin", quantity: 2 }, { slug: "ghk-cu", quantity: 2 }],
      [promo("buy-1-get-1-free")],
    );
    expect(outcome.refused).toBe(false);
    expect(outcome.grossProfit).toBeGreaterThan(0);
  });

  it("a cheap-SKU basket is comfortably profitable even at BOGO", () => {
    const outcome = priceBasket([{ slug: "ghk-cu", quantity: 8 }], [promo("buy-1-get-1-free")]);
    expect(outcome.refused).toBe(false);
    // $39.99 against $3.65 of goods: half the basket free still clears easily.
    expect(outcome.grossProfit).toBeGreaterThan(50);
  });

  it("an expensive-but-healthy SKU is fine at every promotion", () => {
    for (const id of ALL_IDS) {
      const outcome = priceBasket([{ slug: "igf-1-lr3", quantity: 6 }], [promo(id)]);
      expect(outcome.refused, `${id} on igf-1-lr3 x6`).toBe(false);
    }
  });

  it("a whole-catalogue basket, one of everything, is safe on every promotion", () => {
    const basket = CATALOGUE.map((item) => ({ slug: item.slug, quantity: 1 }));
    for (const id of ALL_IDS) {
      const outcome = priceBasket(basket, [promo(id)]);
      expect(outcome.refused, `${id} on a one-of-everything basket`).toBe(false);
    }
  });
});

describe("the guard is never weakened to let a promotion through", () => {
  it("a below-cost basket is refused, not silently repriced", () => {
    const outcome = priceBasket([{ slug: "cerebrolysin", quantity: 4 }], [promo("buy-1-get-1-free")]);
    // The promotion IS applied by the engine — the guard is what stops the
    // order. Nothing in this change lowers the floor or trims the discount to
    // sneak under it.
    expect(outcome.promotionId).toBe("buy-1-get-1-free");
    expect(outcome.discount).toBeGreaterThan(0);
    expect(outcome.refused).toBe(true);
  });

  it("the floor is production's own: break-even, at 8% fees and $6 shipping cost", () => {
    expect(PROD_PROFIT.minProfitDollars).toBe(0);
    expect(PROD_PROFIT.minProfitPercent).toBe(0);
    expect(PROD_PROFIT.processingFeePercent).toBe(8);
    expect(PROD_PROFIT.shippingCostPerOrder).toBe(6);
  });
});
