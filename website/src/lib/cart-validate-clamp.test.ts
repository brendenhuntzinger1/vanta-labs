import { describe, expect, it } from "vitest";
import { resolveAllowedQuantity } from "@/app/api/cart/validate/route";
import { MAX_UNITS_PER_ORDER_LINE } from "@/lib/purchase-limits";

// ---------------------------------------------------------------------------
// A VALUE-LEVEL test, deliberately.
//
// The sibling suite (inventory-visibility.test.ts) asserts against SOURCE TEXT,
// which is the right tool for "is the invalidation call still there" and the
// wrong tool for this. The first version of this endpoint leaked the exact live
// stock count for any SKU to any anonymous caller, and the source-text guard
// passed the whole time — because the leak was spelled
// `Math.min(line.requested, match.available)` rather than the
// `available: match.available` the assertion looked for.
//
// So this one runs the real function over real numbers. The property it proves
// is simple and total: NOTHING this endpoint returns can exceed the per-line
// order ceiling, whatever the caller asks for. That is what makes it disclose
// no more than the product page already does.
// ---------------------------------------------------------------------------

describe("resolveAllowedQuantity", () => {
  it("returns the request untouched when there is plenty", () => {
    expect(resolveAllowedQuantity(3, 50)).toBe(3);
    expect(resolveAllowedQuantity(1, 2)).toBe(1);
  });

  it("reduces to what is left when the shelf is short", () => {
    expect(resolveAllowedQuantity(5, 3)).toBe(3);
    expect(resolveAllowedQuantity(2, 1)).toBe(1);
  });

  it("returns 0 when nothing is left", () => {
    expect(resolveAllowedQuantity(4, 0)).toBe(0);
  });

  // The regression that matters: a crafted request must not read the count back.
  it("never publishes a number above the per-line order ceiling", () => {
    for (const available of [11, 12, 37, 99, 250, 5000, 999999]) {
      expect(
        resolveAllowedQuantity(999999, available),
        `available=${available}`,
      ).toBe(MAX_UNITS_PER_ORDER_LINE);
    }
  });

  it("gives an absurd request the same answer for every large count", () => {
    // If the reply is constant across stock depths, it carries no information
    // about them — which is the whole point.
    const replies = [11, 40, 400, 4000].map((available) => resolveAllowedQuantity(999999, available));
    expect(new Set(replies).size).toBe(1);
  });

  it("still discloses small counts, because a shopper cannot act otherwise", () => {
    // Below the ceiling the exact figure is unavoidable — the cart has to be
    // corrected to a specific number — and it is the same figure the product
    // page already uses to cap its own controls.
    for (let available = 0; available < MAX_UNITS_PER_ORDER_LINE; available += 1) {
      expect(resolveAllowedQuantity(999999, available)).toBe(available);
    }
  });

  it("never returns a negative or fractional quantity", () => {
    expect(resolveAllowedQuantity(5, -3)).toBe(0);
    expect(resolveAllowedQuantity(-2, 10)).toBe(0);
  });
});
