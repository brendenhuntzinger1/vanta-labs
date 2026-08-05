// -------------------------------------------------------------------------
// Volume-based product cost reduction.
//
// The store earns a lower per-unit product cost as its monthly sales grow:
//
//     $5,000 in a month  → 20% off product cost
//     $10,000 in a month → 30% off product cost
//
// This is a COST-side discount, not a customer-facing price discount. Nothing
// a shopper sees changes; what changes is the cost (COGS) recorded against
// each order, which is what makes the profit numbers in the admin true.
//
// Two consequences worth being explicit about, because both are intended:
//
//  1. The cost snapshotted onto each order line (order_items.unit_cost_cents)
//     is the DISCOUNTED cost, so profit reports show the real margin.
//  2. The checkout profit floor prices against that same discounted cost, so a
//     tier that genuinely lowers cost also lets the guard allow the deeper
//     promotional pricing that lower cost supports. Guard and books never
//     disagree about what a unit cost.
//
// The tier is resolved from sales ALREADY BANKED this month at the moment the
// order is quoted, and the resulting cost is then frozen onto the order. An
// order placed before the store crossed $5,000 keeps its full-cost snapshot;
// crossing a threshold changes the cost of subsequent orders, never of history.
//
// This module is deliberately pure (no database, no `server-only`) so every
// boundary below is unit-tested. The month-to-date sales figure it consumes is
// read by `volume-cost-service.ts`.
// -------------------------------------------------------------------------

export interface VolumeCostTier {
  /** Net paid sales in the month, in dollars, required to reach this tier. */
  minMonthlySales: number;
  /** Percent taken OFF product cost while this tier is held (0–100). */
  costReductionPercent: number;
}

/** The agreed schedule. Editable in Admin → Control Center → Profit. */
export const DEFAULT_VOLUME_COST_TIERS: readonly VolumeCostTier[] = [
  { minMonthlySales: 5000, costReductionPercent: 20 },
  { minMonthlySales: 10000, costReductionPercent: 30 },
];

export interface VolumeCostDiscountConfig {
  enabled: boolean;
  tiers: VolumeCostTier[];
}

export const DEFAULT_VOLUME_COST_DISCOUNT_CONFIG: VolumeCostDiscountConfig = {
  enabled: true,
  tiers: DEFAULT_VOLUME_COST_TIERS.map((tier) => ({ ...tier })),
};

export interface ResolvedVolumeCostDiscount {
  /** Percent off product cost, 0 when no tier is held. */
  percent: number;
  /** The tier that applied, or null when none did. */
  tier: VolumeCostTier | null;
  /** Sales figure the decision was made from, in dollars. */
  monthlySales: number;
}

function finiteNumber(value: unknown): number | null {
  if (value === "" || value == null || typeof value === "boolean") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Coerce admin-entered tier data into a safe, sorted schedule.
 *
 * Anything unusable is dropped rather than guessed at: a malformed tier must
 * never silently become "0% threshold, 100% off", which would zero out cost on
 * every order and make every profit number in the admin a fiction.
 */
export function normalizeVolumeCostTiers(raw: unknown): VolumeCostTier[] {
  if (!Array.isArray(raw)) return DEFAULT_VOLUME_COST_TIERS.map((tier) => ({ ...tier }));

  const tiers: VolumeCostTier[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    const minMonthlySales = finiteNumber(row.minMonthlySales ?? row.min_monthly_sales);
    const costReductionPercent = finiteNumber(row.costReductionPercent ?? row.cost_reduction_percent);
    if (minMonthlySales == null || costReductionPercent == null) continue;
    if (minMonthlySales < 0 || costReductionPercent <= 0) continue;
    tiers.push({
      minMonthlySales,
      // A cost reduction above 100% would mean negative cost. Clamp.
      costReductionPercent: Math.min(100, costReductionPercent),
    });
  }

  // Ascending by threshold so resolution can scan for the highest one met.
  return tiers.sort((a, b) => a.minMonthlySales - b.minMonthlySales);
}

/**
 * The discount currently earned, given sales banked so far this month.
 *
 * The HIGHEST qualifying tier wins, regardless of the order the tiers were
 * entered in, so $12,000 of sales gets 30% and not the 20% that also qualifies.
 */
export function resolveVolumeCostDiscount(
  monthlySalesDollars: number,
  config: VolumeCostDiscountConfig = DEFAULT_VOLUME_COST_DISCOUNT_CONFIG,
): ResolvedVolumeCostDiscount {
  const monthlySales = Number.isFinite(monthlySalesDollars) && monthlySalesDollars > 0 ? monthlySalesDollars : 0;
  if (!config.enabled) return { percent: 0, tier: null, monthlySales };

  let best: VolumeCostTier | null = null;
  for (const tier of normalizeVolumeCostTiers(config.tiers)) {
    // `>=` — hitting the threshold exactly earns the tier.
    if (monthlySales >= tier.minMonthlySales) {
      if (!best || tier.costReductionPercent > best.costReductionPercent) best = tier;
    }
  }

  return { percent: best?.costReductionPercent ?? 0, tier: best, monthlySales };
}

/**
 * Apply a resolved cost reduction to one unit cost, in cents.
 *
 * Clamped at both ends: cost never goes negative, and a 0% discount is exactly
 * a no-op (never an off-by-one from rounding).
 */
export function applyVolumeCostDiscountCents(unitCostCents: number, percent: number): number {
  if (!Number.isFinite(unitCostCents) || unitCostCents <= 0) return 0;
  if (!Number.isFinite(percent) || percent <= 0) return Math.round(unitCostCents);
  const clamped = Math.min(100, percent);
  return Math.max(0, Math.round(unitCostCents * (1 - clamped / 100)));
}

/** Same reduction on a dollars-denominated cost, for the checkout profit floor. */
export function applyVolumeCostDiscountDollars(unitCostDollars: number, percent: number): number {
  if (!Number.isFinite(unitCostDollars) || unitCostDollars <= 0) return 0;
  if (!Number.isFinite(percent) || percent <= 0) return unitCostDollars;
  const clamped = Math.min(100, percent);
  return Math.max(0, (unitCostDollars * (100 - clamped)) / 100);
}

/** Human label for the admin, e.g. "30% off cost ($10,000+/mo)". */
export function describeVolumeCostDiscount(resolved: ResolvedVolumeCostDiscount): string {
  if (!resolved.tier || resolved.percent <= 0) return "No volume tier earned yet";
  const threshold = resolved.tier.minMonthlySales.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
  return `${resolved.percent}% off cost (${threshold}+/mo)`;
}
