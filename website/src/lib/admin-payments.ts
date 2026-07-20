import "server-only";

import { supabaseAdmin } from "@/lib/supabase-server";

export interface AdminPaymentItem {
  name: string;
  quantity: number;
}

export interface AdminPaymentRow {
  id: string;
  order_id: string;
  order_number: string;
  customer_name: string | null;
  customer_email: string | null;
  amount_paid: number;
  payment_method: string;
  payment_reference: string | null;
  payment_proof_url: string | null;
  payment_status: string;
  fulfillment_status: string;
  payment_submitted_at: string | null;
  rejection_reason: string | null;
  created_at: string;
  items: AdminPaymentItem[];
  item_count: number;
}

export type AdminPaymentStatusFilter =
  | "all"
  | "pending_payment"
  | "awaiting_verification"
  | "paid"
  | "payment_rejected";

export interface AdminPaymentFilters {
  search?: string;
  paymentStatus?: AdminPaymentStatusFilter;
  paymentMethod?: string; // "all" or a method id
  fromDate?: string; // yyyy-mm-dd
  toDate?: string; // yyyy-mm-dd
  page?: number;
  pageSize?: number;
}

export interface AdminPaymentListResult {
  rows: AdminPaymentRow[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
}

// Same defensive sanitisation as admin-orders - PostgREST's .or() is
// comma-delimited so we keep only characters that legitimately appear in an
// order number, id, email, name, or transaction id.
function sanitizeSearchTerm(value: string) {
  return value.trim().replace(/[^a-zA-Z0-9@._\- ]/g, "").slice(0, 100);
}

// The manual payment methods this dashboard covers. Card orders are handled
// by the standard Orders view, so they're excluded here.
const MANUAL_METHODS = ["cashapp", "zelle", "paypal", "venmo", "applecash", "ach", "wire", "crypto"];

export async function getManualPaymentRows(filters: AdminPaymentFilters = {}): Promise<AdminPaymentListResult> {
  const page = Math.max(1, Math.trunc(filters.page ?? 1));
  const pageSize = Math.min(100, Math.max(1, Math.trunc(filters.pageSize ?? 25)));
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  let query = supabaseAdmin
    .from("orders")
    .select(
      "id, order_id, order_number, customer_name, customer_email, amount_paid, payment_method, payment_reference, payment_proof_url, payment_status, fulfillment_status, payment_submitted_at, rejection_reason, created_at",
      { count: "exact" },
    )
    .order("created_at", { ascending: false });

  if (filters.paymentMethod && filters.paymentMethod !== "all") {
    query = query.eq("payment_method", filters.paymentMethod);
  } else {
    query = query.in("payment_method", MANUAL_METHODS);
  }

  if (filters.paymentStatus && filters.paymentStatus !== "all") {
    query = query.eq("payment_status", filters.paymentStatus);
  }

  const search = sanitizeSearchTerm(filters.search ?? "");
  if (search) {
    query = query.or(
      `order_number.ilike.%${search}%,order_id.ilike.%${search}%,customer_email.ilike.%${search}%,customer_name.ilike.%${search}%,payment_reference.ilike.%${search}%`,
    );
  }

  if (filters.fromDate) {
    query = query.gte("created_at", `${filters.fromDate}T00:00:00.000Z`);
  }
  if (filters.toDate) {
    query = query.lte("created_at", `${filters.toDate}T23:59:59.999Z`);
  }

  const { data, error, count } = await query.range(from, to);
  if (error) {
    throw error;
  }

  const orders = data ?? [];
  const orderIds = orders.map((order) => order.order_id);

  const itemsByOrder = new Map<string, AdminPaymentItem[]>();
  if (orderIds.length > 0) {
    const { data: itemData, error: itemError } = await supabaseAdmin
      .from("order_items")
      .select("order_id, product_name, quantity")
      .in("order_id", orderIds);

    if (itemError) {
      throw itemError;
    }

    for (const item of itemData ?? []) {
      const list = itemsByOrder.get(item.order_id) ?? [];
      list.push({ name: String(item.product_name ?? "Item"), quantity: Number(item.quantity ?? 0) });
      itemsByOrder.set(item.order_id, list);
    }
  }

  const total = count ?? 0;

  return {
    rows: orders.map((order) => {
      const items = itemsByOrder.get(order.order_id) ?? [];
      return {
        id: String(order.id),
        order_id: String(order.order_id),
        order_number: String(order.order_number ?? order.order_id),
        customer_name: order.customer_name,
        customer_email: order.customer_email,
        amount_paid: Number(order.amount_paid ?? 0),
        payment_method: String(order.payment_method ?? ""),
        payment_reference: order.payment_reference,
        payment_proof_url: order.payment_proof_url,
        payment_status: String(order.payment_status ?? ""),
        fulfillment_status: String(order.fulfillment_status ?? ""),
        payment_submitted_at: order.payment_submitted_at,
        rejection_reason: order.rejection_reason,
        created_at: String(order.created_at),
        items,
        item_count: items.reduce((sum, item) => sum + item.quantity, 0),
      };
    }),
    total,
    page,
    pageSize,
    pageCount: Math.max(1, Math.ceil(total / pageSize)),
  };
}
