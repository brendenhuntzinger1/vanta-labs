// ---------------------------------------------------------------------------
// THE CART MAY PREVIEW A PER-CUSTOMER PROMOTION ONLY WHEN IT KNOWS THE SERVER
// WILL HONOUR IT.
//
// quote-order is the till. It drops a promotion carrying a `perCustomerLimit`
// when the shopper's address has used it up, and it refuses the order outright
// if the client's total came in BELOW its own — "Altered total detected". So
// there is exactly one dangerous disagreement between the two:
//
//     the cart applies a promotion    +    the server does not
//
// The mirror image is harmless and is already the store's stated rule for its
// own server-side degradations: getPromotionUsage withholds limited promotions
// when the counting layer is missing, and says of it "this withholds a discount
// — it never blocks a checkout". A client total ABOVE the server's is accepted
// and the shopper is charged the lower, correct amount.
//
// This module gives the cart the same rule. The client previously started from
// `exhaustedPromotionIds = []` and applied everything until told otherwise, so
// any failed lookup — a 429, a timeout, an offline moment — left it previewing
// a promotion the server was about to drop. Starting from "not yet confirmed"
// instead makes the dangerous direction unreachable: the cart cannot apply a
// per-customer promotion it has not had confirmed for the address the order
// will be placed under.
//
// IT MIRRORS THE SERVER'S CONDITION RATHER THAN GUESSING AT IT. quote-order
// checks exhaustion only when `promotion.perCustomerLimit !== null && email`,
// so both of those are reproduced here literally:
//
//   * no per-customer limit  → the server never checks → the cart applies it,
//     exactly as before. Most promotions are this, and nothing about them
//     changes.
//   * a limit but NO email   → the server's `&& email` is false, so the server
//     applies it → the cart applies it too. An anonymous browse is unaffected,
//     which matters: it is most of the catalogue's traffic and it must not lose
//     its promotion banner.
//   * a limit AND an email   → the server WILL check → the cart may apply it
//     only on a confirmed answer for THAT address.
//
// The third case is the only one that can withhold, and it withholds only while
// a lookup for the current address has not come back. Caching and de-duplication
// upstream make that window small; correctness does not depend on it being
// small, only on it being safe.
// ---------------------------------------------------------------------------

/** The shape this rule needs from a promotion; the cart's carries much more. */
export interface PerCustomerLimited {
  id: string;
  perCustomerLimit: number | null;
}

/**
 * A confirmed answer from /api/catalog/promotions/eligibility.
 *
 * `email` is the address the answer is ABOUT. An answer for one address says
 * nothing about another, so it is carried with the answer rather than assumed
 * to match whatever the cart holds now — that assumption is how a stale
 * confirmation would silently authorise the dangerous direction.
 */
export interface EligibilityAnswer {
  email: string;
  exhaustedPromotionIds: string[];
}

/** Normalised the way the route and quote-order normalise. */
export function normalizeCartEmail(value: unknown): string {
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  return text.includes("@") ? text : "";
}

/**
 * Whether the cart may apply this promotion right now.
 *
 * Exported alongside the filter because the reason matters at call sites that
 * explain themselves to the shopper, and because it is the single place the
 * invariant is stated.
 */
export function mayApplyPromotion(
  promotion: PerCustomerLimited,
  email: string,
  answer: EligibilityAnswer | null,
): boolean {
  // The server never consults a per-customer count for this promotion.
  if (promotion.perCustomerLimit === null) return true;
  // No address: quote-order's `&& email` is false, so it applies the promotion
  // and so may we.
  if (!email) return true;
  // An address is known, so the server will check it. Only a confirmation FOR
  // THIS ADDRESS lets the cart agree with what the till is about to do.
  if (!answer || answer.email !== email) return false;
  return !answer.exhaustedPromotionIds.includes(promotion.id);
}

/**
 * The promotions this cart may earn, given what has been confirmed.
 *
 * The store-wide list has already had globally exhausted promotions removed by
 * getApplicableBxgyPromotions; this removes the per-customer dimension, which
 * is the one the browser cannot evaluate for itself.
 */
export function selectApplicablePromotions<T extends PerCustomerLimited>(
  promotions: readonly T[],
  email: string,
  answer: EligibilityAnswer | null,
): T[] {
  return promotions.filter((promotion) => mayApplyPromotion(promotion, email, answer));
}

/**
 * Does this cart still need an answer before it can price itself correctly?
 *
 * False when nothing on offer carries a per-customer limit, or when there is no
 * address to ask about — in both cases the request would change no decision, so
 * the cart must not spend a lookup on it. This is what keeps an ordinary
 * anonymous browse from touching the endpoint at all.
 */
export function needsEligibilityLookup(
  promotions: readonly PerCustomerLimited[],
  email: string,
  answer: EligibilityAnswer | null,
): boolean {
  if (!email) return false;
  if (!promotions.some((promotion) => promotion.perCustomerLimit !== null)) return false;
  return !answer || answer.email !== email;
}

// ---------------------------------------------------------------------------
// THE CACHE.
//
// One answer per address, shared across tabs and reused across navigations, so
// the endpoint is asked once per address rather than once per page view. That
// is the whole of the traffic fix: the budget was never the problem so much as
// asking again for something already known.
//
// It is deliberately SHORT-LIVED. An answer can go stale in one direction that
// matters — the shopper spends their last redemption in another tab — and a
// stale "not exhausted" is the dangerous direction. A few minutes bounds that
// to a window in which the same shopper would have to complete a second order,
// and the till still refuses to sell them a promotion they no longer have.
// ---------------------------------------------------------------------------

export const ELIGIBILITY_CACHE_KEY = "vl_promo_eligibility";
export const ELIGIBILITY_CACHE_TTL_MS = 3 * 60 * 1000;

interface CachedAnswer {
  email: string;
  exhaustedPromotionIds: string[];
  at: number;
}

/** Read a still-fresh answer for `email`, or null. Never throws. */
export function readCachedEligibility(
  storage: Pick<Storage, "getItem">,
  email: string,
  now: number = Date.now(),
): EligibilityAnswer | null {
  if (!email) return null;
  try {
    const raw = storage.getItem(ELIGIBILITY_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedAnswer | null;
    if (!parsed || parsed.email !== email) return null;
    if (!Array.isArray(parsed.exhaustedPromotionIds)) return null;
    if (!Number.isFinite(parsed.at) || now - parsed.at > ELIGIBILITY_CACHE_TTL_MS) return null;
    return {
      email: parsed.email,
      exhaustedPromotionIds: parsed.exhaustedPromotionIds.filter((id): id is string => typeof id === "string"),
    };
  } catch {
    // A private window, blocked site data, or a value someone else wrote.
    // No cache is a slower cart, never a wrong one.
    return null;
  }
}

/** Store an answer. Never throws — see readCachedEligibility. */
export function writeCachedEligibility(
  storage: Pick<Storage, "setItem">,
  answer: EligibilityAnswer,
  now: number = Date.now(),
): void {
  try {
    const payload: CachedAnswer = {
      email: answer.email,
      exhaustedPromotionIds: answer.exhaustedPromotionIds,
      at: now,
    };
    storage.setItem(ELIGIBILITY_CACHE_KEY, JSON.stringify(payload));
  } catch {
    // Storage is a convenience here and never a correctness dependency.
  }
}
