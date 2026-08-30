// ---------------------------------------------------------------------------
// THE BUY X GET Y ENGINE.
//
// One configurable rule — "buy X eligible units, get Y of them at N% off" —
// that every quantity-reward promotion in the store is an instance of:
//
//   Buy 1 Get 1 Free        X=1 Y=1 reward=100%
//   Buy 1 Get 1 50% Off     X=1 Y=1 reward=50%
//   Buy 2 Get 1 Free        X=2 Y=1 reward=100%
//   Buy 2 Get 1 50% Off     X=2 Y=1 reward=50%
//   Buy 3 Get 1 Free        X=3 Y=1 reward=100%   ← the store's original promo
//   Buy 3 Get 2 Free        X=3 Y=2 reward=100%
//
// Five separate implementations of the same arithmetic is five places for the
// cart preview and the server charge to drift apart, which is the one failure
// this store cannot afford (payment-service rejects any order whose claimed
// total is below the server's). So there is exactly one implementation, it is
// pure, and both sides import it: the client cart (cart-context.tsx) and the
// server checkout (quote-order.ts).
//
// WHAT LIVES HERE: the arithmetic, the eligibility test, the schedule window,
// and the customer-facing wording. Nothing else — no database, no Supabase, no
// admin control values. Usage counters and per-customer history are the
// caller's to supply (bxgy-promotions.ts on the server), because a pure module
// is the only kind both halves of the app can run identically.
//
// WHAT THIS ENGINE DELIBERATELY DOES NOT DO: it never decides that a promotion
// is THE discount on an order. It answers "what is this promotion worth on
// this basket", and the winner is then chosen by the existing single-discount
// rulebook (resolveCustomerDiscount in profit-engine.ts) against the coupon,
// the referral, membership pricing and the rest. Adding a second place that
// picks a winner is how a store ends up applying two.
// ---------------------------------------------------------------------------

/** Money rounding, identical to bundle-pricing's, kept local so this module has no imports. */
export function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Which products a promotion counts.
 *
 * `includeSlugs` empty means STORE-WIDE (every product counts) — that is the
 * behaviour the original Buy 3 Get 1 had, and an empty include list is how it
 * keeps it. A non-empty include list narrows to exactly those slugs.
 * `excludeSlugs` always wins over the include list, so "everything except the
 * starter kit" is `include: [], exclude: ["starter-kit"]`.
 */
export interface BxgyEligibility {
  includeSlugs: string[];
  excludeSlugs: string[];
}

export interface BxgyPromotion {
  /** Stable identifier. Written onto the order, so it must never be reused. */
  id: string;
  /** Customer-facing name, e.g. "Buy 2 Get 1 Free". */
  name: string;
  enabled: boolean;
  /** X — units that must be bought at full price for one reward group. */
  buyQuantity: number;
  /** Y — units rewarded per group. */
  getQuantity: number;
  /** How much comes off each rewarded unit. 100 = free, 50 = half price. */
  rewardPercent: number;
  eligibility: BxgyEligibility;
  /** ISO timestamps. null = no bound on that side. */
  startsAt: string | null;
  endsAt: string | null;
  /** Store-wide redemption cap; null = unlimited. */
  maxRedemptions: number | null;
  /** Per-customer redemption cap; null = unlimited. */
  perCustomerLimit: number | null;
  /** Ceiling on rewarded units in a single order; null = no ceiling. */
  maxRewardUnitsPerOrder: number | null;
  /**
   * May a coupon code be combined with this promotion?
   *
   * false (the default, and what Buy 3 Get 1 has always done) means the
   * coupon and this promotion compete and the larger wins. true feeds the
   * existing `allowCouponStacking` path in resolveCustomerDiscount, where the
   * coupon adds on top. It never lets TWO Buy-X-Get-Y promotions apply at once
   * — see selectBxgyPromotion.
   */
  stackWithCoupon: boolean;
  /**
   * Value rewarded units at their quantity-bundle ("Bundle & Save") price
   * rather than at list price.
   *
   * This is the store's existing `bundleStacking` switch expressed per
   * promotion: off means the free unit is worth FULL price and competes with
   * the bundle savings; on means the free unit is worth its already-discounted
   * price and the two effectively combine.
   */
  stackWithBundlePricing: boolean;
  /** Tie-break when two promotions save exactly the same. Higher wins. */
  priority: number;
}

/** A basket line, priced however the caller wants the reward units valued. */
export interface BxgyLine {
  slug: string;
  unitPrice: number;
  quantity: number;
}

/** What one promotion is worth on one basket. */
export interface BxgyApplication {
  promotionId: string;
  name: string;
  /** Dollars off. Always >= 0 and rounded to cents. */
  discountAmount: number;
  /** How many units were rewarded. */
  rewardUnits: number;
  /** Unit prices of the rewarded units, cheapest first. */
  rewardedUnitPrices: number[];
  /** Eligible units in the basket (NOT the whole basket). */
  eligibleUnits: number;
  /** More eligible units needed to unlock the next reward group; 0 if none pending. */
  unitsUntilNextReward: number;
  rewardPercent: number;
  /** One line of customer-facing copy describing what happened. */
  message: string;
}

export const DEFAULT_ELIGIBILITY: BxgyEligibility = { includeSlugs: [], excludeSlugs: [] };

// ---------------------------------------------------------------------------
// SCHEDULE
// ---------------------------------------------------------------------------

/**
 * Is this promotion inside its start/end window right now?
 *
 * This IS the automatic activation and expiration. There is no cron, no job,
 * and deliberately so: a promotion that switches itself on by being read is
 * one that cannot be left running by a worker that failed to fire. An unparsable
 * date is treated as "no bound" rather than as an expiry, so a malformed value
 * can never silently switch a live promotion off mid-sale.
 */
export function isPromotionScheduled(promotion: BxgyPromotion, now: Date = new Date()): boolean {
  const at = now.getTime();
  const start = parseTimestamp(promotion.startsAt);
  const end = parseTimestamp(promotion.endsAt);
  if (start !== null && at < start) return false;
  if (end !== null && at >= end) return false;
  return true;
}

function parseTimestamp(value: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Scheduled AND switched on. Usage limits are checked separately (they need counters). */
export function isPromotionLive(promotion: BxgyPromotion, now: Date = new Date()): boolean {
  return promotion.enabled && isPromotionScheduled(promotion, now);
}

// ---------------------------------------------------------------------------
// ELIGIBILITY
// ---------------------------------------------------------------------------

function normalizeSlug(slug: string): string {
  return slug.trim().toLowerCase();
}

export function isSlugEligible(promotion: BxgyPromotion, slug: string): boolean {
  const candidate = normalizeSlug(slug);
  if (!candidate) return false;
  const excluded = promotion.eligibility.excludeSlugs.some((entry) => normalizeSlug(entry) === candidate);
  if (excluded) return false;
  const include = promotion.eligibility.includeSlugs;
  if (include.length === 0) return true; // store-wide
  return include.some((entry) => normalizeSlug(entry) === candidate);
}

/**
 * Every eligible unit in the basket, one entry per unit, cheapest first.
 *
 * Expanding quantities into individual units is what makes mixed-price carts
 * work: a promotion does not care that three units arrived on one line and one
 * on another, only that four eligible units are present.
 */
export function collectEligibleUnitPrices(lines: BxgyLine[], promotion: BxgyPromotion): number[] {
  const units: number[] = [];
  for (const line of lines) {
    if (!isSlugEligible(promotion, line.slug)) continue;
    const quantity = Math.max(0, Math.floor(line.quantity));
    const price = Number(line.unitPrice);
    if (!Number.isFinite(price) || price < 0) continue;
    for (let i = 0; i < quantity; i += 1) units.push(price);
  }
  return units.sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// THE ARITHMETIC
// ---------------------------------------------------------------------------

/** Units that make up one complete reward group: X bought + Y rewarded. */
export function groupSize(promotion: BxgyPromotion): number {
  return Math.max(1, promotion.buyQuantity) + Math.max(1, promotion.getQuantity);
}

/**
 * How many units this basket earns at a reduced price.
 *
 * floor(eligible / (X+Y)) complete groups, Y rewards each, capped by
 * maxRewardUnitsPerOrder. For X=3 Y=1 this is floor(n/4) — bit for bit what
 * the store's original Buy 3 Get 1 computed, which is the whole point.
 */
export function rewardUnitCount(eligibleUnits: number, promotion: BxgyPromotion): number {
  if (eligibleUnits <= 0) return 0;
  const groups = Math.floor(eligibleUnits / groupSize(promotion));
  const earned = groups * Math.max(1, promotion.getQuantity);
  const cap = promotion.maxRewardUnitsPerOrder;
  if (cap !== null && cap >= 0) return Math.min(earned, Math.floor(cap));
  return earned;
}

/** Eligible units still needed to complete the next reward group. */
export function unitsUntilNextReward(eligibleUnits: number, promotion: BxgyPromotion): number {
  if (eligibleUnits <= 0) return 0;
  const size = groupSize(promotion);
  const remainder = eligibleUnits % size;
  return remainder === 0 ? 0 : size - remainder;
}

/**
 * What this promotion takes off this basket.
 *
 * THE CHEAPEST UNITS ARE THE REWARDED ONES, chosen across the whole basket
 * rather than within each group. That is what the original Buy 3 Get 1 did and
 * what the storefront copy has always promised ("the cheapest is free"), and it
 * is also the merchant-safe direction: per-group allocation would discount MORE
 * on a basket that mixes an expensive group with a cheap one.
 *
 * Returns null when the promotion earns nothing, so callers can treat "no
 * application" and "a $0 application" as the same thing.
 */
export function applyBxgyPromotion(lines: BxgyLine[], promotion: BxgyPromotion): BxgyApplication | null {
  const units = collectEligibleUnitPrices(lines, promotion);
  const rewards = rewardUnitCount(units.length, promotion);
  if (rewards <= 0) return null;

  const rewardedUnitPrices = units.slice(0, rewards);
  const percent = clampPercent(promotion.rewardPercent);
  const discountAmount = roundMoney(
    rewardedUnitPrices.reduce((sum, price) => sum + price * (percent / 100), 0),
  );
  if (discountAmount <= 0) return null;

  return {
    promotionId: promotion.id,
    name: promotion.name,
    discountAmount,
    rewardUnits: rewards,
    rewardedUnitPrices,
    eligibleUnits: units.length,
    unitsUntilNextReward: unitsUntilNextReward(units.length, promotion),
    rewardPercent: percent,
    message: appliedMessage(promotion, rewards, percent),
  };
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

// ---------------------------------------------------------------------------
// CHOOSING BETWEEN PROMOTIONS
// ---------------------------------------------------------------------------

/**
 * How a caller supplies the basket.
 *
 * A plain array is the usual case. The FUNCTION form exists because reward
 * units are not always valued the same way for every promotion: a promotion
 * with `stackWithBundlePricing` values its free unit at the quantity-bundle
 * price, one without it values the same unit at full list price. The server
 * checkout needs both valuations in the same selection pass, and giving it a
 * per-promotion hook is what stops it from re-implementing the selection loop.
 */
export type BxgyLineSource = BxgyLine[] | ((promotion: BxgyPromotion) => BxgyLine[]);

function linesFor(source: BxgyLineSource, promotion: BxgyPromotion): BxgyLine[] {
  return typeof source === "function" ? source(promotion) : source;
}

export interface BxgySelectionContext {
  now?: Date;
  /**
   * Promotion ids that have hit a usage limit — store-wide or for this
   * customer. Resolved by the caller (bxgy-promotions.ts server-side, the
   * catalog API client-side) because counting redemptions needs a database and
   * this module must stay pure.
   */
  exhaustedIds?: readonly string[];
}

/** The promotions that may be applied right now, best-first. */
export function liveBxgyPromotions(
  promotions: readonly BxgyPromotion[],
  context: BxgySelectionContext = {},
): BxgyPromotion[] {
  const now = context.now ?? new Date();
  const exhausted = new Set(context.exhaustedIds ?? []);
  return promotions
    .filter((promotion) => isPromotionLive(promotion, now) && !exhausted.has(promotion.id))
    .sort((a, b) => b.priority - a.priority);
}

/**
 * ONE Buy-X-Get-Y promotion applies per order — the one worth the most.
 *
 * Two of them stacking is not a stacking rule anyone wants: Buy-1-Get-1 and
 * Buy-2-Get-1 running together on a four-unit basket would give away three of
 * the four units. The `stackWithCoupon` flag governs the only stack that is
 * ever intended, and that stack is with a coupon, resolved downstream by
 * resolveCustomerDiscount.
 *
 * Ties break on priority, then on the earlier id, so the same basket always
 * resolves to the same promotion on the client and on the server.
 */
export function selectBxgyPromotion(
  lines: BxgyLineSource,
  promotions: readonly BxgyPromotion[],
  context: BxgySelectionContext = {},
): { promotion: BxgyPromotion; application: BxgyApplication } | null {
  let best: { promotion: BxgyPromotion; application: BxgyApplication } | null = null;
  for (const promotion of liveBxgyPromotions(promotions, context)) {
    const application = applyBxgyPromotion(linesFor(lines, promotion), promotion);
    if (!application) continue;
    if (!best) {
      best = { promotion, application };
      continue;
    }
    const better = application.discountAmount > best.application.discountAmount
      || (application.discountAmount === best.application.discountAmount
        && (promotion.priority > best.promotion.priority
          || (promotion.priority === best.promotion.priority && promotion.id < best.promotion.id)));
    if (better) best = { promotion, application };
  }
  return best;
}

/**
 * The promotion a shopper is closest to unlocking, for the cart's nudge.
 *
 * Only promotions that are live and have not already earned a reward on this
 * basket are considered, and the nearest one wins — a shopper one unit away
 * from Buy-2-Get-1 should be told about that, not about the Buy-3-Get-2 they
 * are four units away from.
 */
export function nextBxgyOpportunity(
  lines: BxgyLineSource,
  promotions: readonly BxgyPromotion[],
  context: BxgySelectionContext = {},
): { promotion: BxgyPromotion; unitsAway: number } | null {
  let best: { promotion: BxgyPromotion; unitsAway: number } | null = null;
  for (const promotion of liveBxgyPromotions(promotions, context)) {
    const units = collectEligibleUnitPrices(linesFor(lines, promotion), promotion).length;
    if (units <= 0) continue;
    const away = unitsUntilNextReward(units, promotion);
    if (away <= 0) continue;
    if (!best || away < best.unitsAway || (away === best.unitsAway && promotion.priority > best.promotion.priority)) {
      best = { promotion, unitsAway: away };
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// WORDING
//
// Every customer-facing sentence about these promotions is generated here, so
// the cart drawer, the product page, the offers bar and the admin preview
// cannot describe the same promotion three different ways.
// ---------------------------------------------------------------------------

/** "Free" or "50% off" — how the reward is described. */
export function rewardLabel(rewardPercent: number): string {
  const percent = clampPercent(rewardPercent);
  return percent >= 100 ? "Free" : `${trimPercent(percent)}% Off`;
}

function trimPercent(percent: number): string {
  return Number.isInteger(percent) ? String(percent) : String(Math.round(percent * 100) / 100);
}

/** "Buy 2 Get 1 Free", "Buy 1 Get 1 50% Off" — the headline. */
export function promotionHeadline(promotion: Pick<BxgyPromotion, "buyQuantity" | "getQuantity" | "rewardPercent">): string {
  return `Buy ${Math.max(1, promotion.buyQuantity)} Get ${Math.max(1, promotion.getQuantity)} ${rewardLabel(promotion.rewardPercent)}`;
}

function pluralUnits(count: number): string {
  return count === 1 ? "item" : "items";
}

function appliedMessage(promotion: BxgyPromotion, rewards: number, percent: number): string {
  if (percent >= 100) {
    return `${promotion.name} applied — ${rewards} ${pluralUnits(rewards)} free.`;
  }
  return `${promotion.name} applied — ${trimPercent(percent)}% off ${rewards} ${pluralUnits(rewards)}.`;
}

/** "Add 1 more item to get one free." — the cart nudge. */
export function progressMessage(promotion: BxgyPromotion, unitsAway: number): string {
  if (unitsAway <= 0) return "";
  const reward = clampPercent(promotion.rewardPercent) >= 100
    ? `${promotion.getQuantity > 1 ? `${promotion.getQuantity} items` : "an item"} free`
    : `${trimPercent(clampPercent(promotion.rewardPercent))}% off ${promotion.getQuantity > 1 ? `${promotion.getQuantity} items` : "an item"}`;
  return `Add ${unitsAway} more ${pluralUnits(unitsAway)} to unlock ${reward}.`;
}

/** What the storefront may advertise: short, and true of the promotion as configured. */
export function storefrontDescription(promotion: BxgyPromotion): string {
  const scope = promotion.eligibility.includeSlugs.length > 0 ? "on selected products" : "storewide";
  const reward = clampPercent(promotion.rewardPercent) >= 100 ? "free" : `${trimPercent(clampPercent(promotion.rewardPercent))}% off`;
  const rewarded = promotion.getQuantity === 1 ? "the cheapest item" : `the ${promotion.getQuantity} cheapest items`;
  return `Add ${groupSize(promotion)} eligible ${pluralUnits(groupSize(promotion))} ${scope} and ${rewarded} ${promotion.getQuantity === 1 ? "is" : "are"} ${reward}.`;
}

// ---------------------------------------------------------------------------
// THE ONE ENTRY POINT BOTH THE CART AND THE CHECKOUT USE.
//
// The cart preview and the server quote were, until this existed, two call
// sites that each had to remember the same two rules: value a rewarded unit at
// its bundle price only when stacking is allowed, and hand the engine a
// different basket per promotion because that answer varies per promotion.
// Written out twice, those rules drift, and drift here means the cart shows a
// total the card is not charged — which payment-service rejects as tampering.
//
// So the rules live here once, and the callers supply the only thing they
// genuinely know differently: a line's two prices.
// ---------------------------------------------------------------------------

/** A basket line with both valuations of a unit, so the engine can pick. */
export interface BxgyCartLine {
  slug: string;
  /** Full list price of one unit, before any quantity-bundle discount. */
  listUnitPrice: number;
  /** The same unit at its quantity-bundle ("Bundle & Save") price. */
  bundledUnitPrice: number;
  quantity: number;
}

export interface BxgyCartOptions extends BxgySelectionContext {
  /**
   * The store-wide "Bundle & Save may combine with promotions" switch. A
   * promotion's own stackWithBundlePricing does the same thing for that
   * promotion alone; either one is enough.
   */
  bundleStacking?: boolean;
}

function cartLineSource(lines: BxgyCartLine[], bundleStacking: boolean): BxgyLineSource {
  return (promotion: BxgyPromotion) => {
    const useBundledPrices = bundleStacking || promotion.stackWithBundlePricing;
    return lines.map((line) => ({
      slug: line.slug,
      unitPrice: useBundledPrices ? line.bundledUnitPrice : line.listUnitPrice,
      quantity: line.quantity,
    }));
  };
}

/** The single promotion that prices this basket, or null. */
export function selectPromotionForCart(
  lines: BxgyCartLine[],
  promotions: readonly BxgyPromotion[],
  options: BxgyCartOptions = {},
) {
  if (lines.length === 0 || promotions.length === 0) return null;
  return selectBxgyPromotion(cartLineSource(lines, options.bundleStacking === true), promotions, options);
}

/** The promotion this basket is closest to unlocking, for the cart's nudge. */
export function nextOpportunityForCart(
  lines: BxgyCartLine[],
  promotions: readonly BxgyPromotion[],
  options: BxgyCartOptions = {},
) {
  if (lines.length === 0 || promotions.length === 0) return null;
  return nextBxgyOpportunity(cartLineSource(lines, options.bundleStacking === true), promotions, options);
}
