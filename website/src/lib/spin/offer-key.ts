/**
 * What a spin prize's offer_key looks like, as a pure fact.
 *
 * No `server-only`, no imports, no I/O: quoteOrder, the spin service and the
 * admin surfaces all need to agree on "is this offer a wheel prize?", and a
 * module with nothing in it is the one place they can agree without importing
 * each other. gift-terms.ts is the same pattern for the same reason.
 *
 * Namespaced so it can never collide with an OFFER_CATALOG key or with the
 * `campaign:` gifts, and carrying the campaign id so the one-live-offer index
 * gives one spin per campaign rather than one ever.
 */
export const SPIN_OFFER_KEY_PREFIX = "spin:";

export function spinOfferKey(campaignId: string): string {
  return `${SPIN_OFFER_KEY_PREFIX}${String(campaignId ?? "").trim()}`;
}

/** Is this offer a wheel prize? */
export function isSpinOfferKey(value: unknown): boolean {
  return typeof value === "string" && value.startsWith(SPIN_OFFER_KEY_PREFIX);
}

/** The campaign a spin offer belongs to, or null when it is not one. */
export function spinCampaignOf(offerKey: unknown): string | null {
  if (!isSpinOfferKey(offerKey)) return null;
  const campaign = String(offerKey).slice(SPIN_OFFER_KEY_PREFIX.length).trim();
  return campaign || null;
}
