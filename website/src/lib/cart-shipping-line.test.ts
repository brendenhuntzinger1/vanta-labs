import { describe, expect, it } from "vitest";
import { cartShippingLineLabel } from "@/lib/cart-shipping-line";

// CART-04: the drawer said "Calculated at payment" once the basket crossed the
// free-shipping threshold — under a banner saying free shipping was unlocked —
// while /cart said $0.00 and /checkout said Free. Zero was the drawer's "not
// priced yet" value as well as its "free" value.

const format = (n: number) => `$${n.toFixed(2)}`;

describe("cartShippingLineLabel", () => {
  it("prints the amount when shipping is charged", () => {
    expect(cartShippingLineLabel({ shipping: 15, serverQuoted: false, freeShippingUnlocked: false, format })).toBe("$15.00");
  });

  it("says Free when the basket has crossed the free-shipping threshold", () => {
    expect(cartShippingLineLabel({ shipping: 0, serverQuoted: false, freeShippingUnlocked: true, format })).toBe("Free");
  });

  it("says Free when the server has priced the basket at zero", () => {
    expect(cartShippingLineLabel({ shipping: 0, serverQuoted: true, freeShippingUnlocked: false, format })).toBe("Free");
  });

  it("keeps the honest placeholder when nothing has decided shipping is free", () => {
    expect(cartShippingLineLabel({ shipping: 0, serverQuoted: false, freeShippingUnlocked: false, format })).toBe(
      "Calculated at payment",
    );
  });
});
