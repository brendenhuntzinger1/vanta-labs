import { describe, expect, it } from "vitest";

import { cartRecoveryT24hTemplate, cartRecoveryT72hTemplate } from "@/lib/email/templates";

// ---------------------------------------------------------------------------
// THE RECOVERY EMAILS MUST SAY WHAT THE BOX WILL HOLD, AND NOTHING ELSE.
//
// Every case here is a sentence that was actually sent, wrong, and found by
// walking a real cart through the sweep and reading the delivered message:
//
//   "there is a vial of BAC Water on it from us"  — hardcoded, while the offer
//        row, the terms line and the checkout all said GHK-Cu. The band ladder
//        made the constant false the day it shipped.
//   "A free GHK-Cu 50mg with your GHK-Cu 50mg"    — the lead cart line and the
//        gift are chosen independently and collide constantly.
//   "with free shipping as always"                — must be a FACT about the
//        store, present only while the store is actually shipping free.
//
// None of these is caught by anything else: they are all true-looking strings
// in a template no unit test was reading.
// ---------------------------------------------------------------------------

const cart = {
  name: "Sam",
  items: [{ name: "KLOW", quantity: 2, unitPriceCents: 10_999 }],
  cartValueCents: 21_998,
  restoreUrl: "https://vanta.test/cart/restore?id=abc",
};

describe("stage 3 names the gift that was actually minted", () => {
  it("never mentions a product it was not given", () => {
    const mail = cartRecoveryT24hTemplate({ ...cart, giftLabel: "GHK-Cu 50mg", offerTerms: "Your gift: GHK-Cu 50mg" });
    const whole = `${mail.subject} ${mail.html} ${mail.text}`;
    expect(whole).toContain("GHK-Cu 50mg");
    expect(whole).not.toMatch(/BAC Water|Bacteriostatic/i);
  });

  it("counts a multi-product gift instead of listing it in the subject, and still lists it in the body", () => {
    const mail = cartRecoveryT24hTemplate({
      ...cart,
      giftLabel: "KLOW + GHK-Cu 50mg + Bacteriostatic Water 30ml",
      offerTerms: "Your gift: KLOW + GHK-Cu 50mg + Bacteriostatic Water 30ml",
    });
    expect(mail.subject).toContain("3 free gifts");
    expect(mail.subject.length).toBeLessThan(60);
    expect(mail.html).toContain("Bacteriostatic Water 30ml");
  });

  // The whole point of the collision guard: the gift half survives, the cart
  // half goes generic, and the product is never named twice in one line.
  it("does not name the same product twice when the gift matches the cart's lead line", () => {
    const mail = cartRecoveryT24hTemplate({
      ...cart,
      items: [{ name: "GHK-Cu 50mg", quantity: 4, unitPriceCents: 4_799 }],
      giftLabel: "GHK-Cu 50mg",
      offerTerms: "Your gift: GHK-Cu 50mg",
    });
    expect(mail.subject).toBe("A free GHK-Cu 50mg with your order");
    const b = cartRecoveryT24hTemplate({
      ...cart,
      items: [{ name: "GHK-Cu 50mg", quantity: 4, unitPriceCents: 4_799 }],
      giftLabel: "GHK-Cu 50mg",
      offerTerms: "t",
      variant: "b",
    });
    expect(b.subject).toBe("Your cart, and a free GHK-Cu 50mg");
  });

  it("still names the cart's lead line when it is a different product", () => {
    const mail = cartRecoveryT24hTemplate({ ...cart, giftLabel: "GHK-Cu 50mg", offerTerms: "t" });
    expect(mail.subject).toBe("A free GHK-Cu 50mg with your KLOW");
  });
});

describe("free shipping is a fact about the store, not a gift", () => {
  it("says so only when the store is actually shipping free", () => {
    const on = cartRecoveryT24hTemplate({ ...cart, giftLabel: "GHK-Cu 50mg", offerTerms: "t", freeShipping: true });
    expect(on.html).toContain("with free shipping as always");
    expect(on.text).toContain("with free shipping as always");
  });

  it("says nothing about shipping when the store is not", () => {
    const off = cartRecoveryT24hTemplate({ ...cart, giftLabel: "GHK-Cu 50mg", offerTerms: "t", freeShipping: false });
    expect(off.html).not.toMatch(/free shipping/i);
    expect(off.text).not.toMatch(/free shipping/i);
  });

  // Absent must behave as OFF: an older caller that does not pass the flag has
  // not confirmed the setting, and an unconfirmed perk is not claimed.
  it("treats an absent flag as off", () => {
    const mail = cartRecoveryT24hTemplate({ ...cart, giftLabel: "GHK-Cu 50mg", offerTerms: "t" });
    expect(mail.html).not.toMatch(/free shipping/i);
  });

  // It is never dressed up as part of the gift — the gift box lists products.
  it("never puts shipping inside the gift block", () => {
    const mail = cartRecoveryT24hTemplate({ ...cart, giftLabel: "GHK-Cu 50mg", offerTerms: "Your gift: GHK-Cu 50mg", freeShipping: true });
    const box = mail.html.slice(mail.html.indexOf("Free gift"), mail.html.indexOf("Free gift") + 400);
    expect(box).not.toMatch(/shipping/i);
  });
});

describe("stage 4 describes only what was minted", () => {
  const base = { ...cart, couponCode: "", expiresAt: "September 18, 2026", giftLabel: "", offerTerms: "" };

  it("carries the gift and the percentage together when both were minted", () => {
    const mail = cartRecoveryT72hTemplate({ ...base, couponCode: "VL10", discountPercent: 10, giftLabel: "GHK-Cu 50mg + Bacteriostatic Water 30ml", offerTerms: "t" });
    expect(mail.subject).toBe("Last note: 10% off and 2 free gifts");
    expect(mail.html).toContain("VL10");
    expect(mail.html).toContain("Bacteriostatic Water 30ml");
  });

  it("promises no code when none was minted", () => {
    const mail = cartRecoveryT72hTemplate({ ...base, giftLabel: "GHK-Cu 50mg", offerTerms: "t" });
    expect(mail.subject).toBe("Last note: a free GHK-Cu 50mg with your order");
    expect(mail.html).not.toMatch(/% off/);
  });

  // titleHtml escapes what it is handed, so the headline must reach it as plain
  // text — escaping it twice put a literal "&amp;" in the inbox.
  it("does not double-escape a product name in the headline", () => {
    const mail = cartRecoveryT72hTemplate({ ...base, giftLabel: "Peptide A & B", offerTerms: "t" });
    expect(mail.html).toContain("A free Peptide A &amp; B, on us");
    expect(mail.html).not.toContain("&amp;amp;");
  });
});
