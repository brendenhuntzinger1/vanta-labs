import { describe, expect, it, vi } from "vitest";

import {
  BAC_WATER_SLUG,
  BAC_WATER_SLUG_CANDIDATES,
  isBacWater,
  resolveBacWaterProduct,
} from "@/lib/bac-water";
import type { Product } from "@/lib/catalog-types";

// ---------------------------------------------------------------------------
// THE CROSS-SELL MUST FIND THE PRODUCT THE CATALOGUE ACTUALLY PUBLISHES.
//
// Reproduced in the browser. isBacWater() recognises TWO slugs, but the lookup
// route asked for exactly one:
//
//     isBacWater()  accepts {"bacteriostatic-water", "bac-water-30ml"}
//     route         queries BAC_WATER_SLUG = "bacteriostatic-water"
//
// With the store's BAC water published under the other accepted slug:
//
//     slug = bac-water-30ml        -> GET /api/catalog/bac-water  404
//     slug = bacteriostatic-water  -> GET /api/catalog/bac-water  200
//
// Renaming that one product flipped the endpoint from 404 to 200 with no other
// change. The failure is silent: the cart checkboxes, the accessory block and
// the "frequently bought together" nudge simply never render, and every page
// load logs a console error. Lost attach rate, no error surfaced to anyone.
//
// Two parts of the application must not disagree about which slug identifies
// this product. One list, used by both.
// ---------------------------------------------------------------------------

const product = (slug: string): Product =>
  ({
    id: `id-${slug}`,
    slug,
    name: "Bacteriostatic Water 30ml",
    category: "Solvents & Solutions",
    price: "$19.00",
    stockStatus: "In Stock",
    isPublished: true,
    isEnabled: true,
    isArchived: false,
    isFeatured: false,
    badge: null,
    position: 0,
    batchNumber: "",
    description: "",
    image: "",
    coverImage: "",
    galleryImages: [],
    doses: [],
    faq: [],
  }) as unknown as Product;

describe("the offered slug and the recognised slugs are one list", () => {
  it("every candidate the resolver will try is recognised as BAC water", () => {
    for (const slug of BAC_WATER_SLUG_CANDIDATES) {
      expect(isBacWater(slug)).toBe(true);
    }
  });

  it("the preferred slug is the first candidate", () => {
    expect(BAC_WATER_SLUG_CANDIDATES[0]).toBe(BAC_WATER_SLUG);
  });

  it("both slugs seen in the live catalogue are candidates", () => {
    expect([...BAC_WATER_SLUG_CANDIDATES]).toContain("bacteriostatic-water");
    expect([...BAC_WATER_SLUG_CANDIDATES]).toContain("bac-water-30ml");
  });
});

describe("resolving the published BAC water product", () => {
  it("returns the preferred slug when it is published", async () => {
    const lookup = vi.fn(async (slug: string) =>
      slug === "bacteriostatic-water" ? product(slug) : null,
    );

    const resolved = await resolveBacWaterProduct(lookup);

    expect(resolved?.slug).toBe("bacteriostatic-water");
    expect(lookup).toHaveBeenCalledWith("bacteriostatic-water");
  });

  it("falls back to the other published slug — the reproduced 404", async () => {
    // The exact reproduced state: only bac-water-30ml is published.
    const lookup = vi.fn(async (slug: string) =>
      slug === "bac-water-30ml" ? product(slug) : null,
    );

    const resolved = await resolveBacWaterProduct(lookup);

    expect(resolved).not.toBeNull();
    expect(resolved?.slug).toBe("bac-water-30ml");
  });

  it("stops at the first hit rather than querying every slug", async () => {
    const lookup = vi.fn(async (slug: string) => product(slug));

    await resolveBacWaterProduct(lookup);

    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it("returns null when the store genuinely publishes no BAC water", async () => {
    const lookup = vi.fn(async () => null);

    expect(await resolveBacWaterProduct(lookup)).toBeNull();
    expect(lookup).toHaveBeenCalledTimes(BAC_WATER_SLUG_CANDIDATES.length);
  });

  it("keeps looking when one lookup throws rather than failing the cross-sell", async () => {
    // A transient error on the first slug must not take out a cross-sell that
    // the second slug could still serve.
    const lookup = vi.fn(async (slug: string) => {
      if (slug === "bacteriostatic-water") throw new Error("transient");
      return product(slug);
    });

    const resolved = await resolveBacWaterProduct(lookup);

    expect(resolved?.slug).toBe("bac-water-30ml");
  });
});

// ---------------------------------------------------------------------------
// NEGATIVE CONTROL
//
// The old route was, in effect, `lookup(BAC_WATER_SLUG)` — a single call with
// no fallback. Modelled here so the fallback test above is proven to
// discriminate: the old shape returns null on precisely the catalogue state
// where the new one succeeds.
// ---------------------------------------------------------------------------
describe("negative control: the single-slug lookup really did 404", () => {
  const legacyLookup = async (
    lookup: (slug: string) => Promise<Product | null>,
  ) => lookup(BAC_WATER_SLUG);

  it("the old single-slug lookup returns nothing when only the other slug is published", async () => {
    const lookup = async (slug: string) => (slug === "bac-water-30ml" ? product(slug) : null);

    // This null is the 404 the browser saw on every page load.
    expect(await legacyLookup(lookup)).toBeNull();
    // The new resolver finds it on the same catalogue.
    expect((await resolveBacWaterProduct(lookup))?.slug).toBe("bac-water-30ml");
  });
});
