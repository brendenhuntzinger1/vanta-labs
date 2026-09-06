// ---------------------------------------------------------------------------
// "COMPLETE YOUR ORDER — [x] Add 10 mL BAC Water   +$14.99"
//
// …directly underneath a cart line reading "BAC Water (0.9% Benzyl Alcohol),
// qty 1, $14.99". Reported from a phone alongside the discount row, and it is
// the same complaint: the screen is telling the truth in a way that reads as a
// second charge. The tick means "this size is in your cart" and the price is
// the price of the size, not of another one — but a checked box next to the
// word "Add" and a "+$14.99" says the opposite to anyone who is not reading it
// as a developer.
//
// The control keeps its behaviour (ticking adds, unticking removes). Only what
// it says about its own state changes.
// ---------------------------------------------------------------------------
import { describe, it, expect } from "vitest";
import { bacWaterCheckboxCopy } from "@/lib/bac-water";

describe("bacWaterCheckboxCopy", () => {
  it("offers the size when it is not in the cart", () => {
    const copy = bacWaterCheckboxCopy({ sizeLabel: "10 mL", displayPrice: "$14.99", inCart: false });
    expect(copy.label).toBe("Add 10 mL BAC Water");
    expect(copy.price).toBe("+$14.99");
    expect(copy.ariaLabel).toBe("Add 10 mL BAC Water to your order");
  });

  it("reports the size as already in the cart rather than offering it again", () => {
    const copy = bacWaterCheckboxCopy({ sizeLabel: "10 mL", displayPrice: "$14.99", inCart: true });
    expect(copy.label).toBe("10 mL BAC Water — in your cart");
    // No leading "+": the money is already in the subtotal above, and a "+" beside
    // a line the shopper can already see is what reads as a second charge.
    expect(copy.price).toBe("$14.99");
    expect(copy.ariaLabel).toBe("Remove 10 mL BAC Water from your order");
  });
});
