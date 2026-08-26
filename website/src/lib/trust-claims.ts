// ---------------------------------------------------------------------------
// EVERY CUSTOMER-FACING TRUST CLAIM, IN ONE PLACE, WITH ITS PROVENANCE.
//
// These strings were previously copied into eight files and had already drifted
// into four different versions of the same fulfilment promise — "Ships within
// one business day", "Ships in 1 business day", "Most in-stock orders are
// prepared within one business day", and a bare "Fast Dispatch". Four wordings
// of one commitment is how a store ends up unable to say what it actually
// promised when a customer disputes an order.
//
// The rule for anything added here: a claim earns its place by being checkable
// against configuration, published policy, or an explicit decision by the owner
// that is recorded in the comment next to it. Nothing goes in because it would
// convert well.
// ---------------------------------------------------------------------------

/**
 * FULFILMENT CUTOFF.
 *
 * Owner decision, recorded 2026-08: orders placed before 2PM ET on a business
 * day ship the same day. The cutoff and the weekday qualifier are both load
 * bearing — an unqualified "same-day fulfilment" promises same-day shipping to
 * someone ordering at 11pm on a Sunday, which is a dispute waiting to happen.
 *
 * Note the deliberate split: this describes when the parcel LEAVES. It says
 * nothing about when it arrives, because the store does not control carrier
 * transit and the Shipping Policy states plainly that "Delivery times are
 * estimates and are not guaranteed."
 */
export const FULFILMENT_CUTOFF = "2PM ET";
export const FULFILMENT_SHORT = "Same-Day Dispatch";
export const FULFILMENT_DETAIL = `Order by ${FULFILMENT_CUTOFF}, ships same day (Mon–Fri)`;
export const FULFILMENT_SENTENCE = `In-stock orders placed before ${FULFILMENT_CUTOFF} on a business day are dispatched the same day. Carrier transit time is additional.`;

/**
 * TESTING.
 *
 * Owner attestation, recorded 2026-08: every product is third-party tested to
 * 99%+ purity, and Certificates of Analysis are being added as they arrive from
 * the lab.
 *
 * Which is why the SITE-WIDE strings below are deliberately weaker than the
 * per-product ones. A catalogue-level badge is a statement about the programme
 * — that testing is how this store operates. A number attached to a specific
 * vial is a statement about that vial, and it is only ever rendered from that
 * product's own `purityResult` and its own COA (see `hasVerifiedTesting` in
 * product-detail-client.tsx, which requires BOTH a real purity value and a COA
 * on file before it will assert anything).
 *
 * So: no hard-coded "99%" appears anywhere in the UI. The figure a customer
 * sees is the figure the lab recorded for the lot in front of them, and where
 * that record does not exist yet, nothing is claimed at all. As COAs land, the
 * per-product proof appears on its own — no code change, no copy change, and no
 * window in which the site claims more than it can show.
 */
export const TESTING_SHORT = "Third-Party Tested";
export const TESTING_DETAIL = "Independent laboratory batch testing";

/**
 * COA.
 *
 * Gated per product by `hasCoa()` in coa-url.ts, which rejects the placeholder
 * values operators actually type — " ", "pending", "TBD", "n/a" — so a product
 * without a document never advertises one. The COA Library route is the
 * public index of what has been published.
 */
export const COA_SHORT = "COA Documented";
export const COA_DETAIL = "Batch-level Certificates of Analysis";

/**
 * CHECKOUT.
 *
 * The payment session is created server-side and card details are entered in
 * the provider's hosted field — this application never sees a card number.
 * "Encrypted" describes the transport, and claims nothing about certification.
 */
export const CHECKOUT_SHORT = "Encrypted Checkout";
export const CHECKOUT_DETAIL = "Card details never touch our servers";

/**
 * DESTINATIONS.
 *
 * Enforced, not aspirational: quote-order.ts rejects any address outside these
 * two countries with "We currently ship only to the United States and Canada."
 */
export const DESTINATIONS_SENTENCE = "Ships to the United States and Canada.";

/** Tracking. Shipping Policy: "Once shipped, you'll receive tracking by email." */
export const TRACKING_SENTENCE = "Tracking is emailed after dispatch.";

/**
 * THE RESTRICTION, IN THE PLACE A BUYER DECIDES.
 *
 * Found by scanning the rendered text of all 111 public URLs: every page says
 * "Research Use Only", and the full statement — "Not for human or veterinary
 * use" — appeared on a product page ONLY inside the Description tab, which is
 * collapsed until tapped and is conditionally rendered, so it was not in the
 * document at all. The strongest sentence on the site was one tap away from
 * every buying decision.
 *
 * (The earlier compliance sweeps that reported this clean were reading the age
 * gate's own copy rather than the pages — see the note in compliance.mjs. The
 * gap was real; the test was not looking.)
 *
 * Stated here once so the badge, the panel and anything added later cannot
 * drift into three different versions of the same restriction.
 */
export const RESEARCH_USE_SENTENCE =
  "For laboratory research use only. Not for human or veterinary use.";

/**
 * The compact strip used in the footer, the age gate and anywhere else a short
 * row of proof points belongs. Ordered by what a first-time visitor from social
 * actually wants to know: is it tested, can I see the paperwork, is my card
 * safe, when does it leave.
 */
export interface TrustEvidence {
  /** True only when at least one COA is published and publicly resolvable. */
  coaPublished?: boolean;
}

/**
 * K-21. These were two constants, and two pages copied them, drifted, and began
 * asserting things nothing substantiated — a hard-coded "99%+ Purity" that this
 * file's own TESTING comment says appears nowhere in the UI, "Full batch
 * traceability", a cipher strength, and a fulfilment promise that contradicted
 * every other page, on the last screen before payment.
 *
 * A constant also cannot express the rule that matters most here: "COA
 * Documented" asserts that documents EXIST. Today none do (ledger F-006), while
 * this strip said so on every page and on the age gate — the first screen a
 * visitor sees. So the strip is now a function of what the caller can actually
 * show, and a caller that cannot show a COA does not claim one. It returns on
 * its own the day the COA Library is non-empty: no code change, no copy change,
 * and no window in which the site claims more than it can prove.
 *
 * TESTING_SHORT stays unconditional on purpose. It is a statement about the
 * PROGRAMME, recorded as an owner attestation above, not about a document —
 * which is exactly the distinction that makes the site-wide strings weaker than
 * the per-product ones.
 */
export function trustPointsDetailed(
  evidence: TrustEvidence = {},
): readonly { label: string; detail: string }[] {
  return [
    { label: TESTING_SHORT, detail: TESTING_DETAIL },
    // Absent unless something can show one. Not "off by default" — unclaimable.
    ...(evidence.coaPublished ? [{ label: COA_SHORT, detail: COA_DETAIL }] : []),
    { label: CHECKOUT_SHORT, detail: CHECKOUT_DETAIL },
    { label: FULFILMENT_SHORT, detail: FULFILMENT_DETAIL },
  ];
}

/** The labels alone, for surfaces without room for the supporting line. */
export function trustPoints(evidence: TrustEvidence = {}): readonly string[] {
  return trustPointsDetailed(evidence).map((point) => point.label);
}

// ---------------------------------------------------------------------------
// THE CATALOG RAIL.
//
// Five signals under the catalogue headline, replacing a paragraph. Two lines
// each so they stay legible at 320px without shrinking the type.
//
// On the wording, and why one of these is not what was asked for:
//
//   * "BATCH-TESTED COAs" is stated on the owner's launch precondition, recorded
//     2026-08: the store does not open to customers until a Certificate of
//     Analysis exists for every published product. That makes the claim true
//     at the moment anyone can read it, which is the test that matters.
//
//     IT IS ALSO THE CLAIM MOST EASILY BROKEN LATER. Publishing a new product
//     before its COA is on file makes this line false site-wide, silently,
//     with nothing in the application to catch it. The per-product proof is
//     still independently gated behind hasCoa(), so a product without a
//     document shows no COA action — but this rail does not read that gate,
//     and it will keep saying "verified" regardless.
//
//   * "≥99% PURITY" rests on the owner's attestation (recorded 2026-08) that
//     every product is third-party tested to that standard. It is a statement
//     about the programme and already appears on the home page. It is NOT a
//     statement about a particular vial: a purity FIGURE is only ever rendered
//     from that product's own record behind hasVerifiedTesting.
//
//   * "FAST CUSTOMER SUPPORT" is the owner's characterisation of their own
//     operation, backed by a staffed support route (/account/support) and a
//     published support address. Note what it does NOT do: no response time is
//     stated, because no SLA exists anywhere in this application to hold the
//     store to one. "Fast" is a promise the owner keeps by answering quickly,
//     not something the software can enforce or evidence.
// ---------------------------------------------------------------------------
export type RailItem = { top: string; bottom: string; href?: string; icon: string };

/**
 * THE COA CLAIM, IN TWO STRENGTHS.
 *
 * "Batch-Tested COAs" asserts coverage across the whole catalogue. It is only
 * true while EVERY published product has a document on file, and the comment
 * above predicted exactly how it breaks: publish one product without its COA
 * and the line goes silently false site-wide.
 *
 * So it is no longer hard-coded. `catalogTrustRail()` picks the strength from
 * the catalogue actually on the page:
 *
 *   every product has a COA  -> the coverage claim, which is now earned
 *   any product does not     -> the weaker line, which is true either way
 *
 * The weaker line still links to the library and still tells a visitor
 * documents exist. What it stops doing is claiming they exist for everything.
 */
export const COA_RAIL_COMPLETE: RailItem = {
  top: "Batch-Tested",
  bottom: "COAs",
  href: "/coa-library",
  icon: "coas",
};

/**
 * Says only what the COA Library route can always evidence: published
 * certificates are indexed there. Makes no statement about coverage, so no
 * catalogue change can turn it into a false claim.
 */
export const COA_RAIL_PARTIAL: RailItem = {
  top: "Published",
  bottom: "COAs",
  href: "/coa-library",
  icon: "coas",
};

/**
 * The rail for a given catalogue.
 *
 * `everyProductHasCoa` defaults to FALSE, which is the safe direction: while
 * the catalogue is still loading, or if a caller forgets to pass it, the site
 * under-claims rather than over-claims.
 */
export function catalogTrustRail(everyProductHasCoa = false): readonly RailItem[] {
  return [
    { top: "Same-Day", bottom: "Fulfillment", icon: "fulfillment" },
    everyProductHasCoa ? COA_RAIL_COMPLETE : COA_RAIL_PARTIAL,
    { top: "\u226599%", bottom: "Purity", icon: "purity" },
    { top: "Fast Customer", bottom: "Support", href: "/contact", icon: "support" },
    { top: "Secure", bottom: "Checkout", icon: "checkout" },
  ];
}
