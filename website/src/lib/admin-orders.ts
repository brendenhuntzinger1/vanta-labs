import "server-only";

import { supabaseAdmin } from "@/lib/supabase-server";

export interface AdminOrderRow {
  id: string;
  order_id: string;
  customer_email: string | null;
  customer_name: string | null;
  amount_paid: number;
  referral_code: string | null;
  coupon_code: string | null;
  payment_status: string;
  fulfillment_status: string;
  refund_amount: number;
  created_at: string;
  item_count: number;
}

export type AdminOrderPaymentStatusFilter = "all" | "pending_payment" | "paid" | "partially_refunded" | "refunded" | "payment_failed" | "canceled";
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
      "id, order_id, customer_email, customer_name, amount_paid, referral_code, coupon_code, payment_status, fulfillment_status, refund_amount, created_at",
      { count: "exact" },
    )
    .order("created_at", { ascending: false });

  const search = sanitizeSearchTerm(filters.search ?? "");
  if (search) {
    query = query.or(`order_id.ilike.%${search}%,customer_email.ilike.%${search}%,customer_name.ilike.%${search}%`);
  }

  if (filters.paymentStatus && filters.paymentStatus !== "all") {
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
      customer_email: order.customer_email,
      customer_name: order.customer_name,
      amount_paid: Number(order.amount_paid ?? 0),
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

export async function bulkUpdateAdminOrders(input: { orderIds: string[]; action: AdminOrderBulkAction }) {
  if (input.orderIds.length === 0) {
    return;
  }

  const payload: Record<string, unknown> = { updated_at: new Date().toISOString() };

  switch (input.action) {
    case "mark_shipped":
      payload.fulfillment_status = "shipped";
      break;
    case "mark_delivered":
      payload.fulfillment_status = "delivered";
      break;
    case "cancel":
      payload.fulfillment_status = "cancelled";
      break;
    default:
      throw new Error("Unsupported bulk action");
  }

  const { error } = await supabaseAdmin
    .from("orders")
    .update(payload)
    .in("order_id", input.orderIds);

  if (error) {
    throw error;
  }
}
