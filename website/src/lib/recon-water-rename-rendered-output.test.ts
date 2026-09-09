import { describe, expect, it } from "vitest";

import { OFFER_CATALOG } from "@/lib/offers/customer-offers";
import { describeGiftTerms } from "@/lib/offers/gift-terms";
import { bacWaterCheckboxCopy, isBacWater, BAC_WATER_SLUG } from "@/lib/bac-water";
import {
  cartRecoveryGiftTemplate,
  cartRecoveryT24hTemplate,
  cartRecoveryT30mTemplate,
  cartRecoveryT72hTemplate,
  orderConfirmationTemplate,
} from "@/lib/email/templates";

// ---------------------------------------------------------------------------
// THE RENAME IS PROVEN AT THE RENDERED STRING, NOT AT THE SOURCE.
//
// A repository grep proves a literal is absent from the code. It does not prove
// what a customer reads, because the words in an email are assembled at send
// time from an OFFER_CATALOG label, a catalogue product name and a template.
// Any one of those three can still carry the retired spelling while the other
// two are clean, and the only place they are all resolved is the output.
//
// So this renders the real templates with a Recon water cart and asserts on the
// bytes that would reach an inbox.
//
// The catalogue name below is production's, verbatim:
//     products.name = "Recon water (0.9% Benzyl Alcohol)"
// ---------------------------------------------------------------------------

/** Anything a customer must never read. Deliberately wider than the rename. */
const RETIRED = /bacteriostatic|bac[-\s]?water|\bBAC\b/i;

const PRODUCT_NAME = "Recon water (0.9% Benzyl Alcohol)";
const CART = [
  { name: "BPC-157 10mg", quantity: 1, unitPriceCents: 4499 },
  { name: PRODUCT_NAME, quantity: 2, unitPriceCents: 1499 },
];

/** Every visible surface of a rendered email: subject, preheader, html, text. */
function surfaces(template: {
  subject: string; html: string; text: string; preheader?: string;
}): string {
  return [template.subject, template.preheader ?? "", template.html, template.text].join("\n");
}

describe("every rendered customer surface names Recon Water", () => {
  it("the offer catalogue's own labels are clean", () => {
    for (const [key, offer] of Object.entries(OFFER_CATALOG)) {
      // The KEY is an internal identifier and deliberately still reads
      // *_bac_water_* -- it joins live customer_offers rows to this catalogue.
      // Only the label is read by a human.
      expect(offer.label, `label of ${key}`).not.toMatch(RETIRED);
    }
  });

  it("the gift terms sentence the till and the email both quote is clean", () => {
    const expiresAt = "2026-12-31T00:00:00.000Z";
    for (const [key, offer] of Object.entries(OFFER_CATALOG)) {
      const terms = describeGiftTerms(
        {
          label: offer.label,
          reward: offer.reward,
          minSubtotalCents: offer.minSubtotalCents ?? 3500,
          ttlDays: offer.ttlDays ?? 7,
        },
        expiresAt,
      );
      expect(terms, `terms of ${key}`).not.toMatch(RETIRED);
    }
  });

  it("the abandoned-cart recovery emails are clean at every stage", () => {
    const common = { name: "Sam", items: CART, cartValueCents: 7497, restoreUrl: "https://x.test/r" };

    const rendered = [
      cartRecoveryT30mTemplate(common),
      cartRecoveryT24hTemplate({
        ...common,
        giftLabel: "2 free Recon Water",
        offerTerms: "Your gift: 2 free Recon Water are added to your order on any order of $35 or more.",
      }),
      cartRecoveryGiftTemplate({
        ...common,
        giftLabel: "2 free Recon Water",
        offerTerms: "Your gift: 2 free Recon Water are added to your order on any order of $35 or more.",
        perks: ["Free shipping"],
      }),
      cartRecoveryT72hTemplate({
        ...common,
        couponCode: "COMEBACK",
        discountPercent: 10,
        expiresAt: "2026-12-31T00:00:00.000Z",
        giftLabel: "2 free Recon Water",
        offerTerms: "Your gift: 2 free Recon Water are added to your order on any order of $35 or more.",
      }),
    ];

    for (const template of rendered) {
      const body = surfaces(template);
      expect(body).toContain("Recon water");
      expect(body).not.toMatch(RETIRED);
    }
  });

  it("the order confirmation is clean", () => {
    const template = orderConfirmationTemplate({
      customerName: "Sam",
      orderId: "VL-1001",
      items: CART.map((item) => ({
        name: item.name,
        quantity: item.quantity,
        lineTotal: (item.unitPriceCents * item.quantity) / 100,
      })),
      subtotal: 74.97,
      shipping: 0,
      discount: 0,
      total: 74.97,
    });

    const body = surfaces(template);
    expect(body).toContain("Recon water");
    expect(body).not.toMatch(RETIRED);
  });

  it("the cart checkbox reads Recon Water in both of its states", () => {
    for (const inCart of [true, false]) {
      const copy = bacWaterCheckboxCopy({ sizeLabel: "10 mL", displayPrice: "$14.99", inCart });
      expect(copy.label).not.toMatch(RETIRED);
      expect(copy.ariaLabel).not.toMatch(RETIRED);
      expect(copy.label).toContain("Recon Water");
    }
  });

  it("the self-exclusion guard still recognises the product after the rename", () => {
    // If this stops matching, the Recon Water page cross-sells Recon Water.
    expect(isBacWater({ slug: BAC_WATER_SLUG, name: PRODUCT_NAME })).toBe(true);
    expect(isBacWater({ slug: "recon-water", name: "Recon Water 30ml" })).toBe(true);
    // Every retired spelling stays recognised: stored carts and old order rows
    // still carry them.
    expect(isBacWater("bac-water")).toBe(true);
    expect(isBacWater("bacteriostatic-water")).toBe(true);
    // And it must not swallow the rest of the catalogue.
    expect(isBacWater({ slug: "bpc-157-10mg", name: "BPC-157 10mg" })).toBe(false);
  });
});
