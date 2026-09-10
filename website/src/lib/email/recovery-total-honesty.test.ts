import { describe, expect, it } from "vitest";
import {
  cartRecoveryT30mTemplate,
  cartRecoveryT12hTemplate,
  cartRecoveryT24hTemplate,
  cartRecoveryT72hTemplate,
} from "@/lib/email/templates";

// ---------------------------------------------------------------------------
// THE EMAIL MUST NOT PROMISE A NUMBER THE CHECKOUT WILL NOT HONOUR.
//
// Driven in a browser on 2026-09-10, 390x844, as a guest arriving on a real
// recovery link. The email said:
//
//     Cart total: $185.99
//     "Nothing has been cleared, and the prices are the ones you saw."
//
// The checkout then asked for $210.99 — 13.4% more: $15.00 shipping, a
// PRE-TICKED $10.75 shipping protection, and a 3% card service fee. The item
// prices were honest (the subtotal was actually LOWER, $179.09, because a
// bundle discount applied); the TOTAL was not, because "Cart total" named a
// figure that excludes everything added later.
//
// These shoppers abandoned once already, and unexpected cost at checkout is
// the most-cited reason people abandon. Bringing them back to a larger number
// than the one they walked away from — having explicitly promised otherwise —
// spends the click on a second abandonment.
//
// The fix is honesty, not a discount: the line is labelled for what it counts,
// and the message says plainly that shipping, tax and options come after. The
// pre-ticked protection is a separate, deliberate pricing decision and is NOT
// changed here.
// ---------------------------------------------------------------------------

const items = [
  { name: "BPC-157 10mg", quantity: 2, unitPriceCents: 6900 },
  { name: "GHK-Cu 50mg", quantity: 1, unitPriceCents: 4799 },
];
const cartValueCents = 18599;
const restoreUrl = "https://example.test/api/email/track/click?id=abc&url=x";

const templates = {
  t30m: () => cartRecoveryT30mTemplate({ name: "Alex", items, cartValueCents, restoreUrl }),
  t12h: () => cartRecoveryT12hTemplate({
    name: "Alex", items, cartValueCents, restoreUrl,
    coaUrl: "https://example.test/research", batchNumber: "B-1", supportEmail: "s@example.test",
  }),
  t24h: () => cartRecoveryT24hTemplate({
    name: "Alex", items, cartValueCents, restoreUrl, giftLabel: "", offerTerms: "",
  }),
  t72h: () => cartRecoveryT72hTemplate({
    name: "Alex", items, cartValueCents, restoreUrl,
    couponCode: "SAVE-TEST", discountPercent: 10, expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    giftLabel: "", offerTerms: "",
  }),
};

describe.each(Object.entries(templates))("%s recovery email", (_stage, build) => {
  it("does not label the item subtotal as the cart's total", () => {
    const { html, text } = build();
    // "Cart total" reads as the amount due. It is not — it excludes shipping,
    // tax, options and the card fee.
    expect(html).not.toContain("Cart total");
    expect(text).not.toContain("Cart total:");
  });

  it("names what the figure actually counts", () => {
    const { html, text } = build();
    expect(html).toContain("Items total");
    expect(text).toContain("Items total:");
  });

  it("says plainly that shipping, tax and options come after", () => {
    const { html, text } = build();
    expect(html).toMatch(/[Ss]hipping, tax and any options are added at checkout/);
    expect(text).toMatch(/[Ss]hipping, tax and any options are added at checkout/);
  });

  it("still shows the real item figure, so the disclosure did not replace the number", () => {
    const { html, text } = build();
    expect(html).toContain("$185.99");
    expect(text).toContain("$185.99");
  });
});

describe("the stage-1 promise", () => {
  it("no longer claims the prices the shopper saw are the whole story", () => {
    const { html, text } = templates.t30m();
    // The old sentence — "Nothing has been cleared, and the prices are the
    // ones you saw" — is true of the line items and false of the total, and a
    // shopper reads it as the total.
    expect(html).not.toContain("the prices are the ones you saw");
    expect(text).not.toContain("the prices are the ones you saw");
  });

  it("still tells them the cart is intact, which is the true and useful half", () => {
    const { text } = templates.t30m();
    expect(text).toMatch(/still|saved|nothing has been cleared/i);
  });
});
