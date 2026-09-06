import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { selectStackImages } from "@/components/wholesale-vial-stack";

// ---------------------------------------------------------------------------
// THE PUBLIC WHOLESALE PAGE MUST NOT SHIP PRODUCT IMAGERY TO A SIGNED-OUT
// REQUESTER.
//
// /wholesale is public by design — a prospective bulk buyer has no account yet,
// so gating it would end recruitment (see access-policy.ts). But the page's
// decorative "vial stacks" are composed from REAL catalogue photography, and an
// <Image> src is a real product-image storage URL. Stripping the compound name
// from the alt text stops a NAME leaking; the URL itself is still catalogue data
// the owner asked not to hand out before login ("Do not expose real product
// imagery before login"). The product-images bucket stays public (a held URL
// still resolves; that residual is accepted), but the application must never
// HAND OUT those URLs before authentication.
//
// The fix reads the catalogue only for a signed-in requester; signed out, the
// stack gets no images and the page renders its typographic fallback. These
// tests lock both halves so a later edit cannot quietly reopen the leak.
// ---------------------------------------------------------------------------

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

describe("selectStackImages: no products means no imagery", () => {
  it("returns nothing for an empty catalogue, so the anonymous page shows type, not vials", () => {
    expect(selectStackImages([], 3)).toEqual([]);
    expect(selectStackImages([])).toEqual([]);
  });

  it("skips placeholders, so a catalogue with only placeholder art still emits no storage URL", () => {
    // ASSERTED ON THE RESULT, NOT INSIDE A LOOP OVER IT.
    //
    // This read `for (const image of picked) expect(...)`. resolveProductImage
    // maps a null to the placeholder, which this function skips, so `picked` is
    // empty and the loop body never ran: the assertion held over nothing, and
    // would have held just as well if the function had returned a storage URL
    // under a different shape. An empty array is the claim, so it is the thing
    // asserted.
    expect(selectStackImages([{ image: null, coverImage: null }], 3)).toEqual([]);
    expect(selectStackImages([{ image: "/images/product-placeholder.png", coverImage: null }], 3)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// THE POSITIVE CONTROL, WITHOUT WHICH EVERY TEST ABOVE PASSES ON A DEAD PAGE.
//
// Everything above asserts that NOTHING is emitted. `selectStackImages` could
// be replaced with `() => []` tomorrow and the whole suite would stay green
// while the signed-in composition — the thing the owner asked to keep — was
// silently gone. A leak test that cannot tell "closed" from "broken" is only
// half a test.
// ---------------------------------------------------------------------------
describe("a signed-in render still gets the composition", () => {
  const REAL = [
    { image: null, coverImage: "https://example.supabase.co/storage/v1/object/public/product-images/a.png" },
    { image: "https://example.supabase.co/storage/v1/object/public/product-images/b.png", coverImage: null },
    { image: null, coverImage: "https://example.supabase.co/storage/v1/object/public/product-images/c.png" },
    { image: null, coverImage: "https://example.supabase.co/storage/v1/object/public/product-images/d.png" },
  ];

  it("returns real photography when the catalogue has some", () => {
    const picked = selectStackImages(REAL, 3);
    expect(picked).toHaveLength(3);
    expect(picked.map((i) => i.src)).toEqual([
      "https://example.supabase.co/storage/v1/object/public/product-images/a.png",
      "https://example.supabase.co/storage/v1/object/public/product-images/b.png",
      "https://example.supabase.co/storage/v1/object/public/product-images/c.png",
    ]);
  });

  it("prefers the cover image and honours the limit", () => {
    expect(selectStackImages(REAL, 1).map((i) => i.src)).toEqual([
      "https://example.supabase.co/storage/v1/object/public/product-images/a.png",
    ]);
  });

  it("does not stack the same photograph twice", () => {
    const same = "https://example.supabase.co/storage/v1/object/public/product-images/a.png";
    expect(selectStackImages([{ coverImage: same }, { coverImage: same }, { coverImage: same }], 3))
      .toEqual([{ src: same }]);
  });

  it("drops placeholders from a mixed catalogue rather than the whole stack", () => {
    const real = "https://example.supabase.co/storage/v1/object/public/product-images/e.png";
    expect(selectStackImages([{ coverImage: null }, { coverImage: real }], 3)).toEqual([{ src: real }]);
  });
});

describe("the wholesale page reads the catalogue only behind authentication", () => {
  const src = read("src/app/wholesale/page.tsx");
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\*.*$/gm, " ")
    .replace(/\/\/.*$/gm, " ");

  it("verifies the requester before touching the catalogue", () => {
    expect(code).toContain("getAuthenticatedUser");
    expect(code).toMatch(/user\s*\?\s*await\s+getCatalogProducts\(\)/);
  });

  it("never calls getCatalogProducts() unconditionally", () => {
    expect(code).not.toMatch(/const\s+products\s*=\s*await\s+getCatalogProducts\(/);
  });

  it("is force-dynamic, so the signed-out render is never cached and replayed", () => {
    expect(code).toMatch(/export const dynamic\s*=\s*["']force-dynamic["']/);
  });
});
