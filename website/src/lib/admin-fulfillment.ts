import "server-only";

import { supabaseAdmin } from "@/lib/supabase-server";
import { isDomesticCountry } from "@/lib/shipping";

export interface FulfillmentItem {
  name: string;
  quantity: number;
}

export interface FulfillmentRow {
  id: string;
  order_id: string;
  order_number: string;
  customer_name: string | null;
  customer_email: string | null;
  shipping_address: string | null;
  city: string | null;
  postal_code: string | null;
  country: string | null;
  shipping_method: string;
  payment_method: string;
  payment_status: string;
  fulfillment_status: string;
  tracking_number: string | null;
  verified_by: string | null;
  approved_at: string | null;
  created_at: string;
  items: FulfillmentItem[];
}

export type FulfillmentStatusFilter = "queue" | "shipped" | "delivered" | "all";

export interface FulfillmentFilters {
  search?: string;
  status?: FulfillmentStatusFilter;
  page?: number;
  pageSize?: number;
}

export interface FulfillmentListResult {
  rows: FulfillmentRow[];
  total: number;
  page: number;
  pageSize: number;
  pageCount: number;
}

function sanitizeSearchTerm(value: string) {
  return value.trim().replace(/[^a-zA-Z0-9@._\- ]/g, "").slice(0, 100);
}

function shippingMethodLabel(shippingAmount: number, country: string | null) {
  const domestic = isDomesticCountry(country);
  const base = domestic ? "Domestic" : "International";
  return shippingAmount > 0 ? `${base} · standard` : `${base} · free`;
}

// The fulfillment queue only ever contains PAID orders (an approved payment
// moves an order here automatically). By default it shows the active queue -
// paid + awaiting fulfillment - so the 3PL sees exactly what needs to ship.
export async function getFulfillmentRows(filters: FulfillmentFilters = {}): Promise<FulfillmentListResult> {
  const page = Math.max(1, Math.trunc(filters.page ?? 1));
  const pageSize = Math.min(100, Math.max(1, Math.trunc(filters.pageSize ?? 25)));
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;
  const status = filters.status ?? "queue";

  let query = supabaseAdmin
    .from("orders")
    .select(
      "id, order_id, order_number, customer_name, customer_email, shipping_address, city, postal_code, country, shipping_amount, payment_method, payment_status, fulfillment_status, tracking_number, verified_by, paid_at, created_at",
      { count: "exact" },
    )
    .eq("payment_status", "paid")
    // Membership orders are digital — never shipped, so keep them out of the 3PL queue.
    .neq("order_type", "membership")
    .order("paid_at", { ascending: true, nullsFirst: false });

  if (status === "queue") {
    query = query.eq("fulfillment_status", "awaiting_fulfillment");
  } else if (status === "shipped") {
    query = query.eq("fulfillment_status", "shipped");
  } else if (status === "delivered") {
    query = query.eq("fulfillment_status", "delivered");
  }

  const search = sanitizeSearchTerm(filters.search ?? "");
  if (search) {
    query = query.or(
      `order_number.ilike.%${search}%,order_id.ilike.%${search}%,customer_email.ilike.%${search}%,customer_name.ilike.%${search}%,tracking_number.ilike.%${search}%`,
    );
  }

  const { data, error, count } = await query.range(from, to);
  if (error) {
    throw error;
  }

  const orders = data ?? [];
  const orderIds = orders.map((order) => order.order_id);

  const itemsByOrder = new Map<string, FulfillmentItem[]>();
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
    rows: orders.map((order) => ({
      id: String(order.id),
      order_id: String(order.order_id),
      order_number: String(order.order_number ?? order.order_id),
      customer_name: order.customer_name,
      customer_email: order.customer_email,
      shipping_address: order.shipping_address,
      city: order.city,
      postal_code: order.postal_code,
      country: order.country,
      shipping_method: shippingMethodLabel(Number(order.shipping_amount ?? 0), order.country ? String(order.country) : null),
      payment_method: String(order.payment_method ?? ""),
      payment_status: String(order.payment_status ?? ""),
      fulfillment_status: String(order.fulfillment_status ?? ""),
      tracking_number: order.tracking_number,
      verified_by: order.verified_by,
      approved_at: order.paid_at,
      created_at: String(order.created_at),
      items: itemsByOrder.get(order.order_id) ?? [],
    })),
    total,
    page,
    pageSize,
    pageCount: Math.max(1, Math.ceil(total / pageSize)),
  };
}
