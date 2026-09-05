import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import { calculateShippingProtectionFee } from "@/lib/shipping-protection";

// ---------------------------------------------------------------------------
// THE PRICE NEXT TO AN OPT-IN MUST BE WHAT TICKING IT COSTS.
//
// Shipping protection is a paid add-on that is now PRE-SELECTED on these
// surfaces (see shipping-protection-default.test.ts). The row that offers it
// carries a price, and that price still has to be the real one: a shopper who
// unticks protection is looking at the same row, now deciding whether to put
// it back. Rendering the APPLIED fee there would tell them re-adding it is
// free.
//
// /cart rendered that price from `shippingProtectionFee`, the fee CURRENTLY
// APPLIED — which is 0 while the box is unticked, and the box is unticked for
// every shopper who has not yet decided. So the offer read:
//
//     [ ] Shipping Protection (Recommended) · optional        +$0.00
//
// A shopper deciding whether to add it was told it was free. Ticking it moved
// the total by the real fee — $2.76 on a $69 cart, $3.40 on the basket the
// store's first real customer actually bought. Browser-proven: unticked showed
// +$0.00, ticked showed +$2.76, same cart, nothing else changed.
//
// The cart drawer and the checkout page were already correct — both render
// `calculateShippingProtectionFee(subtotal)`, the PROSPECTIVE fee, so the price
// stands still whether or not the box is ticked. /cart was the only surface
// that disagreed, which is also why it went unnoticed.
//
// Advertising a paid add-on at $0.00 at the moment of consent is the same
// family of problem as pre-ticking it: the shopper's decision is made against a
// number that is not the price.
// ---------------------------------------------------------------------------

const read = (path: string) => readFileSync(path, "utf8");

/**
 * Source with comments removed.
 *
 * A source-text assertion that can be tripped by prose is not testing the code.
 * The fix below is explained in a comment that necessarily names the variable it
 * replaced, and matching that would fail the very change it is meant to lock in.
 */
const code = (path: string) =>
  read(path)
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

/** The three surfaces that offer protection with a price beside the tickbox. */
const OFFER_SURFACES = [
  "src/app/cart/cart-client.tsx",
  "src/components/cart-drawer.tsx",
  "src/app/checkout/page.tsx",
];

describe("the shipping-protection offer shows what the add-on costs", () => {
  it("the fee helper answers with the real price regardless of selection", () => {
    // The helper never knew about the checkbox — it takes a subtotal. The bug
    // was entirely in which value the cart handed to the label.
    expect(calculateShippingProtectionFee(69)).toBeCloseTo(4.14, 2);
    expect(calculateShippingProtectionFee(84.98)).toBeCloseTo(5.1, 2);
    expect(calculateShippingProtectionFee(0)).toBe(0);
  });

  it("every surface prices the offer from the subtotal, not from the current selection", () => {
    for (const path of OFFER_SURFACES) {
      const source = read(path);
      // Matched as a CALL ON `subtotal` rather than as a fixed string, because
      // the helper now also takes the admin-configured rate:
      // calculateShippingProtectionFee(subtotal, shippingProtectionPercent).
      // Pinning the old zero-argument spelling would fail on a surface that is
      // in fact correct, and — worse — would push someone to "fix" it by
      // dropping the rate argument, which is what makes the offer price track
      // the admin setting.
      expect(source, `${path} must offer protection at its real price`).toMatch(
        /calculateShippingProtectionFee\(\s*subtotal\b/,
      );
    }
  });

  it("no surface prices the offer row from the applied fee", () => {
    // `shippingProtectionFee` is the fee ACTUALLY CHARGED — correct for a
    // summary line that only appears once protection is on, and wrong for the
    // control that asks the shopper to turn it on.
    for (const path of OFFER_SURFACES) {
      const source = code(path);
      const offerRow = /aria-label="Add shipping protection"[\s\S]{0,1600}?<\/label>/.exec(source);
      expect(offerRow, `${path} should still render a protection opt-in`).not.toBeNull();
      expect(
        offerRow?.[0] ?? "",
        `${path} prices its protection opt-in from the applied fee, so it reads +$0.00 until ticked`,
      ).not.toMatch(/shippingProtectionFee/);
    }
  });

  it("the summary line, which only shows once protection is on, still uses the applied fee", () => {
    // Guards the other direction: switching the summary to the prospective fee
    // would bill-looking a line the shopper declined.
    const cart = read("src/app/cart/cart-client.tsx");
    expect(cart).toMatch(/shippingProtectionFee > 0/);
  });
});
