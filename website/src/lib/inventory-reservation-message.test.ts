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
// out" makes them guess which line, which is how a cart that could have been
// edited gets abandoned instead. It names the ITEM for that reason — and
// deliberately not the remaining COUNT, which is the owner's commercial
// information and would turn checkout into a binary-searchable inventory API.
describe("describeUnavailable", () => {
  it("names the short item and what to do, without naming the count", () => {
    const message = describeUnavailable([line()]);
    expect(message).toContain("BPC-157 10mg");
    expect(message).toMatch(/adjust your cart/i);
    expect(message).not.toMatch(/only 1|1 left|you asked for/i);
  });

  // Stronger than grepping for digits (the product name itself contains "10"):
  // if the wording is identical for every positive count, the message provably
  // carries no information about how deep the shelf is.
  it("reads identically whatever the remaining quantity is", () => {
    const messages = [1, 2, 3, 7, 42, 999].map((available) =>
      describeUnavailable([line({ quantity: 1000, available })]),
    );
    expect(new Set(messages).size).toBe(1);
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
