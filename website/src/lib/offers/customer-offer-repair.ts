import { supabaseAdmin } from "@/lib/supabase-server";
import { recordSystemAlert } from "@/lib/monitoring";
import { redeemCustomerOffer } from "@/lib/offers/customer-offers";

// ---------------------------------------------------------------------------
// A PAID GIFT IS A SPENT GIFT — EVEN WHEN THE WEBHOOK DIED MID-WAY.
//
// The paid webhook redeems the customer offer AFTER the money side-effects.
// If that call fails (function timeout, RPC error) the token stays merely
// "reserved" by an order that has, in fact, paid. Two consequences: reporting
// says the gift was never redeemed, and — until customer_offer_reserve learned
// to refuse a paid reserver (customer-offers.sql, 2026-09-05) — a second
// checkout by the same address could collect the same gift once the hold aged
// out. This sweep step closes the gap from the other side: every offer whose
// reserving order is paid is redeemed now. Idempotent (customer_offer_redeem
// is a no-op once redeemed_at is set), absence-keyed like
// commissionAccrualRepair, and non-throwing on an un-migrated table.
// ---------------------------------------------------------------------------

const REPAIR_BATCH = 200;
const PAID_STATUSES = ["paid", "partially_refunded", "refunded"] as const;

export type CustomerOfferRepairResult = {
  /** Reserved-but-unredeemed offers examined. */
  checked: number;
  /** Offers whose reserving order had paid and are now redeemed. */
  redeemed: number;
  /** Paid reservers the redeem RPC still refused — alerted. */
  failed: number;
};

export async function repairUnredeemedPaidOffers(): Promise<CustomerOfferRepairResult> {
  const { data: offers, error } = await supabaseAdmin
    .from("customer_offers")
    .select("id, reserved_order_id")
    .not("reserved_order_id", "is", null)
    .is("redeemed_at", null)
    .order("reserved_at", { ascending: true })
    .limit(REPAIR_BATCH);
  if (error) {
    // Un-migrated table or a read failure: nothing to repair on this tick, and
    // the sweep must not fail on a retention feature's housekeeping.
    console.warn("[offers] repair read failed", error.message);
    return { checked: 0, redeemed: 0, failed: 0 };
  }
  const rows = (offers ?? []) as Array<{ id: string; reserved_order_id: string | null }>;
  if (rows.length === 0) return { checked: 0, redeemed: 0, failed: 0 };

  const orderIds = Array.from(new Set(rows.map((row) => String(row.reserved_order_id ?? "")).filter(Boolean)));
  const { data: paid, error: orderError } = await supabaseAdmin
    .from("orders")
    .select("order_id")
    .in("order_id", orderIds)
    .in("payment_status", [...PAID_STATUSES]);
  if (orderError) {
    console.warn("[offers] repair order read failed", orderError.message);
    return { checked: rows.length, redeemed: 0, failed: 0 };
  }
  const paidIds = new Set(((paid ?? []) as Array<{ order_id: string }>).map((row) => row.order_id));

  let redeemed = 0;
  let failed = 0;
  for (const row of rows) {
    const orderId = String(row.reserved_order_id ?? "");
    if (!paidIds.has(orderId)) continue;
    if (await redeemCustomerOffer(orderId)) {
      redeemed += 1;
      continue;
    }
    failed += 1;
    await recordSystemAlert({
      type: "customer_offer_redeem_failed",
      severity: "warning",
      message: `Order ${orderId} paid while holding a customer offer, but the offer could not be marked redeemed. The token is refused to any other order, so no second gift can ship; the redemption record is what is missing.`,
      context: { orderId, offerId: row.id },
      dedupeWindowMs: 6 * 60 * 60 * 1000,
    });
  }
  return { checked: rows.length, redeemed, failed };
}
