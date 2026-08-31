// -------------------------------------------------------------------------
// PRODUCTS WHOSE CERTIFICATE OF ANALYSIS IS STILL COMING.
//
// The COA surfaces have one pending state: a product with no published record
// is marked "Documentation Pending" and told, in general terms, that batch
// documentation has not been published yet. That is accurate but it answers
// the wrong question — a shopper looking at an empty COA panel wants to know
// whether a report is coming, not that it is absent.
//
// These products were not part of the batch submitted for testing, so they
// will stay pending after the rest of the catalogue is documented. Naming them
// here lets those two cards say so plainly instead of sitting silently in the
// pending group.
//
// Client-safe: no server imports, so the public library, the product page and
// tests can all pull from the same list. Deliberately a hand-maintained list
// rather than an admin setting — it is two SKUs and one edit, and an admin
// toggle for it would be more surface than the fact deserves. REMOVE A SLUG
// FROM THIS LIST once its COA is published; leaving it in is harmless (the
// copy only renders while a product has zero published records) but it is dead
// weight.
// -------------------------------------------------------------------------

/**
 * Slugs awaiting third-party testing.
 *
 * `hgh-191aa` is the retired HGH row that `reconcile-catalog.sql` maps onto
 * `hgh-gh-191`. It is unpublished today, but it is one `is_published` flip away
 * from being a live product page, and a store that surfaced it should not lose
 * the notice on a technicality.
 */
export const COA_TESTING_PENDING_SLUGS = ["hgh-gh-191", "hgh-191aa", "hcg"] as const;

const PENDING_SLUGS = new Set<string>(COA_TESTING_PENDING_SLUGS);

/**
 * Is this product one whose COA is still being tested?
 *
 * Slug only, never name: unlike the BAC Water exclusion this drives a CLAIM
 * shown to customers, so matching too much is the expensive direction. A name
 * regex for "HGH" would also catch an unrelated growth-hormone SKU added later
 * and tell shoppers its documented COA was still in a laboratory.
 *
 * Callers must already know the product has no published COA — this says which
 * pending products have an explanation, not which products are pending.
 */
export function isCoaTestingPending(
  product: { slug?: string | null } | string | null | undefined,
): boolean {
  const slug = (typeof product === "string" ? product : product?.slug ?? "").trim().toLowerCase();
  if (!slug) return false;
  return PENDING_SLUGS.has(slug);
}

/**
 * THE COPY, IN ONE PLACE.
 *
 * The COA library card and the product page's COA tab both render it, so the
 * two can never drift — and changing what the store says about these products
 * is a one-line edit here rather than a hunt through two components.
 *
 * Two wording constraints, both learned by reading the rendered page rather
 * than the source:
 *
 * 1. It says the BATCH COA is in progress, not that the compound is untested.
 *    On the product page this sits beside `CoaLibraryNotice`, which states that
 *    current inventory comes from batches its supplier has third-party tested
 *    and that Vanta-branded batch COAs are still being prepared. A first draft
 *    here read "independent third-party testing has not been completed for this
 *    compound" — which flatly contradicted the panel above it. What is missing
 *    for these two products is OUR batch report, and that is what this says.
 *
 * 2. It says testing is being ARRANGED, not that a sample is on a laboratory
 *    bench right now, because the batch has not been submitted yet. Once it
 *    has, "third-party testing is being arranged" → "third-party testing is
 *    underway" in both strings is the whole edit.
 */
export const COA_TESTING_PENDING_HEADING = "Batch COA in progress";

/** One line, for the COA library card where space is a card body. */
export const COA_TESTING_PENDING_SHORT =
  "This compound's batch COA is still in progress — third-party testing is being arranged, and the report will be published here as soon as the laboratory issues it.";

/** The fuller version, for the product page's COA panel. */
export const COA_TESTING_PENDING_BODY =
  "This compound's Vanta Labs batch COA is still in progress. Independent third-party testing is being arranged, and the report will be published here — and in the COA Library — as soon as the laboratory issues it.";
