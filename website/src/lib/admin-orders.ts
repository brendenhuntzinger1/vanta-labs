import { FULFILLMENT_STATUS_LABELS } from "@/lib/order-pipeline";
import "server-only";

import { supabaseAdmin } from "@/lib/supabase-server";
import { findPaidRetry, PAID_RETRY_WINDOW_MS, type PaidOrderCandidate, type PaidRetryLink } from "@/lib/payment-failure";
import { sendEmail } from "@/lib/email/send";
import { enqueueFailedEmail } from "@/lib/email/retry-queue";
import { shippingUpdateTemplate } from "@/lib/email/templates";
import { setOrderFulfillmentStatus } from "@/lib/shippo/service";
import { getSiteUrl } from "@/lib/env";

export interface AdminOrderRow {
  id: string;
  order_id: string;
  /** The VL-XXXXXXXX reference the customer is given and quotes to support. */
  order_number: string | null;
  customer_email: string | null;
  customer_name: string | null;
  amount_paid: number;
  tax_amount: number;
  referral_code: string | null;
  coupon_code: string | null;
  payment_status: string;
  /**
   * WHY a payment_failed row failed — processor_declined | checkout_expired |
   * other — with the processor's own words when it sent any. Null on rows that
   * are not failed and on failures recorded before 2026-09-04. See
   * payment-failure.ts for the vocabulary and sql/payment-failure-detail.sql
   * for the columns.
   */
  payment_failure_kind: string | null;
  payment_failure_code: string | null;
  payment_failure_reason: string | null;
  payment_failed_at: string | null;
  /**
   * The paid order the same shopper placed shortly after this unpaid one, when
   * there is one. Computed at read time — nothing is written — so the list can
   * say "they retried and paid" instead of leaving a failed row to look like a
   * lost sale.
   */
  paid_retry: PaidRetryLink | null;
  fulfillment_status: string;
  refund_amount: number;
  created_at: string;
  item_count: number;
}

// "active" is the default view: real orders only — it hides abandoned/unpaid
// checkouts (pending_payment) and expired/canceled ones, which are just
// abandoned carts, not sales. "all" shows everything including those.
export type AdminOrderPaymentStatusFilter = "active" | "all" | "pending_payment" | "paid" | "partially_refunded" | "refunded" | "payment_failed" | "canceled";
export type AdminOrderFulfillmentStatusFilter = "all" | "pending" | "awaiting_fulfillment" | "shipped" | "delivered" | "cancelled";

export interface AdminOrderFilters {
  search?: string;
  paymentStatus?: AdminOrderPaymentStatusFilter;
  fulfillmentStatus?: AdminOrderFulfillmentStatusFilter;
  page?: number;
  pageSize?: number;
}

export interface AdminOrderListResult {
  rows: AdminOrderRow[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
}

// PostgREST's .or() filter string is comma-delimited, so a raw search term
// could break the query (or, worse, inject unintended filter clauses).
// Keep only characters that legitimately appear in an order id, email, or
// customer name.
function sanitizeSearchTerm(value: string) {
  return value.trim().replace(/[^a-zA-Z0-9@._\- ]/g, "").slice(0, 100);
}

export async function getAdminOrderRows(filters: AdminOrderFilters = {}): Promise<AdminOrderListResult> {
  const page = Math.max(1, Math.trunc(filters.page ?? 1));
  const pageSize = Math.min(100, Math.max(1, Math.trunc(filters.pageSize ?? 25)));
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  let query = supabaseAdmin
    .from("orders")
    .select(
      "id, order_id, order_number, customer_email, customer_name, amount_paid, tax_amount, referral_code, coupon_code, payment_status, payment_failure_kind, payment_failure_code, payment_failure_reason, payment_failed_at, fulfillment_status, refund_amount, order_type, created_at",
      { count: "exact" },
    )
    .order("created_at", { ascending: false });

  const search = sanitizeSearchTerm(filters.search ?? "");
  if (search) {
    // order_number first: it is the reference on the confirmation page and in
    // the confirmation email, so it is what a customer quotes to support.
    query = query.or(`order_number.ilike.%${search}%,order_id.ilike.%${search}%,customer_email.ilike.%${search}%,customer_name.ilike.%${search}%`);
  }

  if (filters.paymentStatus === "active") {
    // Default view: exclude abandoned/unpaid checkouts and expired/canceled
    // ones — those are abandoned carts, not orders.
    query = query.not("payment_status", "in", "(pending_payment,canceled,cancelled)");
    // A checkout session the processor expired or the shopper cancelled is an
    // abandoned cart too: payment_failed by status, but no charge was ever
    // attempted (payment-failure.ts, checkout_expired). Until 2026-09-04 these
    // were indistinguishable from declines, so they sat in the active view
    // under a subtitle promising abandoned checkouts were hidden. Declines and
    // failures with no recorded kind stay visible; NULL kinds must pass, which
    // is why this is an .or() and not a plain .neq().
    //
    // SCOPED TO ROWS THAT ARE STILL FAILED. The paid flip never clears the
    // failure columns (a paid row keeps "first attempt declined" as history),
    // and payment_failed -> paid is an allowed transition — a session the
    // sweep retired as expired can still settle late. Keyed on the kind alone,
    // that order would have vanished from the default list the moment it was
    // paid. Caught by the round-two pre-merge review.
    query = query.or("payment_status.neq.payment_failed,payment_failure_kind.is.null,payment_failure_kind.neq.checkout_expired");
  } else if (filters.paymentStatus && filters.paymentStatus !== "all") {
    query = query.eq("payment_status", filters.paymentStatus);
  }

  if (filters.fulfillmentStatus && filters.fulfillmentStatus !== "all") {
    query = query.eq("fulfillment_status", filters.fulfillmentStatus);
  }

  const { data, error, count } = await query.range(from, to);

  if (error) {
    throw error;
  }

  const orders = data ?? [];
  const orderIds = orders.map((order) => order.order_id);

  const itemCounts = new Map<string, number>();
  if (orderIds.length > 0) {
    const { data: itemData, error: itemError } = await supabaseAdmin
      .from("order_items")
      .select("order_id, quantity")
      .in("order_id", orderIds);

    if (itemError) {
      throw itemError;
    }

    for (const item of itemData ?? []) {
      const current = itemCounts.get(item.order_id) ?? 0;
      itemCounts.set(item.order_id, current + Number(item.quantity ?? 0));
    }
  }

  const paidRetries = await findPaidRetries(orders);

  const total = count ?? 0;

  return {
    rows: orders.map((order) => ({
      id: order.id,
      order_id: order.order_id,
      order_number: order.order_number ?? null,
      customer_email: order.customer_email,
      customer_name: order.customer_name,
      amount_paid: Number(order.amount_paid ?? 0),
      tax_amount: Number(order.tax_amount ?? 0),
      referral_code: order.referral_code,
      coupon_code: order.coupon_code,
      payment_status: order.payment_status,
      payment_failure_kind: order.payment_failure_kind ?? null,
      payment_failure_code: order.payment_failure_code ?? null,
      payment_failure_reason: order.payment_failure_reason ?? null,
      payment_failed_at: order.payment_failed_at ?? null,
      paid_retry: paidRetries.get(order.order_id) ?? null,
      fulfillment_status: order.fulfillment_status,
      refund_amount: Number(order.refund_amount ?? 0),
      created_at: order.created_at,
      item_count: itemCounts.get(order.order_id) ?? 0,
    })),
    total,
    page,
    pageSize,
    pageCount: Math.max(1, Math.ceil(total / pageSize)),
  };
}

/** Rows that can, in principle, have been retried: every kind of not-paid. */
const RETRY_CANDIDATE_STATUSES = new Set(["payment_failed", "pending_payment", "canceled", "cancelled"]);

interface RetryCandidateRow {
  order_id: string;
  customer_email: string | null;
  created_at: string;
  amount_paid: number | string | null;
  payment_status: string | null;
  order_type?: string | null;
}

/**
 * For every unpaid row on the page, the paid order the same shopper placed
 * within PAID_RETRY_WINDOW_MS afterwards — one query for the whole page.
 *
 * READ-TIME AND BEST-EFFORT. Nothing is written, so a wrong match can mislabel
 * a badge and nothing else; and a failed read returns no links rather than
 * failing the page, because this is a convenience over the order list, not
 * part of it. The matching itself lives in payment-failure.ts, where it is
 * tested.
 */
async function findPaidRetries(rows: readonly RetryCandidateRow[]): Promise<Map<string, PaidRetryLink>> {
  const links = new Map<string, PaidRetryLink>();
  const candidates = rows.filter(
    (row) => RETRY_CANDIDATE_STATUSES.has(String(row.payment_status ?? "").toLowerCase()) && String(row.customer_email ?? "").trim(),
  );
  if (candidates.length === 0) return links;

  // The stored spelling and its lower-case form both go in the IN list, so a
  // retry typed with different capitalisation is still found. The comparison
  // that decides a match is case-insensitive (findPaidRetry); this only makes
  // sure the row is fetched at all.
  const emails = new Set<string>();
  let earliest = Number.POSITIVE_INFINITY;
  let latest = Number.NEGATIVE_INFINITY;
  for (const row of candidates) {
    const email = String(row.customer_email).trim();
    emails.add(email);
    emails.add(email.toLowerCase());
    const at = Date.parse(row.created_at);
    if (Number.isFinite(at)) {
      earliest = Math.min(earliest, at);
      latest = Math.max(latest, at);
    }
  }
  if (!Number.isFinite(earliest)) return links;

  try {
    const { data, error } = await supabaseAdmin
      .from("orders")
      .select("order_id, order_number, customer_email, created_at, amount_paid, order_type")
      .eq("payment_status", "paid")
      // A $0 replacement shipment is not a sale (ledger.ts); the same-kind rule
      // in findPaidRetry also drops it, this just keeps it out of the read.
      .neq("order_type", "replacement")
      .in("customer_email", Array.from(emails))
      .gt("created_at", new Date(earliest).toISOString())
      .lte("created_at", new Date(latest + PAID_RETRY_WINDOW_MS).toISOString())
      .order("created_at", { ascending: true })
      .limit(500);
    if (error || !data) {
      // Non-fatal by design, but never silent: one email with an unescapable
      // character in it makes this single IN-list read fail and every unpaid
      // row on the page loses its link, which would otherwise look exactly like
      // "nobody retried".
      console.warn("[admin-orders] paid-retry lookup failed", { message: error?.message, code: error?.code });
      return links;
    }

    const paid: PaidOrderCandidate[] = data.map((row) => ({
      order_id: String(row.order_id),
      order_number: row.order_number ? String(row.order_number) : null,
      customer_email: row.customer_email ? String(row.customer_email) : null,
      created_at: String(row.created_at),
      amount_paid: Number(row.amount_paid ?? 0),
      order_type: row.order_type ? String(row.order_type) : null,
    }));

    for (const row of candidates) {
      const link = findPaidRetry(
        {
          customer_email: row.customer_email,
          created_at: row.created_at,
          amount_paid: Number(row.amount_paid ?? 0),
          order_type: row.order_type ?? null,
        },
        paid,
      );
      if (link) links.set(row.order_id, link);
    }
  } catch (error) {
    // A badge is never worth a failed page — but see above: say so.
    console.warn("[admin-orders] paid-retry lookup threw", { message: error instanceof Error ? error.message : String(error) });
  }
  return links;
}

/** The order page's version of the same question, for one order. */
export async function findPaidRetryForOrder(row: RetryCandidateRow): Promise<PaidRetryLink | null> {
  const links = await findPaidRetries([row]);
  return links.get(row.order_id) ?? null;
}

/**
 * MARK_DELIVERED IS DELIBERATELY ABSENT.
 *
 * `delivered` is carrier-authoritative: FULFILLMENT_STATUS_SOURCES in
 * order-pipeline.ts lists exactly ["shippo"] for it, because the only honest
 * evidence a parcel arrived is the carrier saying so. This function used to
 * write it anyway, with a raw UPDATE that never consulted the pipeline — so a
 * dashboard button could assert delivery the carrier had never reported, and
 * the customer got a "delivered" email for a parcel still on a van.
 *
 * If a parcel is genuinely delivered and the carrier never scanned it, that is
 * an exception to work, not a routine bulk action. A privileged single-order
 * override belongs behind its own confirmation, reason and audit entry; it is
 * not part of the normal workflow and is not implemented here.
 */
export type AdminOrderBulkAction = "mark_shipped" | "cancel";

/**
 * Statuses a customer is told about, matching the single-order route exactly.
 * "cancelled" is deliberately absent there and here: a cancellation is handled
 * by the refund flow, which has its own message.
 */
const BULK_NOTIFY_STATUSES = new Set(["shipped"]);

/** One order's outcome. A bulk action reports per order, never in aggregate. */
export interface BulkOrderOutcome {
  orderId: string;
  ok: boolean;
  /** Why it was refused, in the pipeline's own words. */
  reason?: string;
}

/**
 * Apply a bulk fulfillment action AND tell the affected customers.
 *
 * The notification is the point of this function's length. Marking one order
 * shipped from the order page emails that customer; marking fifty shipped from
 * the list used to email nobody, so whether a customer heard their order had
 * left depended on which screen an operator happened to use. Support then
 * fields "has my order shipped?" for orders that shipped days ago.
 *
 * The rules are lifted from the single-order route rather than reinvented:
 *   * only a REAL transition notifies — re-running "mark shipped" over orders
 *     that are already shipped sends nothing, so a double-click or an operator
 *     re-applying an action to a filtered list cannot spam anyone;
 *   * only "shipped" notifies — "delivered" is no longer a bulk action at all,
 *     because the carrier owns that state;
 *   * sending is best-effort per order. The status change is the operation the
 *     admin asked for and it has already committed; one bad address must not
 *     roll it back or abort the rest of the batch.
 */
export async function bulkUpdateAdminOrders(input: { orderIds: string[]; action: AdminOrderBulkAction; actor?: string | null }) {
  if (input.orderIds.length === 0) {
    return { updated: 0, notified: 0, failed: [] as BulkOrderOutcome[] };
  }

  let nextStatus: string;

  switch (input.action) {
    case "mark_shipped":
      nextStatus = "shipped";
      break;
    case "cancel":
      nextStatus = "cancelled";
      break;
    default:
      throw new Error("Unsupported bulk action");
  }

  // Read the PRIOR state before updating: afterwards every row reads as the new
  // status, and "did this actually change?" becomes unanswerable.
  const { data: before } = await supabaseAdmin
    .from("orders")
    .select("order_id, order_number, customer_email, customer_name, fulfillment_status, tracking_number")
    .in("order_id", input.orderIds);

  // ---------------------------------------------------------------------------
  // ONE ORDER AT A TIME, THROUGH THE PIPELINE.
  //
  // This was a single `.update().in(order_id, ids)` — one statement, no
  // transition check, no history, no payment guard. It could move an order from
  // any state to any other, including states the pipeline reserves for the
  // carrier, and it left no trace in order_status_history, so an operator's
  // change was invisible in the customer-facing timeline.
  //
  // Per-order is slower and that is the correct trade: a bulk action is fifty
  // individual decisions, and fifty orders in different states do not all have
  // the same legal move. setOrderFulfillmentStatus is the same writer the
  // single-order screen and the Shippo webhook use, so all three now obey one
  // set of rules and write one history table.
  //
  // A refusal is NOT an error. Re-running "mark shipped" over a filtered list
  // that already contains shipped orders should skip them quietly, which is
  // exactly what canTransition's "unchanged" rejection does.
  // ---------------------------------------------------------------------------
  const outcomes: BulkOrderOutcome[] = [];
  const changed = new Set<string>();

  for (const orderId of input.orderIds) {
    const result = await setOrderFulfillmentStatus({
      orderId,
      to: nextStatus,
      source: "admin",
      actor: input.actor ?? null,
    });
    if (result.ok) {
      outcomes.push({ orderId, ok: true });
      changed.add(orderId);
    } else {
      outcomes.push({ orderId, ok: false, reason: result.message });
    }
  }

  const updated = outcomes.filter((o) => o.ok).length;
  const failed = outcomes.filter((o) => !o.ok);

  if (!BULK_NOTIFY_STATUSES.has(nextStatus)) {
    return { updated, notified: 0, failed };
  }

  // Only orders that ACTUALLY moved are told. An order the pipeline refused has
  // not changed, so emailing its customer would announce something untrue.
  const transitioned = (before ?? []).filter(
    (row) => changed.has(String(row.order_id)) && row.customer_email,
  );

  let notified = 0;
  for (const row of transitioned) {
    try {
      // The reference the CUSTOMER knows, matching the Shippo-driven emails and
      // the order confirmation. The internal key is a raw `order-<uuid>` that
      // means nothing to them and cannot be quoted to support.
      const orderId = String(row.order_number ?? "") || String(row.order_id);
      const trackingNumber = row.tracking_number ? String(row.tracking_number) : undefined;
      // Only "shipped" reaches here now — BULK_NOTIFY_STATUSES holds nothing
      // else, and mark_delivered no longer exists as a bulk action.
      const template = shippingUpdateTemplate({
        customerName: String(row.customer_name ?? ""),
        orderId,
        // Mapped, not raw — the customer must not read our internal enum.
        // Same fix as the single-order path in
        // api/admin/orders/[orderId]/route.ts; the Shippo path always did this.
        status: FULFILLMENT_STATUS_LABELS[nextStatus as keyof typeof FULFILLMENT_STATUS_LABELS] ?? nextStatus,
        trackingNumber,
        // No carrier is known in a bulk action, so there is no carrier
        // deep-link to build — send them to their own order list, which is
        // the same fallback the single-order path uses.
        trackingUrl: `${getSiteUrl()}/account/orders`,
      });
      const message = { to: String(row.customer_email), ...template };
      const result = await sendEmail(message);
      if (result.success) {
        notified++;
      } else {
        // QUEUED ON FAILURE, NOT DROPPED — the same rule as the single-order
        // route and the Shippo path. sendEmail never throws, so the catch below
        // never saw a provider refusal: the send was simply lost, with no queue
        // row, no log line and no alert, and the admin saw only a lower
        // "notified" count. The status has already advanced, so no later scan
        // regenerates this message; the retry queue is its only way out.
        console.error(`[admin-orders] bulk ${nextStatus} notification failed for ${orderId}: ${result.error ?? "unknown error"}`);
        await enqueueFailedEmail(message, result.error);
      }
    } catch {
      // Best-effort: the status change already succeeded and must stand.
    }
  }

  return { updated, notified, failed };
}
