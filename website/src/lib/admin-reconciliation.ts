import "server-only";

import { supabaseAdmin } from "@/lib/supabase-server";

// "Reconciliation" here means internal ledger consistency - checking that
// this store's own order/commission math holds together - not reconciling
// against a real payment processor's records, since none is connected yet
// (see PaymentProvider.refundPayment being a stub in payment-provider.ts).
// Once a live processor exists, these checks are a starting point, not a
// replacement for reconciling against the processor's own reports.

export type ReconciliationFlagType =
  | "total_mismatch"
  | "refund_exceeds_paid"
  | "paid_without_timestamp"
  | "stale_pending";

export interface ReconciliationFlag {
  orderId: string;
  customerEmail: string | null;
  type: ReconciliationFlagType;
  detail: string;
  createdAt: string;
}

const FLAG_LABELS: Record<ReconciliationFlagType, string> = {
  total_mismatch: "Total doesn't match subtotal + shipping - discount",
  refund_exceeds_paid: "Refund amount exceeds amount paid",
  paid_without_timestamp: "Marked paid but has no paid_at timestamp",
  stale_pending: "Pending payment for over 24 hours",
};

export const RECONCILIATION_FLAG_LABELS = FLAG_LABELS;

function roundMoney(value: number) {
  return Math.round(value * 100) / 100;
}

export async function getReconciliationFlags(): Promise<ReconciliationFlag[]> {
  const { data, error } = await supabaseAdmin
    .from("orders")
    .select("order_id, customer_email, subtotal, shipping_amount, discount_amount, tax_amount, card_processing_fee, store_credit_redeemed_cents, points_redeemed, amount_paid, refund_amount, payment_status, paid_at, created_at")
    .order("created_at", { ascending: false })
    .limit(2000);

  if (error) {
    throw error;
  }

  const flags: ReconciliationFlag[] = [];
  const staleThreshold = Date.now() - 24 * 60 * 60 * 1000;

  for (const order of data ?? []) {
    const orderId = String(order.order_id);
    const customerEmail = order.customer_email ? String(order.customer_email) : null;
    const subtotal = roundMoney(Number(order.subtotal ?? 0));
    const shipping = roundMoney(Number(order.shipping_amount ?? 0));
    const discount = roundMoney(Number(order.discount_amount ?? 0));
    const tax = roundMoney(Number(order.tax_amount ?? 0));
    const cardFee = roundMoney(Number(order.card_processing_fee ?? 0));
    const storeCredit = roundMoney(Number(order.store_credit_redeemed_cents ?? 0) / 100);
    const pointsDollars = roundMoney(Number(order.points_redeemed ?? 0) / 100);
    const amountPaid = roundMoney(Number(order.amount_paid ?? 0));
    const refundAmount = roundMoney(Number(order.refund_amount ?? 0));
    // Mirror payment-service's amount_paid formula: merchandise − discount + tax
    // + card fee, less store credit and points redeemed. The optional
    // shipping-protection fee ($2.49–$4.99) is folded into amount_paid but not
    // stored as its own column, so a fully-reconciled order lands between
    // expectedTotal and expectedTotal + the max protection fee. We only flag a
    // TRUE mismatch: underpayment, or an overage beyond the max protection fee.
    const expectedTotal = roundMoney(subtotal + tax + cardFee + shipping - discount - storeCredit - pointsDollars);
    const MAX_PROTECTION_FEE = 4.99;
    const paymentStatus = String(order.payment_status ?? "");
    const createdAt = String(order.created_at);

    if (amountPaid < expectedTotal - 0.01 || amountPaid > expectedTotal + MAX_PROTECTION_FEE + 0.01) {
      flags.push({
        orderId,
        customerEmail,
        type: "total_mismatch",
        detail: `Expected $${expectedTotal.toFixed(2)}${amountPaid > expectedTotal ? ` (+ up to $${MAX_PROTECTION_FEE.toFixed(2)} protection)` : ""}, recorded $${amountPaid.toFixed(2)}`,
        createdAt,
      });
    }

    if (refundAmount > amountPaid + 0.01) {
      flags.push({
        orderId,
        customerEmail,
        type: "refund_exceeds_paid",
        detail: `Refunded $${refundAmount.toFixed(2)} against $${amountPaid.toFixed(2)} paid`,
        createdAt,
      });
    }

    if (paymentStatus === "paid" && !order.paid_at) {
      flags.push({
        orderId,
        customerEmail,
        type: "paid_without_timestamp",
        detail: "payment_status is paid but paid_at is empty",
        createdAt,
      });
    }

    const createdMs = createdAt ? new Date(createdAt).getTime() : NaN;
    if (paymentStatus === "pending_payment" && Number.isFinite(createdMs) && createdMs < staleThreshold) {
      flags.push({
        orderId,
        customerEmail,
        type: "stale_pending",
        detail: `Created ${new Date(createdMs).toLocaleString()}`,
        createdAt,
      });
    }
  }

  return flags;
}

export async function getReconciliationFlagCount(): Promise<number> {
  const flags = await getReconciliationFlags();
  const uniqueOrderIds = new Set(flags.map((flag) => flag.orderId));
  return uniqueOrderIds.size;
}
