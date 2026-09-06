import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  calculateShipping,
  DEFAULT_SHIPPING_CONFIG,
  isFreeShippingSitewide,
  isShippingWaived,
  type ShippingConfig,
} from "@/lib/shipping";
import { calculateShippingProtectionFee, SHIPPING_PROTECTION_PERCENT } from "@/lib/shipping-protection";
import { getShippingProgress } from "@/components/cart-context";

// ---------------------------------------------------------------------------
// FREE SHIPPING SITEWIDE — the Control Center switch that makes shipping $0 on
// every order, with no code and no threshold.
//
// It lives on ShippingConfig and is honoured inside calculateShipping(), which
// is the ONE formula the cart preview, the checkout preview and the
// authoritative server total (quote-order.ts) all call with the same config
// object. Pinning it here therefore pins every surface at once: what the
// shopper is shown, what the card is authorized for, what is written to
// orders.shipping_amount, and what the confirmation email and the admin order
// page read back out of that column.
//
// The two things it must NOT touch are asserted just as hard as the thing it
// must: Shipping Protection keeps charging, and the coupon / membership / bulk
// waivers keep their own meaning.
// ---------------------------------------------------------------------------

const ON: ShippingConfig = { ...DEFAULT_SHIPPING_CONFIG, freeShippingSitewide: true };
const OFF: ShippingConfig = { ...DEFAULT_SHIPPING_CONFIG, freeShippingSitewide: false };

describe("free shipping sitewide — OFF (today's behaviour, unchanged)", () => {
  it("is off by default, so nothing changes until an admin turns it on", () => {
    expect(DEFAULT_SHIPPING_CONFIG.freeShippingSitewide).toBe(false);
    expect(isFreeShippingSitewide(DEFAULT_SHIPPING_CONFIG)).toBe(false);
  });

  it("keeps the domestic threshold exactly as it is", () => {
    expect(calculateShipping(199.99, "United States", OFF)).toBe(OFF.domesticFee);
    expect(calculateShipping(200, "United States", OFF)).toBe(0);
  });

  it("keeps the Canada threshold exactly as it is", () => {
    expect(calculateShipping(399.99, "Canada", OFF)).toBe(OFF.northAmericaFee);
    expect(calculateShipping(400, "Canada", OFF)).toBe(0);
  });

  it("keeps the progress bar counting up to the threshold", () => {
    const progress = getShippingProgress(150, OFF.freeShippingThreshold, false);
    expect(progress.isEligibleForFreeShipping).toBe(false);
    expect(progress.amountToFreeShipping).toBeCloseTo(50, 2);
    expect(progress.progressPercentage).toBeCloseTo(75, 2);
  });

  it("a missing flag reads as off, so an older stored config cannot switch it on", () => {
    const legacy = { ...DEFAULT_SHIPPING_CONFIG };
    delete (legacy as Partial<ShippingConfig>).freeShippingSitewide;
    expect(isFreeShippingSitewide(legacy)).toBe(false);
    expect(calculateShipping(50, "United States", legacy)).toBe(legacy.domesticFee);
  });
});

describe("free shipping sitewide — ON", () => {
  it("charges $0 regardless of subtotal, in every shippable zone", () => {
    expect(calculateShipping(1, "United States", ON)).toBe(0);
    expect(calculateShipping(39.99, "United States", ON)).toBe(0);
    expect(calculateShipping(199.99, "United States", ON)).toBe(0);
    expect(calculateShipping(1, "Canada", ON)).toBe(0);
    expect(calculateShipping(399.99, "Canada", ON)).toBe(0);
  });

  it("charges $0 with no country known yet — the cart preview before checkout", () => {
    expect(calculateShipping(49, undefined, ON)).toBe(0);
    expect(calculateShipping(49, null, ON)).toBe(0);
  });

  it("still charges nothing on an empty basket (no negative or phantom line)", () => {
    expect(calculateShipping(0, "United States", ON)).toBe(0);
  });

  it("overrides an admin threshold and an admin flat rate alike", () => {
    const custom: ShippingConfig = {
      ...ON,
      freeShippingThreshold: 1000,
      domesticFee: 45,
      northAmericaFreeShippingThreshold: 2000,
      northAmericaFee: 99,
    };
    expect(calculateShipping(10, "United States", custom)).toBe(0);
    expect(calculateShipping(10, "Canada", custom)).toBe(0);
  });

  it("shows the progress bar as unlocked instead of asking for a bigger basket", () => {
    const progress = getShippingProgress(1, ON.freeShippingThreshold, true);
    expect(progress.isEligibleForFreeShipping).toBe(true);
    expect(progress.amountToFreeShipping).toBe(0);
    expect(progress.progressPercentage).toBe(100);
  });
});

describe("free shipping sitewide — what it must NOT touch", () => {
  it("does not make Shipping Protection free", () => {
    // The add-on is priced off the subtotal, not off the shipping line, so it
    // keeps charging exactly what it charged before the switch was flipped.
    expect(calculateShippingProtectionFee(200, ON.protectionPercent)).toBe(
      calculateShippingProtectionFee(200, OFF.protectionPercent),
    );
    expect(calculateShippingProtectionFee(200, ON.protectionPercent)).toBeGreaterThan(0);
    expect(ON.protectionPercent).toBe(SHIPPING_PROTECTION_PERCENT);
  });

  it("is not a coupon, a membership perk or a bulk tier — those keep their own meaning", () => {
    // isShippingWaived answers "did a GRANT waive this order's fee". The
    // sitewide switch is not a grant: it changes the list price of shipping,
    // so it must not start reporting a coupon/member/bulk waiver that nobody
    // earned. Order attribution and commission read that distinction.
    expect(isShippingWaived({ bulkSavingsTier: false, memberFreeShipping: false, couponFreeShipping: false })).toBe(false);
    expect(isShippingWaived({ bulkSavingsTier: true, memberFreeShipping: false, couponFreeShipping: false })).toBe(true);
  });

  it("leaves the international (unshippable) zone rule alone", () => {
    // Everything outside US/CA is refused at checkout regardless; the switch
    // must not turn an unshippable destination into a $0 shippable one.
    expect(calculateShipping(50, "Germany", ON)).toBe(0);
    expect(calculateShipping(50, "Germany", OFF)).toBe(OFF.internationalFee);
  });
});


// ---------------------------------------------------------------------------
// WHAT THE SHOPPER IS TOLD, WHERE IT IS AN INLINE JSX RULE.
//
// Three of the surfaces the switch has to move are ternaries inside markup,
// with no function to call. They are read from source, comments stripped, for
// the same reason offer-placement.test.ts does it: a negative assertion that
// matches the paragraph explaining the rule proves nothing.
//
// Each of these got the money right and the words wrong at least once during
// review, which is exactly the drift worth pinning: a Shipping row saying
// "Free (member)" credits a plan for a giveaway everyone gets, and a card
// saying "unlocked" claims the basket earned something it did not.
// ---------------------------------------------------------------------------

const sourceOf = (path: string) =>
  readFileSync(join(process.cwd(), path), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
    .join("\n");

describe("the words on the page follow the switch, not just the arithmetic", () => {
  it("checkout stops crediting the membership perk for a storewide giveaway", () => {
    const checkout = sourceOf("src/app/checkout/page.tsx");
    expect(checkout).toContain('memberFreeShipping && !isFreeShippingSitewide(shippingConfig) ? "Free (member)"');
  });

  it("checkout stops quoting a threshold it is no longer applying", () => {
    const checkout = sourceOf("src/app/checkout/page.tsx");
    expect(checkout).toContain("isFreeShippingSitewide(shippingConfig)");
    expect(checkout).toContain("free on every order.");
  });

  it("the cart drawer says every order rather than unlocked, and drops the threshold footnote", () => {
    const drawer = sourceOf("src/components/cart-drawer.tsx");
    expect(drawer).toContain("const freeShipSitewide = isFreeShippingSitewide(shippingConfig)");
    expect(drawer).toContain('freeShipSitewide ? "Free shipping on every order" : "Free shipping unlocked"');
    // The progress card and the totals footnote both read the shared value, so
    // a threshold sentence cannot survive beside a $0 shipping row.
    expect(drawer).toContain("getShippingProgress(subtotal, freeShipThreshold, freeShipSitewide)");
    expect(drawer).toContain('"Free shipping on every order."');
    expect(drawer).not.toMatch(/Free shipping over \{formatCartCurrency\(freeShipThreshold\)\}/);
  });

  it("/cart drops its threshold copy the same way", () => {
    const cart = sourceOf("src/app/cart/cart-client.tsx");
    expect(cart).toContain("getShippingProgress(subtotal, freeShipThreshold, freeShipSitewide)");
    expect(cart).toContain("Free shipping on every order — no minimum.");
  });

  it("the storefront offers bar states the sitewide terms instead of the threshold", () => {
    const offers = sourceOf("src/lib/storefront-offers.ts");
    expect(offers).toContain("isFreeShippingSitewide(shipping)");
    expect(offers).toContain("Complimentary shipping on every order");
    // A different offer id: the bar dedupes and dismisses on it, and "free over
    // $200" and "free on everything" are not the same claim.
    expect(offers).toContain('offerId(["free_shipping", "sitewide"])');
  });

  it("structured data quotes $0, not a rate checkout will not charge", () => {
    const ld = sourceOf("src/lib/product-structured-data.ts");
    expect(ld).toContain("const sitewide = isFreeShippingSitewide(config)");
    expect(ld).toContain("fee: sitewide ? 0 : config.domesticFee");
    expect(ld).toContain("fee: sitewide ? 0 : config.northAmericaFee");
  });
});
