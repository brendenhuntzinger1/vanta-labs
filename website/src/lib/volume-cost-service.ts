import "server-only";

import { supabaseAdmin } from "@/lib/supabase-server";
import { getControlSnapshot } from "@/lib/admin-control";
import { PAID_ORDER_STATUSES, netOrderRevenue } from "@/lib/ledger";
import {
  DEFAULT_VOLUME_COST_DISCOUNT_CONFIG,
  normalizeVolumeCostTiers,
  resolveVolumeCostDiscount,
  type ResolvedVolumeCostDiscount,
  type VolumeCostDiscountConfig,
} from "@/lib/volume-cost-discount";

// -------------------------------------------------------------------------
// Reads the live inputs for the volume cost discount: the admin-editable tier
// schedule, and how much the store has actually sold this month.
//
// Kept separate from the pure math in `volume-cost-discount.ts` so the tier
// boundaries stay unit-testable without a database.
// -------------------------------------------------------------------------

/** Start of the current month, matching the UTC boundary the revenue dashboard
 *  already uses for "today" — so the tier and the reports agree on the period. */
export function startOfCurrentMonthIso(now: Date = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
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

/** Net sales (paid minus refunded) banked so far in the current month. */
export async function getMonthToDateNetSales(now: Date = new Date()): Promise<number> {
  const monthStart = startOfCurrentMonthIso(now);
  const { data, error } = await supabaseAdmin
    .from("orders")
    .select("amount_paid, refund_amount")
    .in("payment_status", Array.from(PAID_ORDER_STATUSES))
    .gte("paid_at", monthStart)
    .limit(10000);

  if (error) throw error;

  const total = (data ?? []).reduce((sum, row) => sum + netOrderRevenue(row), 0);
  return Math.round(total * 100) / 100;
}

// A checkout must not pay for a fresh aggregate every time. The figure only
// moves as orders are captured, and a stale-by-a-minute reading can only mean a
// tier is honoured a minute late — never that cost is understated on a tier the
// store has not earned.
const CACHE_TTL_MS = 60_000;
let cached: { at: number; value: ResolvedVolumeCostDiscount } | null = null;

/**
 * The cost reduction the store has earned right now.
 *
 * Never throws: if sales can't be read, it returns 0% (full cost). Failing
 * closed matters — an unreadable total must not hand out the top tier and let
 * the checkout profit floor approve orders against a cost the store isn't
 * actually paying.
 */
export async function getCurrentVolumeCostDiscount(options?: { force?: boolean }): Promise<ResolvedVolumeCostDiscount> {
  if (!options?.force && cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached.value;
  }

  try {
    const [config, monthlySales] = await Promise.all([getVolumeCostDiscountConfig(), getMonthToDateNetSales()]);
    const resolved = resolveVolumeCostDiscount(monthlySales, config);
    cached = { at: Date.now(), value: resolved };
    return resolved;
  } catch {
    const fallback: ResolvedVolumeCostDiscount = { percent: 0, tier: null, monthlySales: 0 };
    cached = { at: Date.now(), value: fallback };
    return fallback;
  }
}

/** Test seam — drops the memoized reading. */
export function resetVolumeCostDiscountCache(): void {
  cached = null;
}
