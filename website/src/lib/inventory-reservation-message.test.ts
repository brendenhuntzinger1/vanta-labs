import { describe, expect, it } from "vitest";
import { describeUnavailable, type UnavailableLine } from "@/lib/inventory-reservation";

function line(overrides: Partial<UnavailableLine> = {}): UnavailableLine {
  return {
    slug: "bpc-157-10mg",
    variantId: null,
    quantity: 3,
    available: 1,
    name: "BPC-157 10mg",
    ...overrides,
  };
}

// The point of this message is that the customer can ACT on it. "Something sold
// out" makes them guess which line and by how much, which is how a cart that
// could have been edited gets abandoned instead.
describe("describeUnavailable", () => {
  it("names the item and how many are left", () => {
    const message = describeUnavailable([line()]);
    expect(message).toContain("BPC-157 10mg");
    expect(message).toContain("only 1 left");
    expect(message).toContain("you asked for 3");
  });

  it("says sold out when nothing is left, rather than 'only 0 left'", () => {
    expect(describeUnavailable([line({ available: 0 })])).toContain("just sold out");
    expect(describeUnavailable([line({ available: 0 })])).not.toContain("only 0");
  });

  // The count is read after the hold failed, so it can legitimately be
  // unavailable. Degrading to a vaguer sentence beats printing "only null left".
  it("degrades gracefully when the count could not be read", () => {
    const message = describeUnavailable([line({ available: null })]);
    expect(message).toContain("no longer available");
    expect(message).not.toMatch(/null|undefined|NaN/);
  });

  it("falls back to a generic noun when the product name is missing", () => {
    expect(describeUnavailable([line({ name: null, available: 2 })])).toContain("An item in your cart");
  });

  it("lists every short line, not just the first", () => {
    const message = describeUnavailable([
      line({ name: "BPC-157 10mg", available: 1 }),
      line({ name: "GHK-Cu 50mg", available: 0 }),
    ]);
    expect(message).toContain("BPC-157 10mg");
    expect(message).toContain("GHK-Cu 50mg");
  });

  it("always tells the customer what to do next", () => {
    expect(describeUnavailable([line()])).toContain("adjust your cart");
    expect(describeUnavailable([])).toContain("adjust your cart");
  });

  it("handles an empty list without producing a broken sentence", () => {
    const message = describeUnavailable([]);
    expect(message.length).toBeGreaterThan(0);
    expect(message).not.toMatch(/undefined|NaN|\.\s*\./);
  });
});
