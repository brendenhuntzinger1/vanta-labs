import "server-only";

import { supabaseAdmin } from "@/lib/supabase-server";
import { sendEmail } from "@/lib/email/send";
import { deliveryConfirmationTemplate, shippingUpdateTemplate } from "@/lib/email/templates";
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
      "id, order_id, order_number, customer_email, customer_name, amount_paid, tax_amount, referral_code, coupon_code, payment_status, fulfillment_status, refund_amount, created_at",
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

export type AdminOrderBulkAction = "mark_shipped" | "mark_delivered" | "cancel";

/**
 * Statuses a customer is told about, matching the single-order route exactly.
 * "cancelled" is deliberately absent there and here: a cancellation is handled
 * by the refund flow, which has its own message.
 */
const BULK_NOTIFY_STATUSES = new Set(["shipped", "delivered"]);

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
 *   * "delivered" gets the delivery confirmation, "shipped" the shipping
 *     update;
 *   * sending is best-effort per order. The status change is the operation the
 *     admin asked for and it has already committed; one bad address must not
 *     roll it back or abort the rest of the batch.
 */
export async function bulkUpdateAdminOrders(input: { orderIds: string[]; action: AdminOrderBulkAction }) {
  if (input.orderIds.length === 0) {
    return { updated: 0, notified: 0 };
  }

  const payload: Record<string, unknown> = { updated_at: new Date().toISOString() };
  let nextStatus: string;

  switch (input.action) {
    case "mark_shipped":
      nextStatus = "shipped";
      break;
    case "mark_delivered":
      nextStatus = "delivered";
      break;
    case "cancel":
      nextStatus = "cancelled";
      break;
    default:
      throw new Error("Unsupported bulk action");
  }
  payload.fulfillment_status = nextStatus;

  // Read the PRIOR state before updating: afterwards every row reads as the new
  // status, and "did this actually change?" becomes unanswerable.
  const { data: before } = await supabaseAdmin
    .from("orders")
    .select("order_id, order_number, customer_email, customer_name, fulfillment_status, tracking_number")
    .in("order_id", input.orderIds);

  const { error } = await supabaseAdmin
    .from("orders")
    .update(payload)
    .in("order_id", input.orderIds);

  if (error) {
    throw error;
  }

  if (!BULK_NOTIFY_STATUSES.has(nextStatus)) {
    return { updated: input.orderIds.length, notified: 0 };
  }

  const transitioned = (before ?? []).filter(
    (row) => String(row.fulfillment_status ?? "").toLowerCase() !== nextStatus && row.customer_email,
  );

  let notified = 0;
  for (const row of transitioned) {
    try {
      // The reference the CUSTOMER knows, matching the Shippo-driven emails and
      // the order confirmation. The internal key is a raw `order-<uuid>` that
      // means nothing to them and cannot be quoted to support.
      const orderId = String(row.order_number ?? "") || String(row.order_id);
      const trackingNumber = row.tracking_number ? String(row.tracking_number) : undefined;
      const template = nextStatus === "delivered"
        ? deliveryConfirmationTemplate({ customerName: String(row.customer_name ?? ""), orderId })
        : shippingUpdateTemplate({
            customerName: String(row.customer_name ?? ""),
            orderId,
            status: nextStatus,
            trackingNumber,
            // No carrier is known in a bulk action, so there is no carrier
            // deep-link to build — send them to their own order list, which is
            // the same fallback the single-order path uses.
            trackingUrl: `${getSiteUrl()}/account/orders`,
          });
      const result = await sendEmail({ to: String(row.customer_email), ...template });
      if (result.success) notified++;
    } catch {
      // Best-effort: the status change already succeeded and must stand.
    }
  }

  return { updated: input.orderIds.length, notified };
}
