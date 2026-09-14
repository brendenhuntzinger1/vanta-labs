import { isBacWater } from "@/lib/bac-water";

// -------------------------------------------------------------------------
// PRODUCTS WHOSE CERTIFICATE OF ANALYSIS IS STILL AT THE LABORATORY.
//
// A product with no published COA used to be handled two ways. A hand-kept
// list of slugs got an explanation ("batch COA in progress") on the product
// page and in the library; everything else got a bare "not published yet" —
// or, on the catalogue card, nothing at all: no pill, no action, the one card
// in the grid with something missing on the signal a research buyer scans for
// first.
//
// The owner's rule now: every card looks the same. A compound without a
// document says its certificate is on its way back from the laboratory and
// where to ask in the meantime. So this is no longer a list; it is a rule —
// any product that is not a solvent. Recon water is bacteriostatic water, was
// never sent for testing, and must not start claiming a report that is not
// coming.
//
// Client-safe: no server imports, so the catalogue card, the public library,
// the product page and tests all pull from the same rule and the same copy.
// -------------------------------------------------------------------------

/**
 * May the store say this product's certificate is on its way?
 *
 * Callers must already know the product has no published COA — this says
 * whether an undocumented product gets the "returning from the laboratory"
 * treatment, not whether a product is undocumented. Every compound does; a
 * solvent never does. The solvent check reads the name as well as the slug,
 * because matching too MUCH is the safe direction here: the cost of a false
 * match is a solvent that stays quiet about a COA it was never going to have.
 */
export function isCoaTestingPending(
  product: { slug?: string | null; name?: string | null } | string | null | undefined,
): boolean {
  const slug = (typeof product === "string" ? product : product?.slug ?? "").trim().toLowerCase();
  const name = (typeof product === "string" ? "" : product?.name ?? "").trim();
  if (!slug && !name) return false;
  return !isBacWater({ slug, name });
}

/** Where a shopper with a question about a batch is sent. The footer's address. */
export const COA_SUPPORT_EMAIL = "support@vantalabsresearch.com";

/**
 * THE COPY, IN ONE PLACE.
 *
 * The catalogue card's dialog, the COA library card and the product page's
 * COA tab all render it, so the three can never drift — and changing what the
 * store says about an undocumented product is a one-line edit here rather
 * than a hunt through three components.
 *
 * Two wording constraints, both learned by reading the rendered page rather
 * than the source:
 *
 * 1. It says the BATCH certificate is on its way, not that the compound is
 *    untested. On the product page this sits beside `CoaLibraryNotice`, which
 *    states that current inventory comes from batches its supplier has
 *    third-party tested. What is missing for these products is OUR batch
 *    report, and that is what this says.
 *
 * 2. It says the certificate is RETURNING from the laboratory — the batch has
 *    been submitted and the report is being issued — which is the owner's
 *    account of where these documents are. It never names a purity figure or
 *    calls anything verified: a promise of a document is not the document.
 */
export const COA_TESTING_PENDING_HEADING = "COA returning from the laboratory";

/** One or two lines, for the catalogue card's dialog and the library card. */
export const COA_TESTING_PENDING_SHORT =
  "This batch's Certificate of Analysis is on its way back from the independent laboratory and will be published here as soon as it arrives.";

/** The fuller version, for the product page's COA panel. */
export const COA_TESTING_PENDING_BODY =
  "This batch's Vanta Labs Certificate of Analysis is on its way back from the independent laboratory. It will be published here — and in the COA Library — as soon as it arrives.";
