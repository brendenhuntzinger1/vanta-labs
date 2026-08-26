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
  | "stale_pending"
  | "scan_truncated";

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
  scan_truncated: "Not every order could be checked — results are incomplete",
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
  const CORE_COLUMNS =
    "order_id, customer_email, subtotal, shipping_amount, discount_amount, tax_amount, card_processing_fee, store_credit_redeemed_cents, points_redeemed, amount_paid, refund_amount, payment_status, paid_at, created_at";

  // Columns that a pre-migration environment may not have. Both are terms of the
  // charged total, so a missing one softens the check rather than invalidating
  // it. Dropped one at a time, most-recent first, so an environment missing only
  // one still reconciles on the other.
  const OPTIONAL_COLUMNS = ["shipping_protection_fee", "handling_fee"] as const;

  // Typed explicitly because the column list is chosen at runtime, which defeats
  // supabase-js's inference from a literal select string.
  type ReconciliationRow = {
    order_id: string;
    customer_email: string | null;
    subtotal: number | null;
    shipping_amount: number | null;
    discount_amount: number | null;
    handling_fee: number | null;
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

  // PAGED, AND CHECKED AGAINST THE REAL TOTAL.
  //
  // This used to be a bare `.limit(2000)` with no paging: past 2000 orders the
  // screen silently stopped looking, and an order short by any amount simply
  // never appeared. Reproduced with 2,101 generated orders — a $114
  // underpayment on the oldest one produced an EMPTY flag list.
  //
  // Two separate things can cut a read short, so the number of rows actually
  // examined is compared against a COUNT of the table further down rather than
  // inferred:
  //   1. MAX_RECONCILIATION_ORDERS below, if the store ever outgrows it;
  //   2. PostgREST's `db-max-rows`, a server setting this application cannot
  //      see, which caps every response without telling the caller.
  // Either way the operator is told, because this is the screen they open when
  // they already suspect something is wrong, and a quietly incomplete answer
  // there is worse than an error.
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
      // readAllRowsBounded throws on a page error; the missing-column fallback
      // below still needs to inspect it, so it is handed back rather than
      // rethrown. (The local pager this replaced advanced by a fixed stride and
      // stopped on any short page — safe only while db-max-rows is exactly the
      // page size, which is the very setting this cannot see.)
      const cause = err as { message?: string; code?: string };
      return { data: null as ReconciliationRow[] | null, error: { message: String(cause.message ?? err), code: cause.code } as ReadError };
    }
  };

  // Ask for everything, and drop optional columns one at a time if the
  // migration has not been applied — the same degradation insertOrderRow uses.
  // Reconciliation reporting an error is worse than reconciliation reporting
  // slightly softer results, and this is the screen an operator opens when they
  // already suspect something is wrong.
  //
  // It used to degrade on `shipping_protection_fee` alone. `handling_fee` was
  // later added to the formula as a second optional term, but not to the
  // fallback, so an environment missing THAT one threw instead of softening —
  // the opposite of what the paragraph above promises.
  // PostgREST names the offending column when it can ("column orders.x does not
  // exist"), and sometimes reports only a stale schema cache. Prefer the named
  // column; fall back to dropping the newest optional one. Matching on the
  // generic phrase FIRST would drop the wrong column and leave the real one in
  // the next query, which just fails again one column poorer.
  const namesColumn = (err: ReadError, column: string) =>
    String(err?.message ?? "").toLowerCase().includes(column);
  const looksLikeMissingColumn = (err: ReadError) => {
    const message = String(err?.message ?? "").toLowerCase();
    return err?.code === "PGRST204"
      || message.includes("does not exist")
      || message.includes("schema cache");
  };

  const present = new Set<string>(OPTIONAL_COLUMNS);
  let data: ReconciliationRow[] | null = null;
  let error: ReadError = null;
  for (let attempt = 0; attempt <= OPTIONAL_COLUMNS.length; attempt += 1) {
    const columns = [CORE_COLUMNS, ...OPTIONAL_COLUMNS.filter((c) => present.has(c))].join(", ");
    ({ data, error } = await read(columns));
    if (!error) break;
    // Drop the optional column the error actually names; if it names none but
    // still looks like a schema gap, drop the newest still in play. Anything
    // else is a real failure and must surface — a permission error or a dead
    // connection must never read as "nothing wrong with your orders".
    const named = OPTIONAL_COLUMNS.find((c) => present.has(c) && namesColumn(error, c));
    const dropped = named
      ?? (looksLikeMissingColumn(error) ? [...OPTIONAL_COLUMNS].reverse().find((c) => present.has(c)) : undefined);
    if (!dropped) throw error;
    present.delete(dropped);
  }
  if (error) throw error;
  const protectionColumnPresent = present.has("shipping_protection_fee");

  const flags: ReconciliationFlag[] = [];
  const staleThreshold = Date.now() - 24 * 60 * 60 * 1000;

  // How many orders exist, independently of how many were read. A count query
  // is a single round trip and is not subject to db-max-rows.
  const { count: totalOrders } = await supabaseAdmin
    .from("orders")
    .select("id", { count: "exact", head: true });
  const examined = (data ?? []).length;
  if (typeof totalOrders === "number" && examined < totalOrders) {
    flags.push({
      orderId: "",
      customerEmail: null,
      type: "scan_truncated",
      detail: `Checked the ${examined.toLocaleString()} most recent of ${totalOrders.toLocaleString()} orders. Older orders were not checked.`,
      createdAt: new Date().toISOString(),
    });
  }

  for (const order of data ?? []) {
    const orderId = String(order.order_id);
    const customerEmail = order.customer_email ? String(order.customer_email) : null;
    const subtotal = roundMoney(Number(order.subtotal ?? 0));
    const shipping = roundMoney(Number(order.shipping_amount ?? 0));
    const discount = roundMoney(Number(order.discount_amount ?? 0));
    const handlingFee = roundMoney(Number(order.handling_fee ?? 0));
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
    const expectedTotal = expectedOrderTotal({ subtotal, shipping, tax, cardFee, discount, storeCredit, pointsDollars, shippingProtection, handlingFee });
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
  // Counts DISTINCT ORDERS with a problem — an order can raise several flags.
  // The truncation notice is not an order and carries no id, so it is counted
  // once in its own right rather than folded into the empty-string bucket.
  const uniqueOrderIds = new Set(flags.filter((flag) => flag.orderId).map((flag) => flag.orderId));
  const truncated = flags.some((flag) => flag.type === "scan_truncated") ? 1 : 0;
  return uniqueOrderIds.size + truncated;
}
