// No `server-only`: the admin band editor is a Client Component and shows the
// operator the cost, the net margin and the perceived value of a band WHILE
// they are editing it. A margin they only learn after saving is a margin they
// learn too late. Pure — no I/O, no secrets, no database.

/**
 * WHAT A RECOVERY OFFER IS WORTH, BY CART SIZE.
 *
 * WHY BANDS AT ALL. The ladder used to be flat: every abandoned cart got the
 * same free BAC Water at 24h and the same 10% + BAC Water at 72h, whether it
 * held $40 or $520. Measured against the real carts on 2026-09-08, that is the
 * wrong shape — 8 of 30 carts are $300+ and they hold 57% of every dollar this
 * store has ever had walk out. A flat offer under-serves the carts that matter
 * and over-serves the ones that do not.
 *
 * WHY GIFTS RATHER THAN DISCOUNT, WHICH IS THE PART THAT SURPRISES PEOPLE.
 * At this store's real dose costs a gift buys far more perceived value per
 * dollar than a percentage does:
 *
 *     GHK-Cu      costs $3.65   shows $39.99    11.0x
 *     BAC Water   costs $1.43   shows $14.99    10.5x
 *     KLOW        costs $25.07  shows $119.99    4.8x
 *     a percentage                               1.0x, and it scales with the cart
 *
 * A percentage costs roughly 12-14% of contribution on any cart; a gift costs
 * 3-8%. So the efficient recovery offer is more product and less discount, and
 * the percentage is best reserved for the bands where a gift alone would look
 * thin against the cart.
 *
 * WHY IT IS CONFIGURATION AND NOT CODE. The owner should be able to change what
 * a band gives without a deploy, and should be able to SEE what the change
 * costs before saving it. That is what `tierEconomics` below is for, and it is
 * why this module is pure: the same function computes the number in the admin
 * as the one quoted in this comment.
 *
 * WHAT IS NOT CONFIGURABLE HERE, deliberately. The floors that stop the ladder
 * being farmed live in cart-recovery-offers.ts and stay in code: the minimum
 * cart value for any gift at all, one gift per address per 30 days, one
 * sequence per address per week, and nothing whatsoever to somebody who bought
 * in the last 30 days. Those are safety rails, not marketing settings.
 */

export type RecoveryGiftItem = {
  slug: string;
  /** Units of this product. One unless stated. */
  quantity: number;
};

export type RecoveryTier = {
  /**
   * Inclusive floor, in cents. A cart belongs to the LAST tier whose floor it
   * clears, so the bands need no upper bound and cannot leave a gap between
   * them — the commonest way a hand-written band table goes wrong.
   */
  minCents: number;
  /** The 24-hour message's gift. Empty means no gift at this stage. */
  stage3: RecoveryGiftItem[];
  /** The 72-hour message: gifts, and a percentage that may be zero. */
  stage4: { gifts: RecoveryGiftItem[]; percent: number };
};

/** Nothing is gifted below this, whatever the bands say. Mirrors the code floor. */
export const TIER_ABSOLUTE_FLOOR_CENTS = 3_500;

export const MAX_TIERS = 6;
export const MAX_GIFT_ITEMS_PER_STAGE = 4;
export const MAX_GIFT_QUANTITY = 5;

/**
 * The shipped ladder, and the reasoning for each band.
 *
 * Costs below are this store's real dose costs; the percentages are what the
 * band is worth on its own representative cart (the observed averages: $61,
 * $150, $380, $520).
 *
 *   $35-99    stage 4 is a free GHK-Cu and NO percentage. On a $61 cart the
 *             vial is 65% of the order — a discount on top adds $6 of cost to
 *             add $6 of perceived value, the worst trade in the ladder. Cost
 *             $3.65, 8.4% of contribution.
 *   $100-249  the gift alone is 27% of the cart, thin enough that a percentage
 *             earns its place. Cost $20.08, 17.1%.
 *   $250-499  same offer, larger percentage in absolute terms because it scales
 *             with the cart. Cost $43.09, 13.9%.
 *   $500+     the biggest gift and NO percentage: 10% of a $520 cart costs $52
 *             and shows $52, while a KLOW costs $25 and shows $120. Cost
 *             $30.15, 7.1% — the cheapest band and the strongest offer.
 */
export const DEFAULT_RECOVERY_TIERS: RecoveryTier[] = [
  {
    minCents: 3_500,
    stage3: [{ slug: "bac-water", quantity: 1 }],
    stage4: { gifts: [{ slug: "ghk-cu", quantity: 1 }], percent: 0 },
  },
  {
    minCents: 10_000,
    stage3: [{ slug: "ghk-cu", quantity: 1 }],
    stage4: { gifts: [{ slug: "ghk-cu", quantity: 1 }, { slug: "bac-water", quantity: 1 }], percent: 10 },
  },
  {
    minCents: 25_000,
    stage3: [{ slug: "ghk-cu", quantity: 1 }, { slug: "bac-water", quantity: 1 }],
    stage4: { gifts: [{ slug: "ghk-cu", quantity: 1 }, { slug: "bac-water", quantity: 1 }], percent: 10 },
  },
  {
    minCents: 50_000,
    stage3: [{ slug: "ghk-cu", quantity: 1 }, { slug: "bac-water", quantity: 1 }],
    stage4: {
      gifts: [
        { slug: "klow", quantity: 1 },
        { slug: "ghk-cu", quantity: 1 },
        { slug: "bac-water", quantity: 1 },
      ],
      percent: 0,
    },
  },
];

/**
 * Which band this cart falls in.
 *
 * The LAST tier whose floor the cart clears, so bands cannot overlap and cannot
 * leave a gap. A cart under the lowest floor gets null — it is below the
 * programme entirely, and the caller gives it nothing rather than guessing.
 *
 * Tiers are sorted here rather than trusted, because a stored configuration is
 * only as ordered as whoever last edited it.
 */
export function tierForCart(tiers: RecoveryTier[], cartValueCents: number): RecoveryTier | null {
  const value = Number(cartValueCents);
  if (!Number.isFinite(value)) return null;
  const sorted = [...tiers].sort((a, b) => a.minCents - b.minCents);
  let match: RecoveryTier | null = null;
  for (const tier of sorted) {
    if (value >= tier.minCents) match = tier;
    else break;
  }
  return match;
}

export type TierValidation =
  | { ok: true; tiers: RecoveryTier[] }
  | { ok: false; error: string };

function items(value: unknown, knownSlugs: ReadonlySet<string> | null, where: string): RecoveryGiftItem[] | string {
  if (!Array.isArray(value)) return `${where}: the gift list must be a list.`;
  if (value.length > MAX_GIFT_ITEMS_PER_STAGE) {
    return `${where}: at most ${MAX_GIFT_ITEMS_PER_STAGE} products in one gift.`;
  }
  const out: RecoveryGiftItem[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    const entry = (raw ?? {}) as Record<string, unknown>;
    const slug = String(entry.slug ?? "").trim();
    if (!slug) return `${where}: a gift line has no product.`;
    // THE SLUG MUST BE ONE THE CATALOGUE ACTUALLY SELLS. quoteOrder resolves a
    // gift with an exact match and no fallback, so a wrong slug does not throw
    // and does not degrade visibly — the free line is silently never added and
    // the customer gets a message promising a product they never receive.
    if (knownSlugs && !knownSlugs.has(slug)) {
      return `${where}: "${slug}" is not a product on sale, so the gift would be promised and never shipped.`;
    }
    // The same product twice in one gift is a quantity, not two lines, and
    // letting both through would double it silently at the till.
    if (seen.has(slug)) return `${where}: "${slug}" is listed twice — use a quantity instead.`;
    seen.add(slug);
    const quantity = Number(entry.quantity ?? 1);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_GIFT_QUANTITY) {
      return `${where}: the quantity for "${slug}" must be a whole number from 1 to ${MAX_GIFT_QUANTITY}.`;
    }
    out.push({ slug, quantity });
  }
  return out;
}

/**
 * Turn stored or typed configuration into bands the sweep can act on, or say
 * why not.
 *
 * Refuses rather than repairs. A band table that silently corrects itself is
 * one where the operator's intent and the store's behaviour differ without
 * anyone being told — and here that difference is money given away.
 */
export function validateRecoveryTiers(
  input: unknown,
  knownSlugs: ReadonlySet<string> | null,
): TierValidation {
  if (!Array.isArray(input) || input.length === 0) {
    return { ok: false, error: "Set at least one cart-value band." };
  }
  if (input.length > MAX_TIERS) {
    return { ok: false, error: `At most ${MAX_TIERS} bands.` };
  }

  const tiers: RecoveryTier[] = [];
  for (const raw of input) {
    const row = (raw ?? {}) as Record<string, unknown>;
    const minCents = Number(row.minCents);
    if (!Number.isInteger(minCents) || minCents < 0) {
      return { ok: false, error: "Every band needs a whole-dollar minimum cart value." };
    }
    const label = `Band from $${(minCents / 100).toFixed(0)}`;

    const stage4Raw = (row.stage4 ?? {}) as Record<string, unknown>;
    const percent = Number(stage4Raw.percent ?? 0);
    if (!Number.isInteger(percent) || percent < 0 || percent > 100) {
      return { ok: false, error: `${label}: the 72-hour discount must be a whole number from 0 to 100.` };
    }

    const stage3 = items(row.stage3 ?? [], knownSlugs, `${label}, 24-hour gift`);
    if (typeof stage3 === "string") return { ok: false, error: stage3 };
    const stage4Gifts = items(stage4Raw.gifts ?? [], knownSlugs, `${label}, 72-hour gift`);
    if (typeof stage4Gifts === "string") return { ok: false, error: stage4Gifts };

    // A band that gives nothing at either stage is not a band, it is a gap —
    // and a gap is better expressed by raising the floor of the band above it.
    if (stage3.length === 0 && stage4Gifts.length === 0 && percent === 0) {
      return { ok: false, error: `${label}: gives nothing at all. Remove the band, or raise the next band's minimum.` };
    }

    tiers.push({ minCents, stage3, stage4: { gifts: stage4Gifts, percent } });
  }

  tiers.sort((a, b) => a.minCents - b.minCents);

  for (let i = 1; i < tiers.length; i += 1) {
    if (tiers[i].minCents === tiers[i - 1].minCents) {
      return { ok: false, error: `Two bands both start at $${(tiers[i].minCents / 100).toFixed(0)}. Each band needs its own minimum.` };
    }
  }

  // The lowest band cannot open below the programme's own floor, or the stored
  // configuration would appear to promise a gift that the code then withholds —
  // the operator would see one thing in the admin and another in the sweep.
  if (tiers[0].minCents < TIER_ABSOLUTE_FLOOR_CENTS) {
    return {
      ok: false,
      error: `The lowest band cannot start below $${(TIER_ABSOLUTE_FLOOR_CENTS / 100).toFixed(0)} — no gift is ever issued under that, whatever the bands say.`,
    };
  }

  return { ok: true, tiers };
}

/**
 * WHAT A BAND COSTS, AND WHAT IT LEAVES.
 *
 * The numbers the owner actually decides on, computed from live data rather
 * than from a spreadsheet that goes stale: real per-dose costs, the real
 * average postage, and the real blended product margin.
 *
 * `productCostRatio` is COGS as a share of revenue — 0.163 for this store's
 * 83.7% blended margin. `postageCents` is what a shipment actually costs, which
 * matters far more than it looks: it is a FIXED cost, so it falls hardest on
 * exactly the small carts where the incentive is also proportionally largest.
 *
 * The card fee is deliberately absent. This store passes a 3% service fee to
 * the customer on card payments, so it is not the store's cost and counting it
 * would understate every margin here.
 */
export type TierEconomicsInputs = {
  productCostRatio: number;
  postageCents: number;
  /** Real per-unit cost by slug, in cents. A slug absent here is counted as free. */
  giftCostCents: Readonly<Record<string, number>>;
  /** Retail price by slug, in cents — what the customer sees the gift as worth. */
  giftRetailCents: Readonly<Record<string, number>>;
};

export type TierEconomics = {
  cartValueCents: number;
  /** Revenue less product COGS less postage, before any incentive. */
  contributionCents: number;
  /** The 72-hour offer's cost: the gifts at cost, plus the percentage. */
  incentiveCents: number;
  giftCostCents: number;
  percentCostCents: number;
  netCents: number;
  /** Net profit as a share of revenue. */
  netMarginPercent: number;
  /** The incentive as a share of what the order would otherwise contribute. */
  incentiveShareOfContributionPercent: number;
  /** Retail value of everything the shopper is offered. */
  perceivedValueCents: number;
};

function sumItems(list: RecoveryGiftItem[], prices: Readonly<Record<string, number>>): number {
  return list.reduce((total, item) => total + (prices[item.slug] ?? 0) * item.quantity, 0);
}

/**
 * Price one band against a representative cart.
 *
 * Stage 4 only: it is the most expensive message in the sequence and the one
 * an operator is deciding about. Stage 3 carries no percentage and its gift is
 * a subset of the same catalogue, so a band affordable at stage 4 is
 * affordable at stage 3 by construction.
 */
export function tierEconomics(
  tier: RecoveryTier,
  cartValueCents: number,
  inputs: TierEconomicsInputs,
): TierEconomics {
  const revenue = Math.max(0, Math.round(cartValueCents));
  const cogs = Math.round(revenue * inputs.productCostRatio);
  const contribution = revenue - cogs - inputs.postageCents;

  const giftCost = sumItems(tier.stage4.gifts, inputs.giftCostCents);
  const percentCost = Math.round(revenue * (tier.stage4.percent / 100));
  const incentive = giftCost + percentCost;

  const net = contribution - incentive;
  const perceived = sumItems(tier.stage4.gifts, inputs.giftRetailCents) + percentCost;

  return {
    cartValueCents: revenue,
    contributionCents: contribution,
    incentiveCents: incentive,
    giftCostCents: giftCost,
    percentCostCents: percentCost,
    netCents: net,
    netMarginPercent: revenue > 0 ? (net / revenue) * 100 : 0,
    incentiveShareOfContributionPercent: contribution > 0 ? (incentive / contribution) * 100 : 0,
    perceivedValueCents: perceived,
  };
}

/**
 * The cart this band should be judged on.
 *
 * The midpoint between a band's floor and the next band's floor, because that
 * is the cart an operator is picturing when they set the band. The top band has
 * no ceiling, so it is judged at 1.5x its floor rather than at infinity — a
 * choice, stated here rather than buried, and the admin shows the figure it
 * used so nobody has to guess which cart the margin refers to.
 */
export function representativeCartCents(tiers: RecoveryTier[], index: number): number {
  const sorted = [...tiers].sort((a, b) => a.minCents - b.minCents);
  const floor = sorted[index]?.minCents ?? 0;
  const next = sorted[index + 1]?.minCents;
  return next ? Math.round((floor + next) / 2) : Math.round(floor * 1.5);
}
