// ---------------------------------------------------------------------------
// THE PROMOTION CENTRE'S CONFIGURATION LAYER.
//
// The engine (bxgy-engine.ts) knows how to price a Buy-X-Get-Y promotion. This
// module knows which ones the store HAS, how they are stored, and how to read
// a hand-edited or half-migrated blob of JSON back into something the engine
// can be trusted with. It is pure — no Supabase, no control-value reads — so
// the client bundle can normalise the same payload the server does.
//
// STORAGE. Promotions live in a single admin control value,
// `promotions.bxgy_promotions`, as a JSON array. That is a deliberate choice
// over a new table: the store's whole promotion surface (Buy 3 Get 1, bundle
// tiers, coupon stacking, the welcome offer) is already control values read
// through getHomepageControlConfig, and splitting half of it into a table would
// mean two different answers to "is this promotion on" during a partial read.
// Redemption COUNTS are the one thing that cannot live here — they are counted
// from orders, in bxgy-promotions.ts.
//
// BACKWARDS COMPATIBILITY IS NOT OPTIONAL HERE. `promotions.buy_3_get_1_enabled`
// has been the store's live promotion switch, is read by the product page, the
// offers bar, the control centre and the storefront-offers module, and is what
// an existing installation has set. It remains the single source of truth for
// whether the built-in Buy 3 Get 1 promotion is on — see LEGACY_BUY_3_GET_1_ID
// and applyLegacyBuy3Get1Flag below. Nothing about an existing store's
// behaviour changes until an admin edits a promotion in the new centre.
// ---------------------------------------------------------------------------

import {
  DEFAULT_ELIGIBILITY,
  type BxgyEligibility,
  type BxgyPromotion,
  promotionHeadline,
} from "@/lib/bxgy-engine";

/** The id the store's original promotion has always been, in all but name. */
export const LEGACY_BUY_3_GET_1_ID = "buy-3-get-1-free";
/**
 * The id behind `promotions.buy_2_get_1_half_enabled`.
 *
 * That control-centre checkbox has existed for some time and, until now, moved
 * no total: storefront-offers.ts documented it as "an admin control that does
 * nothing" and refused to advertise it for exactly that reason. It is now the
 * on/off switch for this promotion, so ticking it does what it says.
 */
export const LEGACY_BUY_2_GET_1_HALF_ID = "buy-2-get-1-half-off";

/** The control-value key holding the promotion array. */
export const BXGY_CONTROL_SECTION = "promotions";
export const BXGY_CONTROL_KEY = "bxgy_promotions";

type PromotionTemplate = {
  id: string;
  name: string;
  buyQuantity: number;
  getQuantity: number;
  rewardPercent: number;
  priority: number;
  /** Slugs this promotion ships excluded from. See BELOW_COST_AT_BOGO. */
  excludeSlugs?: string[];
};

/**
 * PRODUCTS A "GET ONE FREE" PROMOTION CANNOT AFFORD.
 *
 * Measured, not guessed: bxgy-production-economics.test.ts prices every
 * promotion over the real catalogue at production's own break-even floor, and
 * these two are the only SKUs where Buy 1 Get 1 Free goes below cost —
 * pinealon at $72.99 against $35.00, cerebrolysin at $74.99 against $35.00, both
 * ~47% cost. At even quantities BOGO charges half of list, and a $140 basket of
 * goods is sold for $149.98 before fees. The profit guard already refuses those
 * orders, so nothing is mispriced today; what it cannot do is stop the
 * promotion being switched on and then failing at the pay button.
 *
 * So they ship EXCLUDED from Buy 1 Get 1 Free. An admin can still remove the
 * exclusion — this is a guard rail, not a lock — but it cannot happen by
 * accident, which is the ask.
 *
 * Buy 3 Get 2 Free is deliberately NOT given the same exclusion: it competes
 * against the 12% quantity tier a five-unit basket has already earned, so the
 * shopper pays 60% of list rather than 50%, and it stays profitable on both
 * (cerebrolysin x5 clears by $25.97). Excluding a SKU that pays its way would
 * cost sales for no reason.
 */
export const BELOW_COST_AT_BOGO = ["pinealon", "cerebrolysin"];

/**
 * The promotions the centre ships with, every one of them an instance of the
 * same engine rule. Priority orders them for tie-breaks only — a promotion is
 * chosen on what it actually saves, never on this number alone.
 */
const TEMPLATES: PromotionTemplate[] = [
  { id: "buy-1-get-1-free", name: "Buy 1 Get 1 Free", buyQuantity: 1, getQuantity: 1, rewardPercent: 100, priority: 60, excludeSlugs: BELOW_COST_AT_BOGO },
  { id: "buy-2-get-1-free", name: "Buy 2 Get 1 Free", buyQuantity: 2, getQuantity: 1, rewardPercent: 100, priority: 50 },
  { id: "buy-3-get-2-free", name: "Buy 3 Get 2 Free", buyQuantity: 3, getQuantity: 2, rewardPercent: 100, priority: 45 },
  { id: LEGACY_BUY_3_GET_1_ID, name: "Buy 3 Get 1 Free", buyQuantity: 3, getQuantity: 1, rewardPercent: 100, priority: 40 },
  { id: "buy-1-get-1-half-off", name: "Buy 1 Get 1 50% Off", buyQuantity: 1, getQuantity: 1, rewardPercent: 50, priority: 30 },
  { id: "buy-2-get-1-half-off", name: "Buy 2 Get 1 50% Off", buyQuantity: 2, getQuantity: 1, rewardPercent: 50, priority: 20 },
];

function templateToPromotion(template: PromotionTemplate): BxgyPromotion {
  return {
    id: template.id,
    name: template.name,
    enabled: false,
    buyQuantity: template.buyQuantity,
    getQuantity: template.getQuantity,
    rewardPercent: template.rewardPercent,
    eligibility: { includeSlugs: [], excludeSlugs: [...(template.excludeSlugs ?? [])] },
    startsAt: null,
    endsAt: null,
    maxRedemptions: null,
    perCustomerLimit: null,
    maxRewardUnitsPerOrder: null,
    stackWithCoupon: false,
    stackWithBundlePricing: false,
    priority: template.priority,
  };
}

/** Every built-in promotion, switched off, at its default configuration. */
export function defaultBxgyPromotions(): BxgyPromotion[] {
  return TEMPLATES.map(templateToPromotion);
}

export function isBuiltInPromotionId(id: string): boolean {
  return TEMPLATES.some((template) => template.id === id);
}

// ---------------------------------------------------------------------------
// READING WHAT WAS STORED
// ---------------------------------------------------------------------------

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (trimmed) out.push(trimmed);
  }
  return Array.from(new Set(out));
}

function toEligibility(value: unknown): BxgyEligibility {
  if (!value || typeof value !== "object") return { ...DEFAULT_ELIGIBILITY };
  const record = value as Record<string, unknown>;
  return {
    includeSlugs: toStringArray(record.includeSlugs),
    excludeSlugs: toStringArray(record.excludeSlugs),
  };
}

/**
 * A positive whole number, or null.
 *
 * BLANK MEANS UNLIMITED, NOT ZERO. An admin who clears the "usage limit" field
 * means "no limit"; reading that as 0 would silently switch the promotion off
 * for everyone, which is the opposite of what they did.
 */
function toPositiveIntOrNull(value: unknown): number | null {
  if (value === "" || value == null) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.floor(parsed);
}

function toIsoOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Date.parse(trimmed);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toISOString();
}

function toCount(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  // A group of 100 units is already absurd; the ceiling stops a typo'd
  // quantity from expanding a basket into an unbounded loop downstream.
  return Math.min(100, Math.floor(parsed));
}

function toRewardPercent(value: unknown, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(100, parsed);
}

/**
 * One stored record → a promotion the engine can price, or null if the record
 * is not recognisably a promotion at all.
 *
 * Unknown ids are kept, not dropped: an admin may add a promotion the built-in
 * list has never heard of, and silently discarding it on the next read would
 * turn "my promotion vanished" into an unexplainable bug.
 */
export function normalizeBxgyPromotion(raw: unknown): BxgyPromotion | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id.trim() : "";
  if (!id) return null;

  const template = TEMPLATES.find((entry) => entry.id === id);
  const base = template ? templateToPromotion(template) : {
    ...templateToPromotion({ id, name: id, buyQuantity: 1, getQuantity: 1, rewardPercent: 100, priority: 10 }),
  };

  const buyQuantity = toCount(record.buyQuantity, base.buyQuantity);
  const getQuantity = toCount(record.getQuantity, base.getQuantity);
  const rewardPercent = toRewardPercent(record.rewardPercent, base.rewardPercent);
  const name = typeof record.name === "string" && record.name.trim()
    ? record.name.trim()
    : (template ? base.name : promotionHeadline({ buyQuantity, getQuantity, rewardPercent }));

  return {
    id,
    name,
    enabled: record.enabled === true,
    buyQuantity,
    getQuantity,
    rewardPercent,
    eligibility: toEligibility(record.eligibility),
    startsAt: toIsoOrNull(record.startsAt),
    endsAt: toIsoOrNull(record.endsAt),
    maxRedemptions: toPositiveIntOrNull(record.maxRedemptions),
    perCustomerLimit: toPositiveIntOrNull(record.perCustomerLimit),
    maxRewardUnitsPerOrder: toPositiveIntOrNull(record.maxRewardUnitsPerOrder),
    stackWithCoupon: record.stackWithCoupon === true,
    stackWithBundlePricing: record.stackWithBundlePricing === true,
    priority: Number.isFinite(Number(record.priority)) ? Number(record.priority) : base.priority,
  };
}

/**
 * The store's full promotion list: every built-in, overlaid with whatever was
 * stored, plus any custom promotion an admin added.
 *
 * Built-ins always appear even when nothing is stored, so the promotion centre
 * has something to render on a store that has never saved a promotion — all of
 * them off, which is exactly the behaviour that store has today.
 */
export function resolveBxgyPromotions(stored: unknown): BxgyPromotion[] {
  const overrides = new Map<string, BxgyPromotion>();
  if (Array.isArray(stored)) {
    for (const entry of stored) {
      const promotion = normalizeBxgyPromotion(entry);
      if (promotion) overrides.set(promotion.id, promotion);
    }
  }

  const resolved: BxgyPromotion[] = [];
  for (const template of TEMPLATES) {
    resolved.push(overrides.get(template.id) ?? templateToPromotion(template));
    overrides.delete(template.id);
  }
  for (const custom of overrides.values()) resolved.push(custom);
  return resolved;
}

/**
 * THE ONE PLACE THE LEGACY SWITCHES AND THE NEW CENTRE ARE RECONCILED.
 *
 * `promotions.buy_3_get_1_enabled` is what an existing store has set, what the
 * control centre's checkbox writes, and what the product page and offers bar
 * still read. `promotions.buy_2_get_1_half_enabled` is its dormant twin. Both
 * stay authoritative for their built-in promotion: whatever the promotion array
 * says about those two ids, these flags decide whether they are on.
 *
 * The admin API writes BOTH representations whenever either promotion is
 * toggled in the new centre, so they can never disagree for longer than a
 * single request — but this function is what guarantees they cannot disagree at
 * READ time either, if a migration, a manual database edit, or a half-applied
 * write leaves them out of step.
 */
export interface LegacyPromotionFlags {
  buy3Get1Enabled?: boolean;
  buy2Get1HalfEnabled?: boolean;
}

export function applyLegacyPromotionFlags(
  promotions: BxgyPromotion[],
  flags: LegacyPromotionFlags,
): BxgyPromotion[] {
  return promotions.map((promotion) => {
    if (promotion.id === LEGACY_BUY_3_GET_1_ID && flags.buy3Get1Enabled !== undefined) {
      return { ...promotion, enabled: flags.buy3Get1Enabled };
    }
    if (promotion.id === LEGACY_BUY_2_GET_1_HALF_ID && flags.buy2Get1HalfEnabled !== undefined) {
      return { ...promotion, enabled: flags.buy2Get1HalfEnabled };
    }
    return promotion;
  });
}

/** The control-value key whose boolean owns this promotion, if any. */
export function legacyFlagKeyFor(promotionId: string): string | null {
  if (promotionId === LEGACY_BUY_3_GET_1_ID) return "buy_3_get_1_enabled";
  if (promotionId === LEGACY_BUY_2_GET_1_HALF_ID) return "buy_2_get_1_half_enabled";
  return null;
}

/** Serialise for storage. Round-trips through normalizeBxgyPromotion unchanged. */
export function serializeBxgyPromotions(promotions: BxgyPromotion[]): Record<string, unknown>[] {
  return promotions.map((promotion) => ({
    id: promotion.id,
    name: promotion.name,
    enabled: promotion.enabled,
    buyQuantity: promotion.buyQuantity,
    getQuantity: promotion.getQuantity,
    rewardPercent: promotion.rewardPercent,
    eligibility: {
      includeSlugs: promotion.eligibility.includeSlugs,
      excludeSlugs: promotion.eligibility.excludeSlugs,
    },
    startsAt: promotion.startsAt,
    endsAt: promotion.endsAt,
    maxRedemptions: promotion.maxRedemptions,
    perCustomerLimit: promotion.perCustomerLimit,
    maxRewardUnitsPerOrder: promotion.maxRewardUnitsPerOrder,
    stackWithCoupon: promotion.stackWithCoupon,
    stackWithBundlePricing: promotion.stackWithBundlePricing,
    priority: promotion.priority,
  }));
}
