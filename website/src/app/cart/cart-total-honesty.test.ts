import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

// ---------------------------------------------------------------------------
// The cart may not call a number "final" while mandatory charges are still to
// come.
//
// It used to render:
//
//     Sales tax            Calculated at checkout
//     Final total          $84.00
//
// — two lines apart, contradicting each other. And the card processing fee
// (3%, mandatory for the only enabled payment method) was not in that figure
// either, so a cart reading "Final total $84.00" became $86.52 at checkout.
//
// Understating a total and calling it final is the kind of surprise that gets a
// shopper to the card form and then loses them there, which is the same failure
// this whole lane exists to stop.
// ---------------------------------------------------------------------------

describe("the cart never presents a pre-checkout figure as final", () => {
  const cart = read("src/app/cart/cart-client.tsx");

  it("does not label the summary total 'Final total'", () => {
    expect(cart).not.toMatch(/>Final total</);
  });

  it("calls it an estimate instead", () => {
    expect(cart).toMatch(/>Estimated total</);
  });

  it("still tells the shopper tax comes later", () => {
    // The honest line that was already there, kept.
    expect(cart).toMatch(/Calculated at checkout/);
  });

  it("says the processing fee is added at checkout too", () => {
    // Tax was disclosed and the card fee was not, though both are added on the
    // same screen and the fee is mandatory for the only enabled method.
    expect(cart).toMatch(/processing fee/i);
  });
});
