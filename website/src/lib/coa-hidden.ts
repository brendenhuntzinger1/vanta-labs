import { BAC_WATER_SLUG_CANDIDATES } from "@/lib/bac-water";

// -------------------------------------------------------------------------
// PRODUCTS KEPT OUT OF THE PUBLIC COA LIBRARY.
//
// Some products were never sent for testing — recon water is a
// solvent, and the HGH and HCG lines were not part of the batch submitted to
// the laboratory. Listing them as "Documentation Pending" beside the tested
// compounds reads as a promise of a report that is not coming, so the owner
// can take any product off the library entirely from /admin/coa.
//
// The list is an admin setting (section `coa`, key `hidden_product_slugs`).
// Until one has been saved, the default below applies, which is what makes
// the removal land the day it deploys rather than after a trip to admin.
//
// Client-safe: no server imports, so the admin page, the public library and
// the tests can all pull from the same list.
// -------------------------------------------------------------------------

/**
 * The HGH and HCG lines, by slug.
 *
 * `hgh-191aa` is the retired HGH row that `reconcile-catalog.sql` maps onto
 * `hgh-gh-191`. It is unpublished today, but it is one `is_published` flip
 * away from a live product page, and the library should not start listing it
 * on a technicality.
 *
 * This used to be borrowed from a pending-testing list in coa-pending.ts.
 * That list is gone — every undocumented compound is now told the same thing
 * (its certificate is on its way back from the laboratory), so the only thing
 * these slugs still decide is which library cards stay hidden until the owner
 * chooses otherwise from /admin/coa.
 */
const UNTESTED_LINE_SLUGS = ["hgh-gh-191", "hgh-191aa", "hcg"] as const;

/**
 * Hidden until the owner says otherwise.
 *
 * The HGH and HCG slugs above, plus every accepted bacteriostatic-water slug
 * from the cross-sell — one place per product, no third copy to fall out of
 * date.
 */
export const DEFAULT_COA_HIDDEN_PRODUCT_SLUGS: readonly string[] = Array.from(
  new Set<string>([...UNTESTED_LINE_SLUGS, ...BAC_WATER_SLUG_CANDIDATES]),
);

/** Enough for every product the store could plausibly carry; not a place to store junk. */
const MAX_HIDDEN_SLUGS = 200;

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,119}$/;

/**
 * The saved setting, cleaned — or null when there is no saved setting.
 *
 * Null and an empty list mean different things and the caller must keep them
 * apart: null is "the owner has never chosen", so the default applies; `[]` is
 * "the owner cleared every box", so nothing is hidden. A value that is not a
 * list at all counts as unset rather than as an empty list, so a corrupted
 * setting can only ever show the default, never silently unhide everything.
 */
export function normalizeCoaHiddenProductSlugs(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;

  const seen = new Set<string>();
  for (const value of raw) {
    if (typeof value !== "string") continue;
    const slug = value.trim().toLowerCase();
    if (!slug || !SLUG_PATTERN.test(slug)) continue;
    seen.add(slug);
    if (seen.size >= MAX_HIDDEN_SLUGS) break;
  }
  return Array.from(seen);
}

/**
 * Is this product on the hidden list?
 *
 * Slug only, never name. Hiding is a per-product decision the owner makes by
 * ticking a box next to a specific product, and a name match would extend that
 * decision to products they never looked at.
 */
export function isCoaProductHidden(
  product: { slug?: string | null } | string | null | undefined,
  hiddenSlugs: readonly string[],
): boolean {
  if (hiddenSlugs.length === 0) return false;
  const slug = (typeof product === "string" ? product : product?.slug ?? "").trim().toLowerCase();
  if (!slug) return false;
  return hiddenSlugs.includes(slug);
}
