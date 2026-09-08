import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { BAC_WATER_SLUG, canonicalCartSlug } from "@/lib/bac-water";

// ---------------------------------------------------------------------------
// THE SOURCE OF THE DEAD-SLUG CARTS, NOT THE SYMPTOM.
//
// A cart lives in localStorage and outlives a rename. Production moved the
// vial from `bacteriostatic-water` to `bac-water`; every browser that had
// already added it kept writing the old slug — to storage, from storage to the
// tracking beacon, and from there into abandoned_carts. quoteOrder throws
// `Invalid product id` on a slug with no product row and fails the WHOLE
// quote, so those carts could not check out at all.
//
// Two live carts (Eli, $59.98; Eloa Rossetti, $227.46) were repaired by hand on
// 2026-09-06 and BOTH REVERTED inside a day. That is the proof that repairing
// rows is not a fix: the client kept re-posting the stale slug, so the repair
// only lasted until the shopper next touched their cart.
//
// The restore endpoint's reconciliation stays as defence in depth — for carts
// stored before this shipped, and for a future rename nobody remembers. This is
// the part that stops the bad value being written in the first place.
// ---------------------------------------------------------------------------

describe("canonicalCartSlug", () => {
  it("migrates every retired BAC Water slug to the canonical one", () => {
    expect(canonicalCartSlug("bacteriostatic-water")).toBe(BAC_WATER_SLUG);
    expect(canonicalCartSlug("bac-water-30ml")).toBe(BAC_WATER_SLUG);
    expect(canonicalCartSlug(BAC_WATER_SLUG)).toBe(BAC_WATER_SLUG);
  });

  // DELIBERATELY NOT A GENERAL "GUESS THE PRODUCT". Rewriting a slug the app
  // has no alias family for would silently move a shopper's line onto a
  // different product, which is worse than the line failing loudly.
  it.each(["glp-3", "bpc-157", "unknown-thing", "water", "bac", ""])(
    "leaves %o untouched", (slug) => {
      expect(canonicalCartSlug(slug)).toBe(slug);
    });

  it("trims, so a stored value with whitespace still migrates", () => {
    expect(canonicalCartSlug("  bacteriostatic-water  ")).toBe(BAC_WATER_SLUG);
  });

  it.each([null, undefined])("survives %o without throwing", (value) => {
    expect(canonicalCartSlug(value as unknown as string)).toBe("");
  });
});

// The migration is only worth anything if it runs where the cart is READ. A
// pure function nothing calls is the same bug with more code.
describe("the cart applies it on hydration", () => {
  const source = readFileSync(
    path.resolve(__dirname, "../components/cart-context.tsx"),
    "utf8",
  );

  it("sanitizeCartItems maps the stored slug through canonicalCartSlug", () => {
    const fn = source.slice(
      source.indexOf("function sanitizeCartItems"),
      source.indexOf("function isReferralValid"),
    );
    expect(fn).toContain("canonicalCartSlug(");
    // Not the raw stored value: that is the whole defect.
    expect(fn).not.toMatch(/const slug = typeof record\.slug === "string" \? record\.slug\.trim\(\) : ""/);
  });

  // The key embeds the slug. A migrated line that kept its old key would render
  // under the new slug while every lookup keyed on `key` still said the old
  // one, and the two halves would drift apart.
  it("migrates the stored line key alongside the slug", () => {
    const fn = source.slice(
      source.indexOf("function sanitizeCartItems"),
      source.indexOf("function isReferralValid"),
    );
    expect(fn).toContain("migratedKey");
  });
});
