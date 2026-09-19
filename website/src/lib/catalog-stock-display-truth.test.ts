import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// WHAT THE SHOPPER IS TOLD ABOUT STOCK COMES FROM THE DOSE, BY RULE RATHER THAN
// BY LUCK.
//
// THE PRODUCTION STATE THAT PROMPTED THIS (2026-09-19, all 34 live products and
// 46 live doses scanned, not sampled, with inventory.tracking_enabled = true):
//
//   dose rows        46 live, 45 declaring track_inventory, 0 null quantities,
//                    exactly 1 tracked dose at zero (MOTS-C 10mg),
//                    0 stocked-but-labelled-out, 0 empty-but-labelled-in
//                    -> internally consistent, every one of them
//
//   product rows     3 of 34 disagreed with their own doses:
//                    DSIP   stored "Out of Stock", dose held 19 units
//                    SS-31  stored "Out of Stock", dose held 18 units
//                    MOTS-C stored "In Stock",     dose held 0
//
// `products.stock_status` is a denormalised copy of what the doses know, and
// the copy has drifted on three rows. It is the doses that are authoritative.
//
// NO CUSTOMER SAW THE STALE COPY, and this file does not pretend otherwise. The
// expression it replaces —
//
//     resolveStockStatus(String(defaultDose?.stockStatus ?? row.stock_status …
//
// reaches `row.stock_status` only when the dose's own status is nullish, and a
// mapped dose always carries one. Every one of the 34 live products has an
// enabled default dose, so the stale column was already being shadowed.
//
// It was shadowed by accident of ordering, though, not by rule: any future
// change that let a dose's status be absent would drop straight through to the
// stale copy, and DSIP and SS-31 would publish "Out of Stock" over 37 sellable
// vials. So the rule is now stated outright — with a dose present the headline
// IS that dose's already-resolved status — and the product column is read only
// for a product that has no dose at all.
//
// THIS IS A DISPLAY PATH AND NOTHING ELSE, AND IT CHANGES NO BEHAVIOUR TODAY.
// Checkout's reservation is a separate server-side guard and was already
// correct — a zero-count dose is refused there with "MOTS-C 10mg just sold out.
// Please adjust your cart and try again." Nothing here weakens it.
// ---------------------------------------------------------------------------

/**
 * Comments are stripped before any "must not contain" check, the same
 * convention cart-cannot-price-itself.test.ts uses. Without it these
 * assertions fail on the prose ABOVE them that names the very expression they
 * forbid — a test that cannot describe the bug it prevents.
 */
const withoutComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ").replace(/\/\/.*$/gm, " ");

const RAW = readFileSync(join(process.cwd(), "src", "lib", "catalog.ts"), "utf8");
const SOURCE = withoutComments(RAW);

describe("a product's headline status comes from its dose, never from the stale column", () => {
  it("does not fall back to products.stock_status while a dose exists", () => {
    // The exact expression that COULD have carried DSIP's and SS-31's stale
    // label to the catalogue card, the "In Stock" filter and the Product
    // JSON-LD, had a dose ever arrived without a status of its own.
    expect(
      SOURCE,
      "the product-level fallback to row.stock_status is back; a stale column can reach the customer again",
    ).not.toContain("defaultDose?.stockStatus ?? row.stock_status");
  });

  it("uses the dose's already-resolved status directly", () => {
    expect(RAW).toContain("defaultDose.stockStatus ?? \"In Stock\"");
  });

  it("keeps a real fallback for a product that genuinely has no dose", () => {
    // Every live product has one today, but removing the branch would make a
    // dose-less product crash rather than degrade.
    const block = RAW.slice(RAW.indexOf("const defaultDoseStatus"));
    expect(block.slice(0, 400)).toContain("String(row.stock_status ?? \"In Stock\")");
  });
});

describe("the store-wide tracking flag keeps its escape hatch", () => {
  // Deliberately NOT hardened against the per-row track_inventory flag. Turning
  // inventory.tracking_enabled off is the documented rollback if stored counts
  // ever strand the catalogue, and it has to keep working for every row —
  // including the 45 that declare counts of their own.
  it("short-circuits to In Stock on the store-wide flag alone", () => {
    const fn = RAW.slice(RAW.indexOf("function resolveStockStatus"));
    expect(fn.slice(0, 400)).toContain("if (!inventoryActive) {");
  });

  it("still honours a zero count as Out of Stock once tracking is on", () => {
    expect(SOURCE).toContain('return "Out of Stock";');
    expect(SOURCE).toMatch(/quantity <= 0/);
  });
});

describe("the display path does not reach into checkout", () => {
  it("resolveStockStatus is not used to decide whether an order may be placed", () => {
    // It is a catalogue-read helper. If it ever appears in the checkout or the
    // reservation path, the server-side guard has been made to depend on a
    // presentation decision.
    for (const file of [
      "src/app/api/checkout/create-session/route.ts",
      "src/lib/quote-order.ts",
    ]) {
      const contents = withoutComments(readFileSync(join(process.cwd(), file), "utf8"));
      expect(contents, `${file} now depends on the display helper`).not.toContain("resolveStockStatus");
    }
  });
});

describe("an empty product's buy button is the product's own, and it is disabled", () => {
  const PDP = readFileSync(join(process.cwd(), "src", "components", "product-detail-client.tsx"), "utf8");

  it("both add-to-cart controls are gated on isOutOfStock", () => {
    // The page CTA and the mobile sticky bar. Either one left ungated sells a
    // product the checkout will then refuse.
    expect(withoutComments(PDP).match(/disabled=\{isOutOfStock\}/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it("carries data-vl-cta so a browser check can address them", () => {
    // Not cosmetic. The Related Products rail on every PDP carries live
    // "Add to Cart" buttons for other items, so a check that scans the page for
    // an enabled one reports an out-of-stock product as addable — which it did,
    // and which read exactly like a defect in the page. Remove these and the
    // browser suite goes quietly back to answering the wrong question.
    expect(PDP).toContain('data-vl-cta="primary"');
    expect(PDP).toContain('data-vl-cta="sticky"');
  });

  it("still derives isOutOfStock from the selected dose, not the product row", () => {
    const block = withoutComments(PDP).slice(withoutComments(PDP).indexOf("const isOutOfStock"));
    expect(block.slice(0, 260)).toContain('selectedStockStatus === "Out of Stock"');
    expect(block.slice(0, 260)).toContain("availableQuantity <= 0");
  });
});
