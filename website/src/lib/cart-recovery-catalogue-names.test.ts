import { describe, expect, it } from "vitest";

import { plainGreetingName } from "@/lib/email/greeting-name";

// ---------------------------------------------------------------------------
// AUTH-3 — CART RECOVERY PRINTS THE CATALOGUE'S WORDS, NOT THE BEACON'S.
//
// The guest tracking beacon stores whatever the browser posted, per line,
// verbatim, and the recovery series rendered it back out: an anonymous POST
// could have "Your account is locked — call +1 555 0100" delivered as a
// branded four-message sequence to any address it named. Product names now
// come from the catalogue by slug; a line whose slug is not a live product is
// dropped; the greeting name is held to the shape of a name.
//
// The pure rules, pinned without a database. The sweep-level case lives in
// cart-recovery-sequence.test.ts.
// ---------------------------------------------------------------------------

const { recoveryEmailItems } = await import("@/lib/cart-recovery");

// The catalogue entry is the WHOLE description now, not just a name: price and
// image come from here too, so the beacon's stored snapshot decides only WHICH
// products appear and never how they are described or priced.
const catalogue = new Map([
  ["bpc-157", { name: "BPC-157", unitPriceCents: 6900, image: "https://vanta.test/bpc.jpg" }],
  ["tb-500", { name: "TB-500", unitPriceCents: 7900 }],
]);

describe("recoveryEmailItems", () => {
  // THE STORED PRICE IS NEVER SHOWN, for the same reason the stored name is
  // not: it came from the browser. It is also stale by construction — the
  // snapshot is written when the shopper adds to the cart, and quoteOrder
  // prices from the catalogue whatever it says.
  it("prices from the catalogue and ignores the price the beacon stored", () => {
    const items = recoveryEmailItems([{ slug: "bpc-157", name: "x", quantity: 1, unitPrice: 0.01 }], catalogue);
    expect(items[0].unitPriceCents).toBe(6900);
  });

  it("omits the price rather than printing a wrong one when the catalogue has none", () => {
    const priceless = new Map([["bpc-157", { name: "BPC-157", unitPriceCents: 0 }]]);
    const items = recoveryEmailItems([{ slug: "bpc-157", name: "x", quantity: 1, unitPrice: 5 }], priceless);
    expect(items).toEqual([{ name: "BPC-157", quantity: 1 }]);
  });

  it("renders the catalogue's name for a known slug, ignoring the stored one", () => {
    const items = recoveryEmailItems(
      [{ slug: "bpc-157", name: "Your account is locked - call +1 555 0100", quantity: 2, unitPrice: 1 }],
      catalogue,
    );
    expect(items).toEqual([{ name: "BPC-157", quantity: 2, unitPriceCents: 6900, image: "https://vanta.test/bpc.jpg" }]);
  });

  it("drops a line whose slug is not a live product, whatever it calls itself", () => {
    const items = recoveryEmailItems(
      [
        { slug: "not-a-product", name: "FREE MONEY http://evil.example", quantity: 1, unitPrice: 1 },
        { slug: "", name: "no slug at all", quantity: 1, unitPrice: 1 },
        { name: "missing slug", quantity: 1, unitPrice: 1 } as { name: string; quantity: number; unitPrice: number },
        { slug: "tb-500", name: "whatever", quantity: 1, unitPrice: 1 },
      ],
      catalogue,
    );
    expect(items).toEqual([{ name: "TB-500", quantity: 1, unitPriceCents: 7900 }]);
  });

  it("keeps quantity as a bounded positive integer", () => {
    const bpc = { unitPriceCents: 6900, image: "https://vanta.test/bpc.jpg" };
    expect(recoveryEmailItems([{ slug: "bpc-157", name: "x", quantity: 999999, unitPrice: 1 }], catalogue)).toEqual([{ name: "BPC-157", quantity: 99, ...bpc }]);
    expect(recoveryEmailItems([{ slug: "bpc-157", name: "x", quantity: 2.9, unitPrice: 1 }], catalogue)).toEqual([{ name: "BPC-157", quantity: 2, ...bpc }]);
    expect(recoveryEmailItems([{ slug: "bpc-157", name: "x", quantity: 0, unitPrice: 1 }], catalogue)).toEqual([]);
    expect(recoveryEmailItems([{ slug: "bpc-157", name: "x", quantity: Number.NaN, unitPrice: 1 }], catalogue)).toEqual([]);
  });
});

describe("plainGreetingName", () => {
  it("keeps a real name, including accents, hyphens and apostrophes", () => {
    expect(plainGreetingName("Zoë O'Brien-Smith")).toBe("Zoë O'Brien-Smith");
    expect(plainGreetingName("  José   García ")).toBe("José García");
  });

  it("yields nothing for anything carrying a digit, an address or a URL — that is a message, not a name", () => {
    expect(plainGreetingName("URGENT call +1 555 0100 http://evil.example")).toBe("");
    expect(plainGreetingName("visit www.evil.example")).toBe("");
    expect(plainGreetingName("reply to me@evil.example")).toBe("");
    expect(plainGreetingName("<script>alert(1)</script>")).toBe("");
  });

  it("strips symbols and keeps at most three letter-bearing words", () => {
    expect(plainGreetingName("URGENT: call now!! (please) -- today")).toBe("URGENT call now");
    expect(plainGreetingName("<b>Sam</b>")).toBe("b Sam b");
  });

  it("is bounded and empties to nothing rather than a placeholder", () => {
    expect(plainGreetingName("A".repeat(200)).length).toBeLessThanOrEqual(40);
    expect(plainGreetingName("1234567890")).toBe("");
    expect(plainGreetingName("...")).toBe("");
    expect(plainGreetingName(null)).toBe("");
    expect(plainGreetingName(undefined)).toBe("");
  });
});
