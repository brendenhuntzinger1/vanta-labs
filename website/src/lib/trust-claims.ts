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
 * The compact strip used in the footer, the age gate and anywhere else a short
 * row of proof points belongs. Ordered by what a first-time visitor from social
 * actually wants to know: is it tested, can I see the paperwork, is my card
 * safe, when does it leave.
 */
export const TRUST_POINTS: readonly string[] = [
  TESTING_SHORT,
  COA_SHORT,
  CHECKOUT_SHORT,
  FULFILMENT_SHORT,
];

/** The same four with their supporting line, for surfaces that have room. */
export const TRUST_POINTS_DETAILED: readonly { label: string; detail: string }[] = [
  { label: TESTING_SHORT, detail: TESTING_DETAIL },
  { label: COA_SHORT, detail: COA_DETAIL },
  { label: CHECKOUT_SHORT, detail: CHECKOUT_DETAIL },
  { label: FULFILMENT_SHORT, detail: FULFILMENT_DETAIL },
];
