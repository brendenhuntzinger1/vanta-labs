// ---------------------------------------------------------------------------
// THE REORDER DECISION, IN ONE PURE FUNCTION.
//
// "Am I about to run out of this?" answered for every inventory line, ranked so
// the most urgent is first. No database, no clock, no config lookups: everything
// this needs is an argument, so every rule below is unit-testable and the same
// inputs always give the same answer. See inventory-watchlist.test.ts.
//
// TWO SIGNALS, IN PRIORITY ORDER
//
//   Sold recently  -> forecast. Days left = available / units sold per day.
//                     Flagged when the shelf empties before a resupply lands.
//   No recent sales -> the per-line low_stock_threshold the owner already set.
//
// The fallback is not a nicety. Vanta Labs currently sells a few dozen units a
// month across ~48 lines, so most lines have zero sales in any 30-day window
// and a pure forecast would rate them as infinite cover and never mention them
// again — including lines sitting at 1 unit. A forecast that only speaks about
// bestsellers is not a watch list.
//
// ARITHMETIC IS INTEGER, DELIBERATELY. Day counts are computed as
// (units * windowDays) / unitsSold rather than from a pre-divided daily rate:
// 30 units in 30 days must give exactly 44 days of target cover, not
// 44.000000000000004, which ceil() would turn into an extra unit ordered.
// ---------------------------------------------------------------------------

/** Urgency, worst first. A line that needs nothing is absent, not "healthy". */
export type WatchlistTier = "out" | "order-now" | "order-soon";

/**
 * The inventory fields this decision needs. Structurally a subset of
 * InventoryLine (admin-inventory.ts) so real rows can be passed straight in,
 * but declared here so this module never imports anything server-only.
 */
export interface WatchlistLine {
  key: string;
  productName: string;
  variantLabel: string | null;
  sku: string | null;
  /** On hand MINUS units held by checkouts in progress. What can be sold now. */
  availableQuantity: number;
  /** Ordered from the supplier, not yet on the shelf. */
  incomingQuantity: number;
  lowStockThreshold: number;
}

export interface WatchlistSettings {
  /** Days from placing a supplier order to units being sellable. */
  leadTimeDays: number;
  /** Days of stock to hold ON TOP of the lead time when reordering. */
  coverTargetDays: number;
  /** How many days of sales history unitsSold was measured over. */
  salesWindowDays: number;
}

export interface WatchlistEntry {
  key: string;
  productName: string;
  variantLabel: string | null;
  sku: string | null;
  tier: WatchlistTier;
  available: number;
  incoming: number;
  unitsSoldInWindow: number;
  /** Units per week to one decimal place. null when nothing sold in the window. */
  unitsPerWeek: number | null;
  /**
   * Whole days until the SELLABLE shelf hits zero at the measured pace. Counts
   * `available` only — stock in transit is not on the shelf — while the tier
   * below counts inbound units too, so an order already placed stops the
   * nagging without making this number optimistic.
   */
  daysUntilOut: number | null;
  /** Units to order now to reach lead time + cover target. Never negative. */
  suggestedOrderQty: number;
  /** Which of the two signals decided this row. */
  basis: "sales" | "threshold";
  /** One plain sentence for the screen. Lives here so the UI cannot invent a different reason than the one the rules used. */
  reason: string;
}

const TIER_RANK: Record<WatchlistTier, number> = {
  out: 0,
  "order-now": 1,
  "order-soon": 2,
};

/**
 * Quantities are counts of physical vials: whole, never negative. A null,
 * a NaN, a string from the driver or a negative left by a bad write all become
 * 0 rather than propagating into the arithmetic — an unreadable count must not
 * be able to produce a confident reorder quantity.
 */
function wholeCount(value: unknown): number {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.floor(parsed);
}

/** Same, but for day spans, with a floor the caller can set. */
function wholeDays(value: unknown, minimum: number): number {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed)) return minimum;
  return Math.max(minimum, Math.floor(parsed));
}

function plural(count: number, word: string): string {
  return count === 1 ? `1 ${word}` : `${count} ${word}s`;
}

function describe(input: {
  tier: WatchlistTier;
  basis: "sales" | "threshold";
  available: number;
  incoming: number;
  threshold: number;
  daysUntilOut: number | null;
  unitsPerWeek: number | null;
  windowDays: number;
  windowUsable: boolean;
}): string {
  const onOrder = input.incoming > 0 ? ` · ${input.incoming} on order` : "";

  if (input.tier === "out") {
    return input.incoming > 0
      ? `Out of stock — ${input.incoming} already on order`
      : "Out of stock";
  }

  if (input.basis === "sales") {
    const days = input.daysUntilOut ?? 0;
    const when = days === 0 ? "Runs out today" : `Runs out in about ${plural(days, "day")}`;
    return `${when} · selling about ${input.unitsPerWeek}/week${onOrder}`;
  }

  const nearness = input.tier === "order-now"
    ? `at or below your alert level of ${input.threshold}`
    : `getting close to your alert level of ${input.threshold}`;
  // Only claim a quiet sales window when one was actually measured.
  const salesNote = input.windowUsable ? ` · no sales in the last ${input.windowDays} days` : "";
  return `${plural(input.available, "unit")} left — ${nearness}${salesNote}${onOrder}`;
}

/**
 * Rank every line that needs attention. Lines that need nothing are omitted.
 *
 * @param unitsSoldByKey units sold per line key over `salesWindowDays`. A key
 *   that is absent means no sales, which is the normal case here.
 */
export function buildWatchlist(
  lines: WatchlistLine[],
  unitsSoldByKey: Record<string, number>,
  settings: WatchlistSettings,
): WatchlistEntry[] {
  // A WINDOW SHORTER THAN A DAY MEASURES NOTHING, so the sales counts attached
  // to it mean nothing either: every line falls back to its threshold rather
  // than forecasting from a figure with no period behind it. Clamping the
  // window to 1 instead would turn a config typo into "runs out today" on
  // healthy lines — a confident wrong number, which is the one output this
  // screen must never produce.
  const rawWindow = Number(settings.salesWindowDays ?? 0);
  const windowUsable = Number.isFinite(rawWindow) && rawWindow >= 1;
  const windowDays = windowUsable ? Math.floor(rawWindow) : 1;
  const leadTimeDays = wholeDays(settings.leadTimeDays, 0);
  const coverTargetDays = wholeDays(settings.coverTargetDays, 0);
  const horizonDays = leadTimeDays + coverTargetDays;

  const entries: WatchlistEntry[] = [];

  for (const line of lines ?? []) {
    const available = wholeCount(line.availableQuantity);
    const incoming = wholeCount(line.incomingQuantity);
    const threshold = wholeCount(line.lowStockThreshold);
    const unitsSold = windowUsable ? wholeCount(unitsSoldByKey?.[line.key]) : 0;

    // What the shelf will hold once everything already ordered arrives. Tiering
    // reads this so a line you have already reordered stops asking to be
    // reordered; the displayed daysUntilOut stays honest about the shelf today.
    const backing = available + incoming;
    const basis: WatchlistEntry["basis"] = unitsSold > 0 ? "sales" : "threshold";

    let tier: WatchlistTier | null;
    if (available <= 0) {
      // Nothing sellable is out of stock whatever the forecast says, and
      // whatever is in transit. It is the one state that is not a prediction.
      tier = "out";
    } else if (basis === "sales") {
      const daysCovered = Math.floor((backing * windowDays) / unitsSold);
      tier = daysCovered <= leadTimeDays
        ? "order-now"
        : daysCovered <= horizonDays
          ? "order-soon"
          : null;
    } else if (threshold <= 0) {
      // A threshold of zero on a line with no sales is the owner saying "never
      // warn me about this one". Honour it rather than inventing a floor.
      tier = null;
    } else {
      tier = backing <= threshold
        ? "order-now"
        : backing <= threshold * 2
          ? "order-soon"
          : null;
    }

    if (tier === null) continue;

    const daysUntilOut = basis === "sales"
      ? Math.floor((available * windowDays) / unitsSold)
      : null;
    const unitsPerWeek = basis === "sales"
      ? Math.round((unitsSold * 7 * 10) / windowDays) / 10
      : null;

    const wanted = basis === "sales"
      ? Math.ceil((unitsSold * horizonDays) / windowDays)
      // Twice the alert level: enough that receiving the order clears the line
      // off this list rather than leaving it sitting exactly on the boundary.
      : threshold * 2;

    entries.push({
      key: line.key,
      productName: line.productName,
      variantLabel: line.variantLabel,
      sku: line.sku,
      tier,
      available,
      incoming,
      unitsSoldInWindow: unitsSold,
      unitsPerWeek,
      daysUntilOut,
      suggestedOrderQty: Math.max(0, wanted - backing),
      basis,
      reason: describe({ tier, basis, available, incoming, threshold, daysUntilOut, unitsPerWeek, windowDays, windowUsable }),
    });
  }

  return entries.sort((a, b) => {
    const byTier = TIER_RANK[a.tier] - TIER_RANK[b.tier];
    if (byTier !== 0) return byTier;
    // A line with no forecast sorts after one that has a date, rather than
    // sorting as though it had zero days left.
    const aDays = a.daysUntilOut ?? Number.POSITIVE_INFINITY;
    const bDays = b.daysUntilOut ?? Number.POSITIVE_INFINITY;
    if (aDays !== bDays) return aDays - bDays;
    if (a.available !== b.available) return a.available - b.available;
    return a.productName.localeCompare(b.productName);
  });
}
