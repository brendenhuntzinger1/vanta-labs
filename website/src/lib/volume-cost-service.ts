import "server-only";

import { supabaseAdmin } from "@/lib/supabase-server";
import { getControlSnapshot } from "@/lib/admin-control";
import { PAID_ORDER_STATUSES } from "@/lib/ledger";
import {
  DEFAULT_VOLUME_COST_DISCOUNT_CONFIG,
  normalizeVolumeCostTiers,
  resolveVolumeCostDiscount,
  type ResolvedVolumeCostDiscount,
  type VolumeCostDiscountConfig,
} from "@/lib/volume-cost-discount";

// -------------------------------------------------------------------------
// Reads the live inputs for the volume cost discount: the admin-editable tier
// schedule, and the PRIOR month's total product purchases that the wholesale
// sheet sets the tier from.
//
// Kept separate from the pure math in `volume-cost-discount.ts` so the tier
// boundaries stay unit-testable without a database.
// -------------------------------------------------------------------------

/**
 * The PRIOR calendar month's window, [start, end).
 *
 * Per the wholesale sheet: "Tier set each month from the prior month's total
 * product purchases." So the rate is fixed for the whole of the current month
 * by what was bought last month — it does not move mid-month as orders come in.
 *
 * UTC boundaries, matching the convention the revenue dashboard already uses,
 * so the tier and the reports agree on where a month starts.
 */
export function priorMonthWindow(now: Date = new Date()): { start: string; end: string } {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return { start: start.toISOString(), end: end.toISOString() };
}

/** Stable key for the month a tier decision belongs to. */
function currentMonthKey(now: Date = new Date()): string {
  return `${now.getUTCFullYear()}-${now.getUTCMonth()}`;
}

export async function getVolumeCostDiscountConfig(): Promise<VolumeCostDiscountConfig> {
  try {
    const snapshot = await getControlSnapshot("profit");
    const profit = snapshot.profit ?? {};

    const rawEnabled = profit.volume_cost_discount_enabled;
    const enabled =
      rawEnabled === undefined || rawEnabled === null || rawEnabled === ""
        ? DEFAULT_VOLUME_COST_DISCOUNT_CONFIG.enabled
        : rawEnabled !== false && rawEnabled !== "false";

    // Stored as JSON; accept a string too, since the control table round-trips
    // some values as text.
    let rawTiers: unknown = profit.volume_cost_tiers;
    if (typeof rawTiers === "string" && rawTiers.trim()) {
      try {
        rawTiers = JSON.parse(rawTiers);
      } catch {
        rawTiers = undefined;
      }
    }

    return {
      enabled,
      tiers: rawTiers === undefined || rawTiers === null
        ? DEFAULT_VOLUME_COST_DISCOUNT_CONFIG.tiers.map((tier) => ({ ...tier }))
        : normalizeVolumeCostTiers(rawTiers),
    };
  } catch {
    return {
      enabled: DEFAULT_VOLUME_COST_DISCOUNT_CONFIG.enabled,
      tiers: DEFAULT_VOLUME_COST_DISCOUNT_CONFIG.tiers.map((tier) => ({ ...tier })),
    };
  }
}

/**
 * Total PRODUCT PURCHASES in the prior month — what was actually spent with the
 * supplier on vials, which is what the wholesale sheet sets the tier from.
 *
 * This is deliberately NOT retail sales revenue. The two differ by roughly the
 * whole retail margin, so using revenue would hand out tiers that were never
 * earned. Product purchases = the per-vial cost of everything fulfilled, which
 * is exactly the cost snapshotted onto each order line at checkout.
 *
 * Shipping is excluded, matching the sheet ("everything except shipment cost").
 */
export async function getPriorMonthProductPurchases(now: Date = new Date()): Promise<number> {
  const { start, end } = priorMonthWindow(now);

  const { data: orderRows, error: orderError } = await supabaseAdmin
    .from("orders")
    .select("order_id")
    .in("payment_status", Array.from(PAID_ORDER_STATUSES))
    .gte("paid_at", start)
    .lt("paid_at", end)
    .limit(10000);

  if (orderError) throw orderError;

  const orderIds = (orderRows ?? []).map((row) => String(row.order_id)).filter(Boolean);
  if (orderIds.length === 0) return 0;

  // Chunked so a busy month doesn't build a URL the API will reject.
  let totalCents = 0;
  const CHUNK = 200;
  for (let i = 0; i < orderIds.length; i += CHUNK) {
    const { data: itemRows, error: itemError } = await supabaseAdmin
      .from("order_items")
      .select("quantity, unit_cost_cents")
      .in("order_id", orderIds.slice(i, i + CHUNK));

    if (itemError) throw itemError;

    for (const row of (itemRows ?? []) as Array<{ quantity: number | null; unit_cost_cents: number | null }>) {
      const unitCost = Number(row.unit_cost_cents ?? 0);
      const quantity = Number(row.quantity ?? 0);
      // A line with no recorded cost contributes nothing rather than an
      // assumed one — an assumption here would invent purchases that never
      // happened and could award a tier that was not earned.
      if (unitCost > 0 && quantity > 0) totalCents += unitCost * quantity;
    }
  }

  return Math.round(totalCents) / 100;
}

// The tier is fixed for the whole month, so this is near-constant. Cached with
// a short TTL anyway (an admin can edit the schedule mid-month) and keyed by
// month, so the roll into a new month always recomputes rather than serving
// last month's rate from a warm cache.
const CACHE_TTL_MS = 300_000;
let cached: { at: number; monthKey: string; value: ResolvedVolumeCostDiscount } | null = null;

/**
 * The cost reduction the store has earned right now.
 *
 * Never throws: if sales can't be read, it returns 0% (full cost). Failing
 * closed matters — an unreadable total must not hand out the top tier and let
 * the checkout profit floor approve orders against a cost the store isn't
 * actually paying.
 */
export async function getCurrentVolumeCostDiscount(options?: { force?: boolean }): Promise<ResolvedVolumeCostDiscount> {
  const monthKey = currentMonthKey();
  if (!options?.force && cached && cached.monthKey === monthKey && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.value;
  }

  try {
    const [config, priorMonthPurchases] = await Promise.all([
      getVolumeCostDiscountConfig(),
      getPriorMonthProductPurchases(),
    ]);
    const resolved = resolveVolumeCostDiscount(priorMonthPurchases, config);
    cached = { at: Date.now(), monthKey, value: resolved };
    return resolved;
  } catch {
    const fallback: ResolvedVolumeCostDiscount = { percent: 0, tier: null, priorMonthPurchases: 0 };
    cached = { at: Date.now(), monthKey, value: fallback };
    return fallback;
  }
}

/** Test seam — drops the memoized reading. */
export function resetVolumeCostDiscountCache(): void {
  cached = null;
}
