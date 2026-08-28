import "server-only";

// Lifetime savings for the account dashboard — the "you've saved $482.17"
// number that makes staying subscribed feel obviously right. Summed from the
// customer's REAL order records (never estimated): checkout discounts +
// store credit redeemed + points redeemed. Refunded orders are excluded so
// the figure only counts money actually kept.

import { supabaseAdmin } from "@/lib/supabase-server";
import { PAID_ORDER_STATUSES } from "@/lib/ledger";
import { pointsToDollars } from "@/lib/points-math";

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
    // A FAILED READ IS NOT $0.00 OF SAVINGS, and this function has no way to
    // say so: its return type is LifetimeSavings, and the account dashboard
    // renders `lifetimeSavings.total` as a confident "Lifetime saved $0.00".
    // Until the caller can render an unknown (the way it already does for a
    // null points balance), the least this can do is leave a record — a
    // customer reporting "my savings vanished" currently produces no log line
    // at all to correlate against.
    if (error || !data) {
      console.error("Lifetime savings read failed; reporting zero:", error);
      return ZERO;
    }

    let discounts = 0;
    let storeCredit = 0;
    let points = 0;
    let paidOrders = 0;
    for (const order of data) {
      if (!PAID_ORDER_STATUSES.has(String(order.payment_status ?? "").toLowerCase())) continue;
      paidOrders += 1;
      discounts += Number(order.discount_amount ?? 0);
      storeCredit += Number(order.store_credit_redeemed_cents ?? 0) / 100;
      // points_redeemed is a count of POINTS. Valued through the one exported
      // redemption rate, not a local `/ 100` — the customer's "you have saved"
      // figure and the invoice that itemises the same redemption must not be
      // able to drift apart.
      points += pointsToDollars(Number(order.points_redeemed ?? 0));
    }
    const round = (v: number) => Math.round(v * 100) / 100;
    return {
      total: round(discounts + storeCredit + points),
      discounts: round(discounts),
      storeCredit: round(storeCredit),
      points: round(points),
      paidOrders,
    };
  } catch (e) {
    // Same reasoning as the error branch above.
    console.error("Lifetime savings read threw; reporting zero:", e);
    return ZERO;
  }
}
