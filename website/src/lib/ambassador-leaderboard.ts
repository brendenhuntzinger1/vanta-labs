import { supabaseAdmin } from "@/lib/supabase-server";

// Monthly ambassador leaderboard. Rankings are computed per calendar month
// directly from referral_orders, so each month "resets" naturally while the
// underlying rows (and therefore lifetime stats) stay intact — nothing is
// deleted or mutated to produce a new month.

export interface LeaderboardEntry {
  ambassadorId: string;
  name: string;
  referralCode: string;
  salesTotal: number;      // sum of order value attributed this month
  commissionTotal: number; // commission earned this month
  orderCount: number;
  rank: number;
}

// Commission statuses that represent a genuine, non-reversed sale.
const VALID_STATUSES = ["pending", "approved_for_payout", "paid", "commission_paid"];

// Returns 'YYYY-MM' for the current month (UTC).
export function currentMonthKey(now = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

// Returns 'YYYY-MM' for the previous month (UTC).
export function previousMonthKey(now = new Date()): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function monthBounds(monthKey: string): { startIso: string; endIso: string } {
  const [yearStr, monthStr] = monthKey.split("-");
  const year = Number(yearStr);
  const month = Number(monthStr) - 1; // 0-indexed
  const start = new Date(Date.UTC(year, month, 1));
  const end = new Date(Date.UTC(year, month + 1, 1));
  return { startIso: start.toISOString(), endIso: end.toISOString() };
}

export async function getMonthlyLeaderboard(monthKey: string, limit = 10): Promise<LeaderboardEntry[]> {
  const { startIso, endIso } = monthBounds(monthKey);

  const { data: rows, error } = await supabaseAdmin
    .from("referral_orders")
    .select("ambassador_id, amount_paid, commission_amount, payment_status, created_at")
    .gte("created_at", startIso)
    .lt("created_at", endIso)
    .in("payment_status", VALID_STATUSES);

  if (error) {
    if (String(error.code) === "42P01") return [];
    throw error;
  }

  const byAmbassador = new Map<string, { sales: number; commission: number; count: number }>();
  for (const row of rows ?? []) {
    const id = String(row.ambassador_id ?? "");
    if (!id) continue;
    const agg = byAmbassador.get(id) ?? { sales: 0, commission: 0, count: 0 };
    agg.sales += Number(row.amount_paid ?? 0);
    agg.commission += Number(row.commission_amount ?? 0);
    agg.count += 1;
    byAmbassador.set(id, agg);
  }

  if (byAmbassador.size === 0) return [];

  // Resolve names/codes for the ranked ambassadors.
  const ids = Array.from(byAmbassador.keys());
  const { data: partners } = await supabaseAdmin
    .from("partners")
    .select("id, name, referral_code")
    .in("id", ids);

  const partnerById = new Map((partners ?? []).map((p) => [String(p.id), p]));

  return Array.from(byAmbassador.entries())
    .map(([ambassadorId, agg]) => {
      const partner = partnerById.get(ambassadorId);
      return {
        ambassadorId,
        name: String(partner?.name ?? "Unknown"),
        referralCode: String(partner?.referral_code ?? ""),
        salesTotal: Math.round(agg.sales * 100) / 100,
        commissionTotal: Math.round(agg.commission * 100) / 100,
        orderCount: agg.count,
        rank: 0,
      };
    })
    .sort((a, b) => b.salesTotal - a.salesTotal || b.commissionTotal - a.commissionTotal)
    .slice(0, limit)
    .map((entry, index) => ({ ...entry, rank: index + 1 }));
}
