import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// INVENTORY VISIBILITY — the storefront must agree with the database.
//
// The defect these tests pin down: the owner saved a count in /admin/inventory
// and the product page kept showing the old one. The catalog reads are wrapped
// in unstable_cache with a 60s TTL and the shared "catalog" tag, and NOTHING
// ever revalidated that tag — the comment in catalog.ts claimed admin mutations
// did, but no call existed anywhere in src/. The only thing that ever cleared
// the cache was the TTL lapsing, and because time-based revalidation is
// stale-while-revalidate, even the first request after it lapsed still served
// the stale numbers.
//
// These are structural assertions against the source. They are deliberately
// coarse — their job is to fail loudly if a future edit removes the
// invalidation or reintroduces on-hand-instead-of-available arithmetic, which
// is exactly the class of regression that would silently return the site to
// the broken behaviour with every unit test still green.
// ---------------------------------------------------------------------------

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

const catalogCache = read("src/lib/catalog-cache.ts");
const catalog = read("src/lib/catalog.ts");
const adminInventory = read("src/lib/admin-inventory.ts");
const inventoryOperations = read("src/lib/inventory-operations.ts");
const inventoryFulfillment = read("src/lib/inventory-fulfillment.ts");
const inventoryReservation = read("src/lib/inventory-reservation.ts");
const adminProducts = read("src/lib/admin-products.ts");
const productDetail = read("src/components/product-detail-client.tsx");
const cartValidate = read("src/app/api/cart/validate/route.ts");

describe("cache invalidation exists and is reachable from every write path", () => {
  it("invalidateCatalogCache actually calls revalidateTag on the catalog tag", () => {
    expect(catalogCache).toContain('import { revalidateTag } from "next/cache"');
    expect(catalogCache).toMatch(/revalidateTag\(CATALOG_CACHE_TAG/);
  });

  it("expires immediately rather than marking stale", () => {
    // `"max"` is stale-while-revalidate: the next visitor still gets the OLD
    // number. Read-your-own-writes needs a hard expiry.
    expect(catalogCache).toMatch(/revalidateTag\(CATALOG_CACHE_TAG,\s*\{\s*expire:\s*0\s*\}\)/);
    expect(catalogCache).not.toMatch(/revalidateTag\([^)]*"max"/);
  });

  it("never throws — a failed invalidation must not fail the write that succeeded", () => {
    expect(catalogCache).toMatch(/try\s*\{[\s\S]*revalidateTag[\s\S]*\}\s*catch/);
  });

  const writePaths: Array<[string, string]> = [
    ["manual admin save", adminInventory],
    ["stock operations (receive / damage / recount)", inventoryOperations],
    ["order decrement + refund restock", inventoryFulfillment],
    ["reserve / finalize / release / expire", inventoryReservation],
    ["product + dose edits", adminProducts],
  ];

  for (const [label, source] of writePaths) {
    it(`${label} invalidates the catalog`, () => {
      expect(source).toContain('from "@/lib/catalog-cache"');
      expect(source).toContain("invalidateCatalogCache()");
    });
  }
});

describe("the storefront reports availability, not stock on hand", () => {
  it("catalog exposes availableQuantity computed through sellable()", () => {
    expect(catalog).toMatch(/availableQuantity:\s*inventoryActive[\s\S]{0,160}sellable\(/);
  });

  it("availableQuantity is null — not 0 — when tracking is off", () => {
    // "not counted" and "none left" are different claims. Collapsing them would
    // put OUT OF STOCK on an untracked catalogue.
    expect(catalog).toMatch(/availableQuantity:\s*inventoryActive\s*\?/);
    expect(catalog).toMatch(/availableQuantity:\s*!inventoryActive\s*\n?\s*\?\s*null/);
  });
});

describe("purchase controls respect what is actually on the shelf", () => {
  it("the quantity ceiling comes from availability, not just the bundle max", () => {
    expect(productDetail).toMatch(/maxSelectableQuantity\s*=\s*isTrackingAvailability/);
    expect(productDetail).toMatch(/Math\.min\(MAX_BUNDLE_QUANTITY,\s*Math\.max\(0,\s*availableQuantity\)\)/);
  });

  it("the chosen quantity is clamped at render, not corrected in an effect", () => {
    // An effect-based correction renders the too-large number first, and a
    // rendered number can be clicked.
    expect(productDetail).toMatch(/const quantity = maxSelectableQuantity > 0/);
    expect(productDetail).toMatch(/Math\.min\(requestedQuantity,\s*maxSelectableQuantity\)/);
  });

  it("bundle tiers larger than the shelf are disabled", () => {
    expect(productDetail).toMatch(/const exceedsStock = option\.quantity > maxSelectableQuantity/);
    expect(productDetail).toMatch(/disabled=\{exceedsStock\}/);
  });

  it("the + button stops at the ceiling", () => {
    expect(productDetail).toMatch(/disabled=\{quantity >= maxSelectableQuantity\}/);
    expect(productDetail).toMatch(/setQuantity\(\(q\) => Math\.min\(maxSelectableQuantity, q \+ 1\)\)/);
  });

  it("zero available disables add-to-cart independently of the stored status", () => {
    expect(productDetail).toMatch(/isTrackingAvailability && availableQuantity <= 0/);
  });

  it("a count is shown only when availability is genuinely counted", () => {
    expect(productDetail).toMatch(/isTrackingAvailability \?/);
    expect(productDetail).toContain("available");
  });
});

describe("cart re-validation fails open and never invents a shortfall", () => {
  it("returns untouched quantities when tracking is off", () => {
    expect(cartValidate).toMatch(/if \(!tracking\)/);
    expect(cartValidate).toMatch(/allowed: line\.requested/);
  });

  it("a lookup error degrades to 'everything is fine' rather than emptying carts", () => {
    expect(cartValidate).toMatch(/if \(doseResult\.error \|\| productResult\.error\)/);
    expect(cartValidate).toMatch(/degraded: true/);
  });

  it("an unmatched line is left alone rather than zeroed", () => {
    expect(cartValidate).toMatch(/if \(!match\)[\s\S]{0,120}allowed: line\.requested/);
  });

  it("availability is net of reservations, matching the product page", () => {
    expect(cartValidate).toMatch(/Number\(onHand \?\? 0\) - Number\(reserved \?\? 0\)/);
  });

  it("takes no holds — it is read-only by construction", () => {
    // Strip comments first: the prose explains that the binding hold is taken
    // elsewhere, and that explanation must not read as a mutation.
    const code = cartValidate.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    expect(code).not.toMatch(/\.insert\(|\.update\(|\.delete\(|\.rpc\(/);
  });
});

describe("admin saves are exact and absolute", () => {
  it("0 is stored as 0, not treated as missing", () => {
    // Math.max(0, Math.round(q)) on a validated finite number: 0 survives.
    expect(adminInventory).toMatch(/const quantity = Math\.max\(0, Math\.round\(q\)\)/);
    expect(adminInventory).toMatch(/updatePayload\.inventory_quantity = quantity/);
  });

  it("non-numeric input is rejected rather than written as NaN", () => {
    expect(adminInventory).toMatch(/if \(!Number\.isFinite\(q\)\)[\s\S]{0,120}throw new Error/);
  });

  it("every manual save writes an audit row with before and after", () => {
    expect(adminInventory).toMatch(/recordInventoryTransaction\(\{[\s\S]{0,400}quantityBefore/);
    expect(adminInventory).toMatch(/quantityAfter: after/);
  });
});
