import { describe, expect, it } from "vitest";

import { resolveCartDiscount, type DiscountType } from "@/lib/discount-resolution";
import { resolveCustomerDiscount, type OrderInputs } from "@/lib/profit-engine";

// ---------------------------------------------------------------------------
// THE PRICE IN THE CART HAS TO BE THE PRICE ON THE CARD.
//
// Two functions decide which single discount wins:
//
//   cart-context.tsx  -> resolveCartDiscount     (what the shopper is shown)
//   quote-order.ts    -> resolveCustomerDiscount (what the card is charged)
//
// discount-resolution.ts opened by claiming it was "shared by the client cart
// preview and the server checkout total so both always agree". The server never
// called it, nothing tested the claim, and the two had drifted.
//
// THE DEFECT. The cart built a PRIORITY CHAIN — buy3get1 wins outright, failing
// that a valid referral, failing that the coupon — so exactly one of the three
// ever competed. The server is handed bundleDiscount and couponDiscount
// together and lets both into the candidate list. On a $300 cart with a $20
// free item and a $50 coupon the cart showed $20 off while the card was charged
// $50 off: the shopper paying less than the page said, and the "best discount
// applied" line naming the wrong one.
//
// THE FIX. The cart's candidate assembly was lifted out of the component into
// resolveCartDiscount, and the coupon competes on its own footing instead of
// behind the promo. Bundle-over-referral STAYS, because the server suppresses
// the referral bucket outright when a bundle is present.
//
// Why it had to move rather than just be corrected in place: the assembly lived
// inline in a React component, so nothing could import it, so nothing could
// test it — which is exactly how it drifted. The first version of this file
// restated that chain by hand and passed while the real cart was wrong. A
// mirrored copy cannot catch a change in the original. Both sides of the
// comparison below now run production code.
//
// Referral and coupon are still excluded from the same scenario on purpose:
// applying either clears the other in cart state (cart-context.tsx), so a
// combination the UI cannot produce would prove nothing.
// ---------------------------------------------------------------------------

const ALL = new Set(["coupon", "referral", "bundle", "membership"] as const);
const round = (v: number) => Math.round(v * 100) / 100;

interface Scenario {
  name: string;
  subtotal: number;
  /** Quantity-bundle pricing already baked into subtotal. */
  quantityBundleSavings?: number;
  buy3Get1?: number;
  referralPercent?: number;
  memberPercent?: number;
  couponDiscount?: number;
  bulkSavings?: number;
  personalDiscount?: number;
  allowCouponStacking?: boolean;
}

function serverAmount(s: Scenario): number {
  const fullSubtotal = s.subtotal + (s.quantityBundleSavings ?? 0);
  const inputs: OrderInputs = {
    subtotal: s.subtotal,
    fullSubtotal,
    quantityBundleSavings: s.quantityBundleSavings ?? 0,
    productCost: 0,
    bundleDiscount: s.buy3Get1 ?? 0,
    referralAccepted: Boolean(s.referralPercent),
    referralPercent: s.referralPercent ?? 0,
    isMember: Boolean(s.memberPercent),
    membershipPercent: s.memberPercent ?? 0,
    couponDiscount: s.couponDiscount ?? 0,
    bulkSavingsAmount: s.bulkSavings ?? 0,
    personalDiscountAmount: s.personalDiscount ?? 0,
    allowCouponStacking: s.allowCouponStacking ?? false,
    commissionPercent: 0,
    processingFeePercent: 0,
    shippingCollected: 0,
    shippingCost: 0,
    handlingCollected: 0,
    taxPercent: 0,
  };
  return resolveCustomerDiscount(inputs, ALL).amount;
}

/**
 * The REAL cart resolver. No longer a mirror: resolveCartDiscount is the exact
 * function cart-context.tsx calls, so a change to the cart's assembly changes
 * this test's result too. That is the whole point — the previous version of
 * this file restated the cart's chain by hand and therefore could not have
 * caught the divergence it was written to police.
 */
function cartAmount(s: Scenario): number {
  const promo: { type: DiscountType; amount: number } | null =
    (s.buy3Get1 ?? 0) > 0
      ? { type: "buy3get1", amount: s.buy3Get1 ?? 0 }
      : s.referralPercent
        ? { type: "referral", amount: (s.subtotal + (s.quantityBundleSavings ?? 0)) * (s.referralPercent / 100) }
        : null;

  return resolveCartDiscount({
    subtotal: s.subtotal,
    quantityBundleSavings: s.quantityBundleSavings ?? 0,
    bulkSavingsAmount: s.bulkSavings ?? 0,
    memberPricingAmount: s.memberPercent ? (s.subtotal + (s.quantityBundleSavings ?? 0)) * (s.memberPercent / 100) : 0,
    ambassadorPersonalAmount: s.personalDiscount ?? 0,
    couponDiscountAmount: s.couponDiscount ?? 0,
    allowCouponStacking: s.allowCouponStacking ?? false,
    promo,
  }).amount;
}

// ---------------------------------------------------------------------------
// AND THE SECOND THING BOTH SIDES HAVE TO AGREE ON: WHO WON.
//
// The amount is not the only shared answer. "Is the referral the discount
// actually coming off this basket" decides whether the shopper keeps her store
// credit and her points, and it is derived on BOTH sides — from
// `cartDiscount.best.type` in cart-context.tsx, and from
// `customerDiscount.components` in quote-order.ts. Two derivations of one fact,
// which is how the amount drifted in the first place.
//
// If they disagree the shopper is either refused outright ("Altered total
// detected", when the client deducts credit the server does not) or charged a
// figure no screen showed her (the express lane sends no expectedTotal, so
// nothing checks). Both were reached in review.
// ---------------------------------------------------------------------------

function serverReferralWon(s: Scenario): boolean {
  const fullSubtotal = s.subtotal + (s.quantityBundleSavings ?? 0);
  const resolved = resolveCustomerDiscount({
    subtotal: s.subtotal,
    fullSubtotal,
    quantityBundleSavings: s.quantityBundleSavings ?? 0,
    productCost: 0,
    bundleDiscount: s.buy3Get1 ?? 0,
    referralAccepted: Boolean(s.referralPercent),
    referralPercent: s.referralPercent ?? 0,
    isMember: Boolean(s.memberPercent),
    membershipPercent: s.memberPercent ?? 0,
    couponDiscount: s.couponDiscount ?? 0,
    bulkSavingsAmount: s.bulkSavings ?? 0,
    personalDiscountAmount: s.personalDiscount ?? 0,
    allowCouponStacking: s.allowCouponStacking ?? false,
    commissionPercent: 0,
    processingFeePercent: 0,
    shippingCollected: 0,
    shippingCost: 0,
    handlingCollected: 0,
    taxPercent: 0,
  }, ALL);
  // The exact expression quote-order.ts uses.
  return resolved.components.includes("referral") && resolved.amount > 0;
}

function cartReferralWon(s: Scenario): boolean {
  const promo: { type: DiscountType; amount: number } | null =
    (s.buy3Get1 ?? 0) > 0
      ? { type: "buy3get1", amount: s.buy3Get1 ?? 0 }
      : s.referralPercent
        ? { type: "referral", amount: (s.subtotal + (s.quantityBundleSavings ?? 0)) * (s.referralPercent / 100) }
        : null;
  const resolved = resolveCartDiscount({
    subtotal: s.subtotal,
    quantityBundleSavings: s.quantityBundleSavings ?? 0,
    bulkSavingsAmount: s.bulkSavings ?? 0,
    memberPricingAmount: s.memberPercent ? (s.subtotal + (s.quantityBundleSavings ?? 0)) * (s.memberPercent / 100) : 0,
    ambassadorPersonalAmount: s.personalDiscount ?? 0,
    couponDiscountAmount: s.couponDiscount ?? 0,
    promo,
  });
  // The exact expression cart-context.tsx uses.
  return resolved.best?.type === "referral" && resolved.amount > 0;
}

// Referral and coupon are mutually exclusive in cart state — applying either
// clears the other (cart-context.tsx:1059 and :1144) — so no scenario here
// carries both. A combination the UI cannot produce proves nothing.
const REACHABLE: Scenario[] = [
  { name: "nothing applied", subtotal: 120 },
  { name: "coupon alone", subtotal: 120, couponDiscount: 15 },
  { name: "referral alone", subtotal: 200, referralPercent: 20 },
  { name: "member alone", subtotal: 200, memberPercent: 10 },
  { name: "bulk alone", subtotal: 400, bulkSavings: 32 },
  { name: "ambassador personal alone", subtotal: 200, personalDiscount: 25 },
  { name: "member vs a bigger coupon", subtotal: 200, memberPercent: 10, couponDiscount: 45 },
  { name: "member vs a smaller coupon", subtotal: 200, memberPercent: 15, couponDiscount: 10 },
  { name: "member vs a bigger referral", subtotal: 200, memberPercent: 5, referralPercent: 20 },
  { name: "member vs a smaller referral", subtotal: 200, memberPercent: 20, referralPercent: 5 },
  { name: "bulk vs coupon, bulk wins", subtotal: 500, bulkSavings: 60, couponDiscount: 25 },
  { name: "bulk vs coupon, coupon wins", subtotal: 500, bulkSavings: 20, couponDiscount: 75 },
  { name: "personal vs member", subtotal: 300, personalDiscount: 40, memberPercent: 10 },
  { name: "bundle alone", subtotal: 300, buy3Get1: 25 },
  { name: "bundle vs a bigger member discount", subtotal: 300, buy3Get1: 20, memberPercent: 15 },
  { name: "bundle vs bulk", subtotal: 600, buy3Get1: 30, bulkSavings: 90 },
  { name: "bundle beats the referral it suppresses", subtotal: 300, buy3Get1: 60, referralPercent: 10 },
  { name: "quantity bundle already in the subtotal", subtotal: 270, quantityBundleSavings: 30, memberPercent: 10 },
  { name: "quantity bundle swallows a small coupon", subtotal: 270, quantityBundleSavings: 30, couponDiscount: 12 },
  { name: "quantity bundle beaten by a large coupon", subtotal: 270, quantityBundleSavings: 30, couponDiscount: 90 },
  { name: "a discount larger than the cart", subtotal: 40, couponDiscount: 500 },
  { name: "an empty cart", subtotal: 0, couponDiscount: 20 },
];

describe("what the shopper is shown is what the card is charged", () => {
  it.each(REACHABLE)("$name", (scenario) => {
    expect(cartAmount(scenario)).toBe(serverAmount(scenario));
  });

  it.each(REACHABLE)("$name — and both sides agree on whether the REFERRAL is what won", (scenario) => {
    expect(cartReferralWon(scenario)).toBe(serverReferralWon(scenario));
  });

  // Named cases, so a regression says which state broke rather than only that
  // one of twenty-two did.
  it("says the referral won when it is the only discount and it is real", () => {
    const s: Scenario = { name: "x", subtotal: 200, referralPercent: 20 };
    expect(serverReferralWon(s)).toBe(true);
    expect(cartReferralWon(s)).toBe(true);
  });

  it.each([
    ["a Buy-3-Get-1 bundle suppresses it outright", { name: "x", subtotal: 300, buy3Get1: 60, referralPercent: 10 } as Scenario],
    ["a bigger membership discount beats it", { name: "x", subtotal: 200, memberPercent: 20, referralPercent: 5 } as Scenario],
    ["quantity-bundle pricing competes it to exactly zero", { name: "x", subtotal: 190, quantityBundleSavings: 10, referralPercent: 5 } as Scenario],
    ["a commission-only ambassador gives 0%", { name: "x", subtotal: 200, referralPercent: 0 } as Scenario],
  ])("says the referral did NOT win when %s", (_label, s) => {
    expect(serverReferralWon(s)).toBe(false);
    expect(cartReferralWon(s)).toBe(false);
  });

  it("no discount ever exceeds the cart, on either side", () => {
    for (const scenario of REACHABLE) {
      expect(serverAmount(scenario)).toBeLessThanOrEqual(scenario.subtotal);
      expect(cartAmount(scenario)).toBeLessThanOrEqual(scenario.subtotal);
      expect(serverAmount(scenario)).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("the combination they used to disagree on", () => {
  /**
   * THE DEFECT, now the regression test. The cart put the coupon on the third
   * rung of a priority chain that a Buy-3-Get-1 bundle short-circuited, so the
   * coupon never competed; the server let both compete and took the larger. A
   * $300 cart with a $20 free item and a $50 coupon showed $20 off and charged
   * $50 off.
   */
  const BUNDLE_PLUS_BIGGER_COUPON: Scenario = { name: "x", subtotal: 300, buy3Get1: 20, couponDiscount: 50 };

  it("a bundle plus a larger coupon now shows what the card is charged", () => {
    expect(cartAmount(BUNDLE_PLUS_BIGGER_COUPON)).toBe(50);
    expect(serverAmount(BUNDLE_PLUS_BIGGER_COUPON)).toBe(50);
  });

  it("agrees at every coupon value either side of the free item", () => {
    for (const coupon of [1, 19.99, 20, 20.01, 50, 200, 500]) {
      const scenario: Scenario = { name: "x", subtotal: 300, buy3Get1: 20, couponDiscount: coupon };
      expect(cartAmount(scenario)).toBe(serverAmount(scenario));
    }
  });

  it("still lets the bundle win when the free item is worth more", () => {
    const scenario: Scenario = { name: "x", subtotal: 300, buy3Get1: 60, couponDiscount: 25 };
    expect(cartAmount(scenario)).toBe(60);
    expect(serverAmount(scenario)).toBe(60);
  });

  /**
   * A bundle must still suppress the REFERRAL, which the server does outright
   * via `!isBundle && hasReferral`. Only the coupon moved out of the chain.
   */
  it("a bundle still suppresses a referral", () => {
    const scenario: Scenario = { name: "x", subtotal: 300, buy3Get1: 60, referralPercent: 10 };
    expect(cartAmount(scenario)).toBe(60);
    expect(cartAmount(scenario)).toBe(serverAmount(scenario));
  });
});

describe("the admin coupon-stacking switch, which the cart could not see", () => {
  /**
   * THIS BLOCK USED TO RECORD A KNOWN, UNFIXED DIVERGENCE.
   *
   * It said: "With stacking ON the server deliberately adds the coupon on top
   * of the best promo. The cart has no equivalent branch, so this is a SECOND
   * known divergence — dormant behind the same switch." Dormant is not the same
   * as safe: the switch is one checkbox in the Control Center, and the day
   * anyone ticked it every cart in the store would have quoted a total higher
   * than the card was charged, with no test going red.
   *
   * The cart now has the branch, and takes the policy from the same place the
   * server does — `coupons.allow_stacking`, delivered through
   * /api/catalog/promotions. These assert the two agree in BOTH switch
   * positions rather than describing what only the server does.
   */
  it("stacks a coupon on the best promo when told to — on both sides", () => {
    const scenario: Scenario = { name: "x", subtotal: 300, memberPercent: 10, couponDiscount: 40, allowCouponStacking: true };
    expect(serverAmount(scenario)).toBe(70); // $30 membership + $40 coupon
    expect(cartAmount(scenario)).toBe(70);
  });

  it("and does not when told not to — on both sides", () => {
    const scenario: Scenario = { name: "x", subtotal: 300, memberPercent: 10, couponDiscount: 40 };
    expect(serverAmount(scenario)).toBe(40); // the larger of the two, alone
    expect(cartAmount(scenario)).toBe(40);
  });

  it("still never exceeds the cart when stacking, on either side", () => {
    const scenario: Scenario = { name: "x", subtotal: 50, memberPercent: 50, couponDiscount: 400, allowCouponStacking: true };
    expect(serverAmount(scenario)).toBe(50);
    expect(cartAmount(scenario)).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// BUY X GET Y AGAINST EVERY OTHER DISCOUNT, BOTH SWITCH POSITIONS.
//
// A Buy-X-Get-Y promotion reaches resolveCustomerDiscount as `bundleDiscount`
// and resolveCartDiscount as `promo.type === "buy3get1"` — the same two inputs
// Buy 3 Get 1 has always used — so these cover all six promotions at once.
// ---------------------------------------------------------------------------

describe("Buy X Get Y versus coupon, referral, membership and bulk savings", () => {
  const cases: Scenario[] = [
    // --- coupon + promotion, stacking OFF: they compete, larger wins --------
    { name: "promotion beats a smaller coupon", subtotal: 300, buy3Get1: 80, couponDiscount: 30 },
    { name: "coupon beats a smaller promotion", subtotal: 300, buy3Get1: 30, couponDiscount: 80 },
    { name: "coupon and promotion exactly equal", subtotal: 300, buy3Get1: 50, couponDiscount: 50 },

    // --- coupon + promotion, stacking ON: they add ------------------------
    { name: "coupon stacks on the promotion", subtotal: 300, buy3Get1: 80, couponDiscount: 30, allowCouponStacking: true },
    { name: "coupon stacks on a promotion that lost to bundle pricing", subtotal: 260, quantityBundleSavings: 40, buy3Get1: 30, couponDiscount: 25, allowCouponStacking: true },
    { name: "stacked pair capped at the subtotal", subtotal: 100, buy3Get1: 90, couponDiscount: 90, allowCouponStacking: true },

    // --- referral + promotion: the referral is suppressed outright ---------
    { name: "promotion suppresses the referral", subtotal: 400, buy3Get1: 60, referralPercent: 10 },
    { name: "promotion suppresses even a bigger referral", subtotal: 400, buy3Get1: 20, referralPercent: 15 },
    { name: "referral alone with no promotion", subtotal: 400, referralPercent: 10 },

    // --- membership + promotion -------------------------------------------
    { name: "membership beats a small promotion", subtotal: 400, buy3Get1: 20, memberPercent: 15 },
    { name: "promotion beats membership", subtotal: 400, buy3Get1: 90, memberPercent: 10 },
    { name: "membership, promotion and coupon together, stacking on", subtotal: 400, buy3Get1: 50, memberPercent: 15, couponDiscount: 20, allowCouponStacking: true },

    // --- bulk savings and the ambassador personal discount -----------------
    { name: "bulk savings beats the promotion", subtotal: 900, buy3Get1: 60, bulkSavings: 108 },
    { name: "promotion beats bulk savings", subtotal: 900, buy3Get1: 200, bulkSavings: 108 },
    { name: "ambassador personal discount versus a promotion", subtotal: 300, buy3Get1: 40, personalDiscount: 45 },

    // --- with quantity-bundle pricing already in the subtotal --------------
    { name: "promotion competed to nothing by bundle pricing", subtotal: 260, quantityBundleSavings: 40, buy3Get1: 35 },
    { name: "promotion just beats bundle pricing", subtotal: 260, quantityBundleSavings: 40, buy3Get1: 55 },
    { name: "everything at once, stacking off", subtotal: 500, quantityBundleSavings: 60, buy3Get1: 90, memberPercent: 10, couponDiscount: 70, bulkSavings: 50 },
    { name: "everything at once, stacking on", subtotal: 500, quantityBundleSavings: 60, buy3Get1: 90, memberPercent: 10, couponDiscount: 70, bulkSavings: 50, allowCouponStacking: true },
  ];

  it.each(cases)("$name — cart and checkout charge the same", (scenario) => {
    expect(cartAmount(scenario)).toBe(serverAmount(scenario));
  });

  it.each(cases)("$name — cart and checkout agree on whether the referral won", (scenario) => {
    expect(cartReferralWon(scenario)).toBe(serverReferralWon(scenario));
  });
});

// ---------------------------------------------------------------------------
// AN EXACT TIE MUST RESOLVE THE SAME WAY ON BOTH SIDES.
//
// Same amount, different winner is not harmless: whether the REFERRAL won
// decides whether store credit and points may be spent (store-credit-
// redemption.ts zeroes both when a referral is applied). With a 10% referral
// code and a 10% member tier — production's default program percent and its
// Core/Elite tiers — the cart said "membership" and let the credit through,
// the server said "referral" and refused it, and the posted total no longer
// matched: "Altered total detected", rewritten to "refresh this page", on
// every attempt. The candidate order is the tie-break, so it is pinned here.
// ---------------------------------------------------------------------------
describe("an exact tie between two discounts", () => {
  const TIES: Scenario[] = [
    { name: "referral 10% vs membership 10%", subtotal: 138, referralPercent: 10, memberPercent: 10 },
    { name: "referral vs membership vs equal bulk savings", subtotal: 200, referralPercent: 10, memberPercent: 10, bulkSavings: 20 },
    { name: "membership vs equal bulk savings", subtotal: 200, memberPercent: 10, bulkSavings: 20 },
    { name: "membership vs equal personal discount", subtotal: 200, memberPercent: 10, personalDiscount: 20 },
    { name: "referral vs equal coupon", subtotal: 200, referralPercent: 10, couponDiscount: 20 },
    { name: "bundle vs equal referral", subtotal: 300, buy3Get1: 30, referralPercent: 10 },
  ];

  it.each(TIES)("$name — same amount", (s) => {
    expect(cartAmount(s)).toBe(serverAmount(s));
  });

  it.each(TIES)("$name — same answer to 'did the referral win'", (s) => {
    expect(cartReferralWon(s)).toBe(serverReferralWon(s));
  });
});

// ---------------------------------------------------------------------------
// AND THE THIRD THING BOTH SIDES HAVE TO AGREE ON: WHETHER SHIPPING IS FREE.
//
// PRICE-02. Shipping is not in the discount race at all — it has its own
// expression, and that expression existed in THREE places: quote-order.ts
// (what the card is charged), cart-context.tsx (the drawer and /cart) and
// checkout/page.tsx. The server's knew about a coupon flagged `free_shipping`;
// the two client copies did not, so a shopper below the free-shipping threshold
// who applied a free-shipping code saw $15 of shipping still in the total and,
// for a shipping-only code, was told it "doesn't lower the total" while the
// server charged $0 for it. All three now call isShippingWaived (shipping.ts).
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { calculateShipping, DEFAULT_SHIPPING_CONFIG, isShippingWaived } from "@/lib/shipping";
import { describeCouponOutcome } from "@/lib/discount-resolution";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

describe("a free-shipping coupon zeroes shipping on both sides", () => {
  const grants = [
    { name: "nothing waives it", bulkSavingsTier: false, memberFreeShipping: false, couponFreeShipping: false, expected: false },
    { name: "a free-shipping coupon alone", bulkSavingsTier: false, memberFreeShipping: false, couponFreeShipping: true, expected: true },
    { name: "a bulk tier alone", bulkSavingsTier: true, memberFreeShipping: false, couponFreeShipping: false, expected: true },
    { name: "a membership perk alone", bulkSavingsTier: false, memberFreeShipping: true, couponFreeShipping: false, expected: true },
    { name: "a coupon on top of a perk that already ships free", bulkSavingsTier: false, memberFreeShipping: true, couponFreeShipping: true, expected: true },
  ];

  it.each(grants)("$name", ({ expected, ...waivers }) => {
    expect(isShippingWaived(waivers)).toBe(expected);
  });

  it("a $120 domestic basket with a free-shipping code ships for $0, not the $15 the client used to show", () => {
    const subtotal = 120;
    const listTerms = calculateShipping(subtotal, undefined, DEFAULT_SHIPPING_CONFIG);
    expect(listTerms).toBe(DEFAULT_SHIPPING_CONFIG.domesticFee);
    const shown = isShippingWaived({ bulkSavingsTier: false, memberFreeShipping: false, couponFreeShipping: true }) ? 0 : listTerms;
    expect(shown).toBe(0);
  });

  it("with no waiver the fee is untouched — the code changes nothing else about pricing", () => {
    const listTerms = calculateShipping(120, undefined, DEFAULT_SHIPPING_CONFIG);
    const shown = isShippingWaived({ bulkSavingsTier: false, memberFreeShipping: false, couponFreeShipping: false }) ? 0 : listTerms;
    expect(shown).toBe(listTerms);
  });

  // The helper only proves parity if BOTH sides actually call it. These pin
  // the wiring, the same way the discount half of this file pins that
  // cart-context calls resolveCartDiscount rather than restating it.
  it("the server, the cart and the checkout all decide the waiver through isShippingWaived", () => {
    const server = read("src/lib/quote-order.ts");
    const cart = read("src/components/cart-context.tsx");
    const checkout = read("src/app/checkout/page.tsx");
    for (const [name, src] of [["quote-order", server], ["cart-context", cart], ["checkout", checkout]] as const) {
      expect(src, `${name} should call isShippingWaived`).toContain("isShippingWaived({");
      expect(src, `${name} should feed the coupon's waiver in`).toMatch(/isShippingWaived\(\{[^}]*couponFreeShipping/);
    }
    // The old hand-rolled client expressions are gone.
    expect(cart).not.toContain("(bulkSavingsTierReached || memberFreeShipping) ? 0 : calculateShipping(");
    expect(checkout).not.toContain("(bulkSavingsTierReached || memberFreeShipping) ? 0 : calculateShipping(");
  });

  it("the drawer's shipping row reads 'Free', not 'Calculated at payment', when the coupon waived it", () => {
    // cartShippingLineLabel only says "Free" for a zero something decided; a
    // coupon-waived zero used to fall through to the not-priced-yet placeholder.
    const drawer = read("src/components/cart-drawer.tsx");
    const call = drawer.slice(drawer.indexOf("cartShippingLineLabel({"), drawer.indexOf("format: formatCartCurrency"));
    expect(call).toContain("Boolean(couponDetails?.freeShipping)");
    expect(call).toContain("memberFreeShipping");
    expect(call).toContain("bulkSavingsTierReached");
  });

  it("the validate route tells the client about the waiver, and the client carries it", () => {
    const route = read("src/app/api/coupons/validate/route.ts");
    expect(route).toContain("freeShipping: coupon.freeShipping");
    const cart = read("src/components/cart-context.tsx");
    expect(cart).toContain("freeShipping: result.freeShipping === true");
  });

  it("a shipping-only code is described as in the price, not as doing nothing", () => {
    const outcome = describeCouponOutcome({
      code: "SHIPFREE",
      offerLabel: null,
      winnerType: null,
      winnerLabel: null,
      waivesShipping: true,
    });
    expect(outcome.controlsPrice).toBe(true);
    expect(outcome.message).toContain("Free shipping");
    expect(outcome.message).not.toContain("doesn't lower the total");
  });
});
