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

const { recoveryEmailItems, reconciledCartValueCents } = await import("@/lib/cart-recovery");

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

// ---------------------------------------------------------------------------
// THE CART IS WORTH WHAT THE EMAIL SAYS IT IS WORTH.
//
// recoveryEmailItems reconciles a cart against the live catalogue; the stored
// `cart_value_cents` is a snapshot from whenever the beacon fired. Two things
// read the cart's value afterwards — the total printed under the summary, and
// the BAND that decides the gift — and both were reading the snapshot. A cart
// stored at $519.90 whose surviving lines came to $95.98 was mailed a total it
// contradicted, and drew the top band's three free products on a basket that
// never qualified. Found by walking a real top-band cart through the sweep.
// ---------------------------------------------------------------------------
describe("reconciledCartValueCents", () => {
  it("values the cart at the lines that survived reconciliation, not the snapshot", () => {
    const items = recoveryEmailItems(
      [
        { slug: "retired-product", name: "gone", quantity: 4, unitPrice: 109.99 },
        { slug: "bpc-157", name: "x", quantity: 2, unitPrice: 1 },
      ],
      catalogue,
    );
    expect(reconciledCartValueCents(items, 51_990)).toBe(13_800);
  });

  it("uses live prices, so a repriced product moves the total the shopper is shown", () => {
    const items = recoveryEmailItems([{ slug: "tb-500", name: "x", quantity: 3, unitPrice: 0.01 }], catalogue);
    expect(reconciledCartValueCents(items, 3)).toBe(23_700);
  });

  // A partial sum would UNDERSTATE the cart, and understating it demotes a real
  // basket to a smaller band — the opposite mistake, made for the same reason.
  it("keeps the stored figure when any surviving line has no live price", () => {
    const priceless = new Map([...catalogue, ["no-price", { name: "No Price", unitPriceCents: 0 }]]);
    const items = recoveryEmailItems(
      [{ slug: "bpc-157", name: "x", quantity: 1, unitPrice: 1 }, { slug: "no-price", name: "y", quantity: 1, unitPrice: 1 }],
      priceless,
    );
    expect(reconciledCartValueCents(items, 42_000)).toBe(42_000);
  });

  it("keeps the stored figure for a cart with nothing left in it", () => {
    expect(reconciledCartValueCents([], 42_000)).toBe(42_000);
  });

  it.each([Number.NaN, Number.NEGATIVE_INFINITY, -1])("never reports a negative or unreal value (%s)", (stored) => {
    expect(reconciledCartValueCents([], stored as number)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// A PRODUCT DOES NOT HAVE ONE PRICE, AND THE CART LINES KNOW WHICH ONE.
//
// Every abandoned cart in this store carries a `variantId` per line — the dose
// the shopper picked. The catalogue entry used to carry only the product's
// headline figure, so a real cart holding three GLP-3 at $169.99 was described
// at $49.99 each: a third of what that shopper had in front of them, in the
// email asking them to come back and pay it.
//
// Once cart value chose the offer band it stopped being a display bug. A
// $524.96 basket priced at $164.96 falls two bands, so the biggest carts in the
// store would have drawn the small-cart gift — the exact sale the top band was
// built to win back.
// ---------------------------------------------------------------------------
describe("a line names a dose, and the dose has its own price", () => {
  const doses = new Map([
    ["glp-3", {
      name: "GLP-3",
      unitPriceCents: 4_999,
      variantPriceCents: new Map([["dose-10mg", 4_999], ["dose-30mg", 16_999]]),
      variantLabel: new Map([["dose-10mg", "10mg"], ["dose-30mg", "30mg"]]),
    }],
  ]);

  it("prices the dose the shopper chose, not the one the product leads with", () => {
    const items = recoveryEmailItems([{ slug: "glp-3", name: "x", quantity: 3, unitPrice: 1, variantId: "dose-30mg" }], doses);
    expect(items[0].unitPriceCents).toBe(16_999);
    expect(reconciledCartValueCents(items, 48_416)).toBe(50_997);
  });

  it("qualifies the name with the dose, so the summary says which one", () => {
    const items = recoveryEmailItems([{ slug: "glp-3", name: "x", quantity: 1, unitPrice: 1, variantId: "dose-30mg" }], doses);
    expect(items[0].name).toBe("GLP-3 30mg");
  });

  it("does not repeat a dose already in the product's name", () => {
    const named = new Map([["ghk-cu", {
      name: "GHK-Cu 50mg", unitPriceCents: 3_999,
      variantPriceCents: new Map([["d", 3_999]]), variantLabel: new Map([["d", "50mg"]]),
    }]]);
    const items = recoveryEmailItems([{ slug: "ghk-cu", name: "x", quantity: 1, unitPrice: 1, variantId: "d" }], named);
    expect(items[0].name).toBe("GHK-Cu 50mg");
  });

  // "BPC-157 10mg 5mg" — a product NAMED after one of its doses, selling
  // another. Two contradictory strengths on one line is worse than no label at
  // all, so any dose token in the name suppresses the suffix, not just this
  // dose's own. Seen on the harness the first time a variant line was priced.
  it("adds no dose when the name already states a different one", () => {
    const odd = new Map([["bpc-157-10mg", {
      name: "BPC-157 10mg", unitPriceCents: 6_900,
      variantPriceCents: new Map([["d5", 4_900]]), variantLabel: new Map([["d5", "5mg"]]),
    }]]);
    const items = recoveryEmailItems([{ slug: "bpc-157-10mg", name: "x", quantity: 2, unitPrice: 1, variantId: "d5" }], odd);
    expect(items[0].name).toBe("BPC-157 10mg");
    expect(items[0].unitPriceCents).toBe(4_900);
  });

  it("still uses the product price for a line that names no variant", () => {
    const items = recoveryEmailItems([{ slug: "glp-3", name: "x", quantity: 1, unitPrice: 1 }], doses);
    expect(items[0].unitPriceCents).toBe(4_999);
  });

  // THE SAFE DIRECTION, DELIBERATELY. A dose this code cannot find leaves the
  // line unpriced, which makes the whole cart fall back to its stored value —
  // so an unresolvable variant can never shrink a large cart into a smaller
  // offer band. Losing a figure on one line is recoverable; losing the sale is
  // not.
  it("leaves a line unpriced when its dose cannot be resolved, and keeps the stored cart value", () => {
    const items = recoveryEmailItems([{ slug: "glp-3", name: "x", quantity: 3, unitPrice: 1, variantId: "dose-that-went-away" }], doses);
    expect(items[0].unitPriceCents).toBeUndefined();
    expect(items[0].name).toBe("GLP-3");
    expect(reconciledCartValueCents(items, 48_416)).toBe(48_416);
  });
});
