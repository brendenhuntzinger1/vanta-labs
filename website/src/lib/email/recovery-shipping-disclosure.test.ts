import { describe, expect, it } from "vitest";
import {
  cartRecoveryT30mTemplate,
  cartRecoveryT12hTemplate,
  cartRecoveryT24hTemplate,
  cartRecoveryT72hTemplate,
  cartRecoveryPaymentFailedTemplate,
} from "@/lib/email/templates";

// ---------------------------------------------------------------------------
// P0-7. THE RECOVERY EMAILS WERE STILL CHARGING FOR SHIPPING.
//
// `free_shipping_sitewide` was switched on in production on 2026-09-06 and
// nothing propagated it to copy. Every recovery template carried a hard-coded
// "Shipping, tax and any options are added at checkout." on the line directly
// above the button.
//
// Baymard's meta-analysis of fifty studies puts "extra costs too high —
// shipping, tax, fees" first among stated reasons for abandoning a cart, at
// 48%. The store had removed the cost and its recovery email was still
// recreating the objection, to the one audience that had already acted on it.
//
// The disclosure now comes from the live shipping config, so the next time the
// setting moves the copy moves with it. Tax stays in the sentence because tax
// is still added — the line has to stay TRUE, not merely become cheerful.
// ---------------------------------------------------------------------------

const items = [{ name: "BPC-157 5mg", quantity: 2, unitPriceCents: 5999, image: "https://x.test/a.jpg" }];
const base = { name: "Sam", items, cartValueCents: 22_997, restoreUrl: "https://x.test/r" };

const stages = (freeShipping: boolean) => [
  ["t30m", cartRecoveryT30mTemplate({ ...base, freeShipping })],
  ["t12h", cartRecoveryT12hTemplate({ ...base, freeShipping, coaUrl: "https://x.test/coa", batchNumber: "VL-1", supportEmail: "s@x.test" })],
  ["t24h", cartRecoveryT24hTemplate({ ...base, freeShipping, giftLabel: "GHK-Cu 50mg", offerTerms: "terms" })],
  ["t72h", cartRecoveryT72hTemplate({ ...base, freeShipping, couponCode: "SAVE-1", discountPercent: 10, expiresAt: "18 Sep 2026", giftLabel: "GHK-Cu 50mg", offerTerms: "terms" })],
  ["payment-failed", cartRecoveryPaymentFailedTemplate({ ...base, freeShipping, failure: "declined", orderNumber: "VL-A" })],
] as const;

describe("the recovery cart summary's cost disclosure", () => {
  it("does not tell an abandoning shopper that shipping is added, when it is free", () => {
    for (const [stage, mail] of stages(true)) {
      expect(mail.html, stage).not.toContain("Shipping, tax and any options are added at checkout");
      expect(mail.text, stage).not.toContain("Shipping, tax and any options are added at checkout");
    }
  });

  it("says shipping is free, on every stage — not only the gift one", () => {
    for (const [stage, mail] of stages(true)) {
      expect(mail.html, stage).toContain("Shipping is free.");
      expect(mail.text, stage).toContain("Shipping is free.");
    }
  });

  it("still discloses tax, because tax is still added", () => {
    for (const [stage, mail] of stages(true)) {
      expect(mail.text, stage).toMatch(/Tax and any options are added at checkout/);
    }
  });

  it("keeps the original sentence when shipping is not free", () => {
    for (const [stage, mail] of stages(false)) {
      expect(mail.html, stage).toContain("Shipping, tax and any options are added at checkout");
    }
  });

  it("defaults to the charging sentence when the flag is absent", () => {
    // An unknown shipping position must read as the conservative claim: telling
    // somebody shipping is free when it is not is the expensive direction.
    const mail = cartRecoveryT30mTemplate({ ...base });
    expect(mail.html).toContain("Shipping, tax and any options are added at checkout");
  });
});
