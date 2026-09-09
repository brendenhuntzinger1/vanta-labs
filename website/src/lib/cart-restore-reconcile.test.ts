import { describe, expect, it } from "vitest";
import { reconcileRestoredCart, type ReconcileCatalogueEntry } from "@/lib/cart-restore-reconcile";

// ---------------------------------------------------------------------------
// THE RECOVERY EMAIL USED TO DELIVER SHOPPERS INTO A CART THAT CANNOT PAY.
//
// Three links, each verified against the shipped code on 2026-09-07:
//
//   1. GET /api/cart/restore returned `cart.items` verbatim out of the
//      abandoned_carts snapshot, with no catalogue read at all.
//   2. POST /api/cart/validate checks INVENTORY, not existence, and says so:
//      "A row we cannot find is left alone rather than zeroed - an unknown line
//      is a lookup gap, not a sold-out product." So the dead line survives.
//   3. quoteOrder throws `Invalid product id: <slug>` for a line whose slug has
//      no product row (quote-order.ts:557) - and that throw fails the WHOLE
//      quote, not the line.
//
// So a shopper who clicked the one email designed to bring them back landed in
// a cart that refused to check out, quoting a slug at them, with no way to fix
// it themselves.
//
// It was live. `bacteriostatic-water` has no products row (only `bac-water`
// does) and two active carts held it: Eli ($59.98) and Eloa Rossetti ($227.46).
// Both had been repaired by hand the day before and BOTH REVERTED, because the
// repair only lasts until the shopper's browser writes the stale slug again.
// Repairing rows was treating the symptom; this reconciles at the point the
// cart is handed back, which is the last place we control before checkout.
//
// The rules below each mirror a specific quoteOrder refusal, deliberately: this
// function's job is to never hand back a cart quoteOrder would throw on.
// ---------------------------------------------------------------------------

const CATALOGUE = new Map<string, ReconcileCatalogueEntry>([
  ["bac-water", {
    slug: "bac-water",
    name: "Recon Water (0.9% Benzyl Alcohol)",
    unitPrice: 14.99,
    image: "/images/bac-water.jpg",
    doses: [
      { id: "bw-10", label: "10 mL", unitPrice: 14.99, image: "/images/bac-10.jpg" },
      { id: "bw-30", label: "30 mL", unitPrice: 24.99 },
    ],
  }],
  ["glp-3", { slug: "glp-3", name: "GLP-3", unitPrice: 113.99, doses: [] }],
]);

const aliases = (slug: string) => (slug === "bacteriostatic-water" ? ["bac-water"] : []);

describe("a line whose product no longer exists", () => {
  it("is dropped rather than handed to a checkout that would throw on it", () => {
    const result = reconcileRestoredCart(
      [{ slug: "retired-peptide", name: "Retired Peptide", quantity: 2, unitPrice: 99 }],
      CATALOGUE,
      aliases,
    );
    expect(result.items).toEqual([]);
    expect(result.dropped).toEqual([{ name: "Retired Peptide", reason: "unavailable" }]);
  });

  it("does not take the rest of the cart down with it", () => {
    const result = reconcileRestoredCart(
      [
        { slug: "glp-3", name: "GLP-3", quantity: 1, unitPrice: 113.99 },
        { slug: "retired-peptide", name: "Retired Peptide", quantity: 1, unitPrice: 99 },
      ],
      CATALOGUE,
      aliases,
    );
    expect(result.items.map((line) => line.slug)).toEqual(["glp-3"]);
    expect(result.dropped).toHaveLength(1);
  });

  // The stored name is the one the CLIENT posted to the tracking beacon, so it
  // is the only thing available for a line the catalogue cannot name - and it
  // is reported for display only, never re-added to the cart.
  it("falls back to the stored name so the shopper is told what went", () => {
    const result = reconcileRestoredCart(
      [{ slug: "retired-peptide", quantity: 1, unitPrice: 99 }],
      CATALOGUE,
      aliases,
    );
    expect(result.dropped[0].name).toBe("retired-peptide");
  });
});

describe("a renamed product follows its rename instead of dying", () => {
  it("repairs bacteriostatic-water to the canonical bac-water", () => {
    const result = reconcileRestoredCart(
      [{ slug: "bacteriostatic-water", name: "Recon Water", quantity: 1, unitPrice: 14.99 }],
      CATALOGUE,
      aliases,
    );
    expect(result.items).toHaveLength(1);
    expect(result.items[0].slug).toBe("bac-water");
    expect(result.dropped).toEqual([]);
    expect(result.repaired).toEqual([{ from: "bacteriostatic-water", to: "bac-water" }]);
  });

  it("takes the canonical product's name, not the one stored on the dead slug", () => {
    const result = reconcileRestoredCart(
      [{ slug: "bacteriostatic-water", name: "Whatever The Browser Said", quantity: 1, unitPrice: 1 }],
      CATALOGUE,
      aliases,
    );
    expect(result.items[0].name).toBe("Recon Water (0.9% Benzyl Alcohol)");
  });

  // A repaired line must not carry the OLD product's variant id across: dose
  // ids are per-product, so "bw-10" on a different product is exactly the
  // "size no longer available" refusal one rename later.
  it("drops a variant id that the repaired product does not have", () => {
    const result = reconcileRestoredCart(
      [{ slug: "bacteriostatic-water", variantId: "old-dose-id", name: "x", quantity: 1, unitPrice: 1 }],
      CATALOGUE,
      aliases,
    );
    expect(result.items).toEqual([]);
    expect(result.dropped[0].reason).toBe("variant_gone");
  });
});

describe("a dose that no longer resolves", () => {
  // quoteOrder refuses this too ("That size of X is no longer available"), and
  // for a sharper reason than a missing product: it used to fall back to the
  // default dose, so a 10 mL line was charged at the 30 mL price under a
  // different SKU. A cart we hand back must not contain one.
  it("is dropped, not silently swapped for the default", () => {
    const result = reconcileRestoredCart(
      [{ slug: "bac-water", variantId: "bw-99", name: "Recon Water", quantity: 1, unitPrice: 14.99 }],
      CATALOGUE,
      aliases,
    );
    expect(result.items).toEqual([]);
    expect(result.dropped).toEqual([{ name: "Recon Water (0.9% Benzyl Alcohol)", reason: "variant_gone" }]);
  });

  it("keeps a dose that still exists, priced from that dose", () => {
    const result = reconcileRestoredCart(
      [{ slug: "bac-water", variantId: "bw-30", name: "stale", quantity: 2, unitPrice: 9.99 }],
      CATALOGUE,
      aliases,
    );
    expect(result.items).toEqual([{
      slug: "bac-water", variantId: "bw-30", name: "Recon Water (0.9% Benzyl Alcohol)",
      quantity: 2, unitPrice: 24.99, image: "/images/bac-water.jpg",
    }]);
  });

  it("prefers the dose's own image when it has one", () => {
    const result = reconcileRestoredCart(
      [{ slug: "bac-water", variantId: "bw-10", name: "x", quantity: 1, unitPrice: 1 }],
      CATALOGUE,
      aliases,
    );
    expect(result.items[0].image).toBe("/images/bac-10.jpg");
  });

  it("a cart line naming no dose at all is left alone rather than assigned one", () => {
    const result = reconcileRestoredCart(
      [{ slug: "bac-water", name: "x", quantity: 1, unitPrice: 1 }],
      CATALOGUE,
      aliases,
    );
    expect(result.items[0].variantId).toBeUndefined();
    expect(result.items[0].unitPrice).toBe(14.99);
  });
});

describe("the price handed back is the live one", () => {
  // The t30m email says "at the same price". That sentence is about the cart
  // being HELD, not about a promise the till cannot keep: quoteOrder prices
  // from the catalogue whatever the snapshot says, so restoring a stale price
  // only means the cart page shows a number that changes at checkout.
  it("reprices a line whose stored unit price has drifted", () => {
    const result = reconcileRestoredCart(
      [{ slug: "glp-3", name: "GLP-3", quantity: 1, unitPrice: 89.99 }],
      CATALOGUE,
      aliases,
    );
    expect(result.items[0].unitPrice).toBe(113.99);
    expect(result.repricedCount).toBe(1);
  });

  it("does not count an unchanged price as a reprice", () => {
    const result = reconcileRestoredCart(
      [{ slug: "glp-3", name: "GLP-3", quantity: 1, unitPrice: 113.99 }],
      CATALOGUE,
      aliases,
    );
    expect(result.repricedCount).toBe(0);
  });
});

describe("quantities are bounded, because the stored one came from a browser", () => {
  it.each([
    [0, null], [-3, null], [Number.NaN, null], [1.7, 1], [3, 3],
  ])("stored %s becomes %s", (stored, expected) => {
    const result = reconcileRestoredCart(
      [{ slug: "glp-3", name: "GLP-3", quantity: stored as number, unitPrice: 113.99 }],
      CATALOGUE,
      aliases,
    );
    if (expected === null) expect(result.items).toEqual([]);
    else expect(result.items[0].quantity).toBe(expected);
  });

  it("clamps a line above the per-order ceiling instead of refusing it", () => {
    const result = reconcileRestoredCart(
      [{ slug: "glp-3", name: "GLP-3", quantity: 9999, unitPrice: 113.99 }],
      CATALOGUE,
      aliases,
    );
    expect(result.items[0].quantity).toBeLessThanOrEqual(10);
    expect(result.items[0].quantity).toBeGreaterThan(0);
  });
});

describe("the shape of the answer", () => {
  it("reports an empty cart when every line died", () => {
    const result = reconcileRestoredCart(
      [{ slug: "gone-a", name: "A", quantity: 1, unitPrice: 1 },
       { slug: "gone-b", name: "B", quantity: 1, unitPrice: 1 }],
      CATALOGUE,
      aliases,
    );
    expect(result.items).toEqual([]);
    expect(result.dropped.map((d) => d.name)).toEqual(["A", "B"]);
  });

  it("is a no-op on a cart that is entirely healthy", () => {
    const stored = [
      { slug: "glp-3", name: "GLP-3", quantity: 2, unitPrice: 113.99 },
      { slug: "bac-water", variantId: "bw-10", name: "Recon Water (0.9% Benzyl Alcohol)", quantity: 1, unitPrice: 14.99, image: "/images/bac-10.jpg" },
    ];
    const result = reconcileRestoredCart(stored, CATALOGUE, aliases);
    expect(result.dropped).toEqual([]);
    expect(result.repaired).toEqual([]);
    expect(result.repricedCount).toBe(0);
    expect(result.items).toHaveLength(2);
  });

  // Junk in the snapshot is a beacon that posted nonsense, not a cart.
  it("ignores lines with no usable slug", () => {
    const result = reconcileRestoredCart(
      [{ name: "no slug", quantity: 1, unitPrice: 1 }, { slug: "   ", quantity: 1, unitPrice: 1 }],
      CATALOGUE,
      aliases,
    );
    expect(result.items).toEqual([]);
    expect(result.dropped).toEqual([]);
  });
});
