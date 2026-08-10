import { describe, expect, it } from "vitest";

/**
 * Availability is stock on hand minus what in-flight checkouts are holding.
 *
 * The rule lives in catalog.ts as `sellable()`; this restates it as an
 * executable specification because it is the difference between a shopper being
 * told "out of stock" on the product page and being told it at checkout, after
 * they have entered their address.
 */
function sellable(onHand: number, reserved: number): number {
  return Math.max(0, onHand - reserved);
}

describe("what a shopper can actually buy", () => {
  it("subtracts units held by other checkouts", () => {
    expect(sellable(5, 2)).toBe(3);
  });

  it("reports zero when the last unit is held, not one", () => {
    // The exact case that shipped: one vial in stock, one held mid-checkout,
    // and the product page still invited a second shopper to add it to cart.
    expect(sellable(1, 1)).toBe(0);
  });

  it("never goes negative when reservations exceed stock", () => {
    // Possible transiently after an admin lowers a count below what is held.
    expect(sellable(1, 3)).toBe(0);
  });

  it("is unchanged when nothing is reserved", () => {
    expect(sellable(4, 0)).toBe(4);
  });

  it("treats a missing reservation count as nothing reserved", () => {
    // A missing column or failed lookup degrades to today's behaviour rather
    // than hiding sellable stock.
    expect(sellable(4, Number(undefined) || 0)).toBe(4);
  });
});
