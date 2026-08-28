import "server-only";

// Lifetime savings for the account dashboard — the "you've saved $482.17"
// number that makes staying subscribed feel obviously right. Summed from the
// customer's REAL order records (never estimated): checkout discounts +
// store credit redeemed + points redeemed. Refunded orders are excluded so
// the figure only counts money actually kept.

import { supabaseAdmin } from "@/lib/supabase-server";
import { PAID_ORDER_STATUSES } from "@/lib/ledger";
import { pointsToDollars } from "@/lib/points-math";
import { readAllRowsBounded } from "@/lib/supabase-page";

/**
 * Ceiling on the paged read below. Far above any real customer's order history
 * — the point is not the number, it is that reaching it is REPORTED rather than
 * silently returned as the answer.
 */
const MAX_CUSTOMER_ORDERS = 20_000;

type SavingsRow = {
  payment_status: string | null;
  discount_amount: number | null;
  store_credit_redeemed_cents: number | null;
  points_redeemed: number | null;
};

export interface LifetimeSavings {
  /**
   * False when the read FAILED, as distinct from a customer who has genuinely
   * saved nothing. Both used to arrive here as total: 0, and the account page
   * renders the savings panel on `total > 0` — so a database that would not
   * answer looked exactly like a new customer, and the "Lifetime saved" tile
   * was quietly replaced by a Free shipping advert. The customer was told
   * nothing was wrong and shown marketing in place of their own money.
   *
   * The sibling tile on that same screen already gets this right: point balance
   * renders "—" over "Couldn't load right now" when its read returns null. This
   * is that, for savings.
   */
  available: boolean;
  total: number;
  discounts: number;
  storeCredit: number;
  points: number;
  paidOrders: number;
}

/** A customer who has genuinely saved nothing. */
const ZERO: LifetimeSavings = { available: true, total: 0, discounts: 0, storeCredit: 0, points: 0, paidOrders: 0 };

/** The read did not answer. Numerically identical to ZERO, and not the same thing. */
const UNAVAILABLE: LifetimeSavings = { ...ZERO, available: false };

export async function getLifetimeSavings(userId: string): Promise<LifetimeSavings> {
  try {
    // PAGED, NOT `.limit(2000)`. That limit asked for two thousand rows from a
    // server that will not return more than `db-max-rows` — 1000 on Supabase —
    // and does not say when it stops. So the ceiling the code appeared to set
    // was never the one that applied, and past a thousand orders this figure
    // would have quietly become "your savings on some of your orders".
    //
    // Ordered on `id` because paging needs a unique key: `created_at` is not
    // unique, so a boundary landing inside a same-timestamp group could repeat
    // or skip an order — and either one moves the customer's money.
    const { rows: data, truncated } = await readAllRowsBounded<SavingsRow>(
      (from, to) => supabaseAdmin
        .from("orders")
        .select("payment_status, discount_amount, store_credit_redeemed_cents, points_redeemed")
        .eq("customer_user_id", userId)
        .order("id", { ascending: true })
        .range(from, to) as unknown as PromiseLike<{ data: SavingsRow[] | null; error: unknown }>,
      { maxRows: MAX_CUSTOMER_ORDERS, label: "lifetime savings read" },
    );

    // A short read is a WRONG figure, not a small one, and this number is shown
    // to the customer as their own money. Unavailable is the honest answer.
    if (truncated) {
      console.error("[member-savings] lifetime savings read hit its ceiling", { userId, maxRows: MAX_CUSTOMER_ORDERS });
      return UNAVAILABLE;
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
      available: true,
      total: round(discounts + storeCredit + points),
      discounts: round(discounts),
      storeCredit: round(storeCredit),
      points: round(points),
      paidOrders,
    };
  } catch (cause) {
    console.error("[member-savings] lifetime savings read threw", { userId, cause });
    return UNAVAILABLE;
  }
}
