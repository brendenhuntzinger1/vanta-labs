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
    const picked = selectStackImages(
      [{ image: null, coverImage: null }],
      3,
    );
    for (const image of picked) {
      expect(image.src).not.toMatch(/\/storage\/v1\/object\/public\/product-images\//);
    }
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
