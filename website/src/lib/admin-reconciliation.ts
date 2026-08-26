import "server-only";

import { supabaseAdmin } from "@/lib/supabase-server";
import { expectedOrderTotal, isTotalMismatch, maxShippingProtectionFee } from "@/lib/reconciliation-math";
import { readAllRowsBounded } from "@/lib/supabase-page";
import { pointsToDollars } from "@/lib/points-math";

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

// Ceiling on one sweep, not a definition of the answer. The old `.limit(2000)`
// meant an order that stopped reconciling could never be flagged once 2,000
// newer orders existed — on the one screen an operator opens BECAUSE they think
// the ledger is wrong.
const MAX_RECONCILIATION_ORDERS = 200_000;

export async function getReconciliationFlags(): Promise<ReconciliationFlag[]> {
  const BASE_COLUMNS =
    "order_id, customer_email, subtotal, shipping_amount, discount_amount, tax_amount, card_processing_fee, store_credit_redeemed_cents, points_redeemed, amount_paid, refund_amount, payment_status, paid_at, created_at";

  // Typed explicitly because the column list is chosen at runtime, which defeats
  // supabase-js's inference from a literal select string.
  type ReconciliationRow = {
    order_id: string;
    customer_email: string | null;
    subtotal: number | null;
    shipping_amount: number | null;
    discount_amount: number | null;
    tax_amount: number | null;
    card_processing_fee: number | null;
    store_credit_redeemed_cents: number | null;
    points_redeemed: number | null;
    amount_paid: number | null;
    refund_amount: number | null;
    payment_status: string | null;
    paid_at: string | null;
    created_at: string;
    shipping_protection_fee?: number | null;
  };

  type ReadError = { message?: string; code?: string } | null;

  const read = async (columns: string) => {
    try {
      const { rows } = await readAllRowsBounded<ReconciliationRow>(
        (from, to) =>
          supabaseAdmin
            .from("orders")
            .select(columns)
            // created_at is not unique; order_id breaks the ties so paging can
            // neither repeat nor skip a row.
            .order("created_at", { ascending: false })
            .order("order_id", { ascending: true })
            .range(from, to) as unknown as PromiseLike<{ data: ReconciliationRow[] | null; error: { message?: string } | null }>,
        { maxRows: MAX_RECONCILIATION_ORDERS, label: "reconciliation read" },
      );
      return { data: rows, error: null as ReadError };
    } catch (err) {
      // readAllRows throws on a page error; the missing-column fallback below
      // still needs to inspect it, so it is handed back rather than rethrown.
      const cause = err as { message?: string; code?: string };
      return { data: null as ReconciliationRow[] | null, error: { message: String(cause.message ?? err), code: cause.code } as ReadError };
    }
  };

  // Ask for the protection fee, and fall back to the original column set if the
  // migration has not been applied — the same degradation insertOrderRow uses.
  // Reconciliation reporting an error is worse than reconciliation reporting
  // slightly softer results, and this is the screen an operator opens when they
  // already suspect something is wrong.
  let { data, error } = await read(`${BASE_COLUMNS}, shipping_protection_fee`);
  let protectionColumnPresent = true;
  if (error) {
    const message = String(error.message ?? "").toLowerCase();
    const missingColumn =
      error.code === "PGRST204" ||
      message.includes("shipping_protection_fee") ||
      message.includes("does not exist") ||
      message.includes("schema cache");
    if (!missingColumn) throw error;
    protectionColumnPresent = false;
    ({ data, error } = await read(BASE_COLUMNS));
    if (error) throw error;
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
    // points_redeemed is stored in POINTS. This used to divide by a hardcoded
    // 100 — a fifth copy of a redemption rate that already has a name and an
    // exported constant (points-math.POINTS_PER_DOLLAR_REDEMPTION). The two
    // agree today, so nothing was wrong; the moment the rate changes, the
    // hardcoded copy would flag every points-redeeming order as a mismatch on
    // the screen the owner opens to find real ones.
    const pointsDollars = roundMoney(pointsToDollars(Number(order.points_redeemed ?? 0)));
    const amountPaid = roundMoney(Number(order.amount_paid ?? 0));
    const refundAmount = roundMoney(Number(order.refund_amount ?? 0));
    // expectedOrderTotal + isTotalMismatch are pure and unit-tested in
    // reconciliation-math.test.ts.
    //
    // With orders.shipping_protection_fee recorded, the fee goes INTO the
    // expected total and the allowance drops to zero — the check is exact to
    // the cent. Only a row from before that column existed still gets the old
    // "anything up to the maximum possible fee is fine" band, which could not
    // distinguish a protection fee from an overcharge of the same size.
    const shippingProtection = protectionColumnPresent
      ? roundMoney(Number(order.shipping_protection_fee ?? 0))
      : 0;
    const expectedTotal = expectedOrderTotal({ subtotal, shipping, tax, cardFee, discount, storeCredit, pointsDollars, shippingProtection });
    const maxProtection = protectionColumnPresent ? 0 : maxShippingProtectionFee(subtotal);
    const paymentStatus = String(order.payment_status ?? "");
    const createdAt = String(order.created_at);

    if (isTotalMismatch(amountPaid, expectedTotal, maxProtection)) {
      flags.push({
        orderId,
        customerEmail,
        type: "total_mismatch",
        detail: `Expected $${expectedTotal.toFixed(2)}${maxProtection > 0 && amountPaid > expectedTotal ? ` (+ up to $${maxProtection.toFixed(2)} unrecorded protection)` : ""}, recorded $${amountPaid.toFixed(2)}`,
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
