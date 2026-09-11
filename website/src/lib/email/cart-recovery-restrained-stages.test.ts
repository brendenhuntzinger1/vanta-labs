import { describe, expect, it } from "vitest";

import { cartRecoveryT24hTemplate, cartRecoveryT72hTemplate } from "@/lib/email/templates";

// ---------------------------------------------------------------------------
// STAGES 3 AND 4 IN THE RESTRAINED SHAPE.
//
// The placement diagnosis (docs/superpowers/specs/2026-09-11-placement-
// diagnosis-log.md) sent the offer stages as they were and as plain rewrites
// to a consumer Gmail seed. Every version with a "FREE GIFT" badge, a gold
// offer box, a dashed code box or a "Claim my ..." button sat in Promotions,
// and so did the plain rewrites; the one recovery message Gmail kept in the
// inbox led with information. Those readings do not decide the tab on their
// own, and the tab is not the goal. What they do settle is the shape this
// brand should have been sending anyway: a note that the cart is still there,
// one sentence saying what is added and on what terms, the cart, one button
// that says what it does. The offer is stated once, in words, the way the
// checkout will apply it. Nothing shouts.
//
// Every wording pinned here is one the store can prove: the gift is the one
// minted, the terms are the ones the till enforces, the percentage is the one
// on the code, and the deadline is the entitlement's own.
// ---------------------------------------------------------------------------

const cart = {
  name: "Sam",
  items: [{ name: "KLOW", quantity: 2, unitPriceCents: 10_999 }],
  cartValueCents: 21_998,
  restoreUrl: "https://vanta.test/cart/restore?id=abc",
};

const TERMS = "Your gift: a free GHK-Cu 50mg is added to your order on any order of $35 or more, through September 21, 2026. "
  + "One per customer, for this email address only. It is applied automatically when you shop through the button below — no code needed.";

describe("stage 3, restrained", () => {
  it("names the cart in the subject on arm A and the gift on arm B, both inside the inbox cut-off", () => {
    const a = cartRecoveryT24hTemplate({ ...cart, giftLabel: "GHK-Cu 50mg", offerTerms: TERMS, variant: "a" });
    const b = cartRecoveryT24hTemplate({ ...cart, giftLabel: "GHK-Cu 50mg", offerTerms: TERMS, variant: "b" });
    expect(a.subject).toBe("Your KLOW is still saved");
    expect(b.subject).toBe("GHK-Cu 50mg added to your KLOW");
    expect(a.subject.length).toBeLessThan(60);
    expect(b.subject.length).toBeLessThan(60);
  });

  it("says in one sentence what was added and that it ships in the same box", () => {
    const mail = cartRecoveryT24hTemplate({ ...cart, giftLabel: "GHK-Cu 50mg", offerTerms: TERMS });
    expect(mail.html).toContain("We have added GHK-Cu 50mg to it at no charge. It ships in the same box when you finish the order.");
    expect(mail.text).toContain("We have added GHK-Cu 50mg to it at no charge. It ships in the same box when you finish the order.");
  });

  it("lists every item of a multi-product gift in words, and counts them in the subject", () => {
    const mail = cartRecoveryT24hTemplate({
      ...cart,
      giftLabel: "TB-500 5mg + GHK-Cu 50mg + Recon Water 30ml",
      offerTerms: TERMS,
      variant: "b",
    });
    expect(mail.subject).toBe("3 gifts added to your KLOW");
    expect(mail.html).toContain("We have added TB-500 5mg, GHK-Cu 50mg and Recon Water 30ml to it at no charge. They ship in the same box when you finish the order.");
    expect(mail.text).toContain("TB-500 5mg, GHK-Cu 50mg and Recon Water 30ml");
  });

  it("carries the terms the till enforces, once, in the body and in the text", () => {
    const mail = cartRecoveryT24hTemplate({ ...cart, giftLabel: "GHK-Cu 50mg", offerTerms: TERMS });
    expect(mail.html.split("through September 21, 2026").length - 1).toBe(1);
    expect(mail.text).toContain("through September 21, 2026");
  });

  it("has no badge, no offer box and no claim button", () => {
    const mail = cartRecoveryT24hTemplate({ ...cart, giftLabel: "GHK-Cu 50mg", offerTerms: TERMS });
    expect(mail.html).not.toMatch(/free gift/i);
    expect(mail.html).not.toMatch(/claim my/i);
    expect(mail.html).not.toMatch(/text-transform:uppercase;font-weight:700;">(Free gift|On this order)/);
    expect(mail.html).not.toContain("border:1px dashed");
    expect(mail.html).toContain("Complete my order");
    expect(mail.text).toContain(`Complete your order: ${cart.restoreUrl}`);
  });

  it("never says 'free' in the subject or the title", () => {
    for (const variant of ["a", "b"] as const) {
      const mail = cartRecoveryT24hTemplate({ ...cart, giftLabel: "GHK-Cu 50mg", offerTerms: TERMS, variant });
      expect(mail.subject).not.toMatch(/free/i);
      const title = /<h1[^>]*>([^<]*)<\/h1>/.exec(mail.html)?.[1] ?? "";
      expect(title).not.toMatch(/free/i);
    }
  });

  it("does not name the same product twice when the gift is the cart's lead line", () => {
    const b = cartRecoveryT24hTemplate({
      ...cart,
      items: [{ name: "GHK-Cu 50mg", quantity: 4, unitPriceCents: 4_799 }],
      giftLabel: "GHK-Cu 50mg",
      offerTerms: TERMS,
      variant: "b",
    });
    expect(b.subject).toBe("GHK-Cu 50mg added to your order");
  });

  it("with no gift minted, promises nothing and still asks for the order", () => {
    for (const variant of ["a", "b"] as const) {
      const mail = cartRecoveryT24hTemplate({ ...cart, giftLabel: "", offerTerms: "", variant });
      expect(mail.subject).toBe("Your KLOW is still saved");
      expect(mail.html).not.toMatch(/gift|no charge|We have added/i);
      expect(mail.html).toContain("at the price you saw");
      expect(mail.html).toContain("Complete my order");
    }
  });
});

describe("stage 4, restrained", () => {
  const base = { ...cart, couponCode: "", expiresAt: "September 18, 2026 at 3:00 PM ET", giftLabel: "", offerTerms: "" };

  it("keeps the percentage out of the subject whatever was minted", () => {
    const both = cartRecoveryT72hTemplate({ ...base, couponCode: "VL10", discountPercent: 10, giftLabel: "GHK-Cu 50mg", offerTerms: TERMS });
    const codeOnly = cartRecoveryT72hTemplate({ ...base, couponCode: "VL10", discountPercent: 10 });
    const giftOnly = cartRecoveryT72hTemplate({ ...base, giftLabel: "GHK-Cu 50mg", offerTerms: TERMS });
    const none = cartRecoveryT72hTemplate(base);
    for (const mail of [both, codeOnly, giftOnly, none]) {
      expect(mail.subject).toBe("One last note about your KLOW");
      expect(mail.subject.length).toBeLessThan(60);
    }
  });

  it("states the code, the percentage, the deadline and the one-discount rule in words, with no code box", () => {
    const mail = cartRecoveryT72hTemplate({ ...base, couponCode: "VL10", discountPercent: 10 });
    expect(mail.html).toContain("The button below takes 10% off the order, or applies the current sale if that saves more.");
    const withGift = cartRecoveryT72hTemplate({ ...base, couponCode: "VL10", discountPercent: 10, giftLabel: "GHK-Cu 50mg", offerTerms: TERMS });
    expect(withGift.html).toContain("The button below also takes 10% off the order, or applies the current sale if that saves more.");
    expect(mail.html).toContain("Code VL10 is applied for you and stands through September 18, 2026 at 3:00 PM ET.");
    expect(mail.text).toContain("Code VL10 is applied for you and stands through September 18, 2026 at 3:00 PM ET.");
    expect(mail.html).not.toContain("border:1px dashed");
    expect(mail.html).not.toMatch(/claim my/i);
    expect(mail.html).toContain("Complete my order");
  });

  it("keeps the gift in the same sentence shape as stage 3, and the terms once", () => {
    const mail = cartRecoveryT72hTemplate({ ...base, giftLabel: "GHK-Cu 50mg + Recon Water 30ml", offerTerms: TERMS });
    expect(mail.html).toContain("The GHK-Cu 50mg and Recon Water 30ml are still added at no charge.");
    expect(mail.text).toContain("The GHK-Cu 50mg and Recon Water 30ml are still added at no charge.");
    expect(mail.html.split("through September 21, 2026").length - 1).toBe(1);
    expect(mail.html).not.toMatch(/free gift/i);
  });

  it("promises no code when none was minted", () => {
    const mail = cartRecoveryT72hTemplate({ ...base, giftLabel: "GHK-Cu 50mg", offerTerms: TERMS });
    expect(mail.html).not.toMatch(/% off/);
    expect(mail.text).not.toMatch(/% off/);
  });

  it("with nothing minted, is a plain last note", () => {
    const mail = cartRecoveryT72hTemplate(base);
    expect(mail.html).toContain("This is the last note we will send about this cart.");
    expect(mail.html).not.toMatch(/no charge|% off|Code [A-Z0-9]/);
    expect(mail.html).toContain("Complete my order");
  });

  it("does not double-escape a product name in the title", () => {
    const mail = cartRecoveryT72hTemplate({ ...base, giftLabel: "Peptide A & B", offerTerms: TERMS });
    expect(mail.html).toContain("Peptide A &amp; B");
    expect(mail.html).not.toContain("&amp;amp;");
  });
});
