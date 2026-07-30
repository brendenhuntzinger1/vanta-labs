import "server-only";

// Lifetime savings for the account dashboard — the "you've saved $482.17"
// number that makes staying subscribed feel obviously right. Summed from the
// customer's REAL order records (never estimated): checkout discounts +
// store credit redeemed + points redeemed. Refunded orders are excluded so
// the figure only counts money actually kept.

import { supabaseAdmin } from "@/lib/supabase-server";
import { PAID_ORDER_STATUSES } from "@/lib/ledger";

export interface LifetimeSavings {
  total: number;
  discounts: number;
  storeCredit: number;
  points: number;
  paidOrders: number;
}

const ZERO: LifetimeSavings = { total: 0, discounts: 0, storeCredit: 0, points: 0, paidOrders: 0 };

export async function getLifetimeSavings(userId: string): Promise<LifetimeSavings> {
  try {
    const { data, error } = await supabaseAdmin
      .from("orders")
      .select("payment_status, discount_amount, store_credit_redeemed_cents, points_redeemed")
      .eq("customer_user_id", userId)
      .limit(2000);
    if (error || !data) return ZERO;

    let discounts = 0;
    let storeCredit = 0;
    let points = 0;
    let paidOrders = 0;
    for (const order of data) {
      if (!PAID_ORDER_STATUSES.has(String(order.payment_status ?? "").toLowerCase())) continue;
      paidOrders += 1;
      discounts += Number(order.discount_amount ?? 0);
      storeCredit += Number(order.store_credit_redeemed_cents ?? 0) / 100;
      points += Number(order.points_redeemed ?? 0) / 100;
    }
    const round = (v: number) => Math.round(v * 100) / 100;
    return {
      total: round(discounts + storeCredit + points),
      discounts: round(discounts),
      storeCredit: round(storeCredit),
      points: round(points),
      paidOrders,
    };
  } catch {
    return ZERO;
  }
}
