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
const cartClient = read("src/app/cart/cart-client.tsx");
const quoteOrder = read("src/lib/quote-order.ts");
const catalogTypes = read("src/lib/catalog-types.ts");
const cartContext = read("src/components/cart-context.tsx");

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

// ---------------------------------------------------------------------------
// STOCK DEPTH IS NOT PUBLISHED.
//
// A customer may learn exactly one thing about stock: that an item is out of
// it. Counts, "only N left", low-stock nudges and remaining-quantity error
// messages are all disclosure of the owner's commercial position, and an error
// message that names a number is a binary-searchable inventory API for anyone
// who wants to measure the shop.
// ---------------------------------------------------------------------------
describe("no stock quantity reaches a customer", () => {
  it("the published availability figure is clamped before it leaves the server", () => {
    expect(catalog).toMatch(/function publishableAvailability/);
    expect(catalog).toMatch(/Math\.min\(available, MAX_UNITS_PER_ORDER_LINE\)/);
    // Both mapping sites go through the clamp, not raw sellable().
    expect(catalog).toMatch(/availableQuantity: inventoryActive\s*\n?\s*\?\s*publishableAvailability\(/);
    expect(catalog).toMatch(/:\s*publishableAvailability\(sellable\(productLevelQuantity, reservedQuantity\)\)/);
  });

  it("the raw on-hand count is never placed on a published catalog object", () => {
    // The public mappers must not assign inventoryQuantity at all — these
    // objects are handed to client components and end up in the page source.
    expect(catalog).not.toMatch(/^\s*inventoryQuantity:/m);
    expect(catalogTypes).toMatch(/inventoryQuantity\?: number/);
  });

  it("checkout reads real stock through a dedicated server-only function", () => {
    expect(catalog).toMatch(/export async function getStockLevelsBySlugs/);
    expect(quoteOrder).toMatch(/getStockLevelsBySlugs/);
    expect(quoteOrder).toMatch(/stockLevels\.get\(selectedDose\.id\)/);
  });

  it("the product page renders no count, only OUT OF STOCK", () => {
    expect(productDetail).not.toMatch(/\{availableQuantity\}/);
    expect(productDetail).not.toMatch(/available<\/span>|\} available/);
    expect(productDetail).not.toMatch(/Only \$\{maxSelectableQuantity\}/);
    expect(productDetail).toMatch(/isOutOfStock \? \(/);
  });

  it("the checkout oversell message names the item but not the count", () => {
    expect(quoteOrder).not.toMatch(/Only \$\{trackedInventory\}/);
    expect(quoteOrder).toMatch(/can't ship that many of \$\{product\.name\}/);
  });

  it("the reservation message never interpolates the remaining count", () => {
    expect(inventoryReservation).not.toMatch(/only \$\{line\.available\}/);
    expect(inventoryReservation).toMatch(/just sold out/);
  });

  it("the cart notice states the change, not the shelf depth", () => {
    expect(cartClient).not.toMatch(/only \$\{line\.allowed\}/);
    expect(cartClient).toMatch(/reduced \$\{label\} to the quantity we can ship/);
  });

  it("the cart validation response carries no availability figure", () => {
    const code = cartValidate.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    // `allowed` and `soldOut` are answers to "may I have this many"; `available`
    // would be an answer to "how many are there".
    expect(code).not.toMatch(/available:\s*match\.available/);
    expect(code).toMatch(/soldOut:\s*match\.available <= 0/);
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
    // Steps from the DISPLAYED quantity, not the stored one: they diverge once
    // the stored value exceeds what the selected dose can supply, and stepping
    // from the stored value made the buttons look dead.
    expect(productDetail).toMatch(/setQuantity\(Math\.min\(maxSelectableQuantity, quantity \+ 1\)\)/);
    expect(productDetail).toMatch(/setQuantity\(Math\.max\(1, quantity - 1\)\)/);
  });

  it("zero available disables add-to-cart independently of the stored status", () => {
    expect(productDetail).toMatch(/isTrackingAvailability && availableQuantity <= 0/);
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

// ---------------------------------------------------------------------------
// A DOSED PRODUCT IS ALWAYS BOUGHT AS A DOSE.
//
// ProductCard's "Add to Cart" on the catalogue grid has no dose picker, so it
// produced a cart line with a bare slug. Pricing was fine (the card shows the
// default dose's price) and quoteOrder's oversell guard even resolved the
// default dose — but the line ID it recorded did not, and that ID is what
// parseOrderItemRef() splits to choose WHICH ROW inventory moves on. So a grid
// purchase reserved and decremented `products` while the storefront reads
// `product_doses`: the shelf never went down and the same units could be sold
// over and over. Both halves are pinned here.
// ---------------------------------------------------------------------------
describe("a grid add resolves to the default dose", () => {
  it("the quote rebuilds the line id around the resolved dose", () => {
    expect(quoteOrder).toMatch(/id: selectedDose \? `\$\{slug\}::\$\{selectedDose\.id\}` : item\.id/);
  });

  it("the cart resolves the default dose when no variant was supplied", () => {
    expect(cartContext).toMatch(/const fallbackDose = !options\?\.variantId/);
    expect(cartContext).toMatch(/product\.doses\?\.find\(\(dose\) => dose\.isDefault\) \?\? product\.doses\?\.\[0\]/);
  });

  it("the cart line is built from the resolved dose, not the raw options", () => {
    // Reading `options` here instead of `resolved` is exactly how the variant
    // silently goes missing again.
    expect(cartContext).toMatch(/const variantKey = resolved\?\.variantId/);
    expect(cartContext).toMatch(/variantId: resolved\?\.variantId,/);
    expect(cartContext).toMatch(/doseLabel: resolved\?\.doseLabel,/);
  });

  it("an explicit variant still wins over the default", () => {
    // fallbackDose is only computed when options.variantId is absent.
    expect(cartContext).toMatch(/!options\?\.variantId/);
    expect(cartContext).toMatch(/\.\.\.options,/);
  });
});
