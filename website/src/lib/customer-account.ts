import { supabaseAdmin } from "@/lib/supabase-server";

export interface CustomerOrderRow {
  orderId: string;
  amountPaid: number;
  paymentStatus: string;
  fulfillmentStatus: string;
  trackingNumber: string | null;
  createdAt: string;
  items: Array<{ productId: string; productName: string; quantity: number; lineTotal: number; unitPrice: number }>;
}

// Server components run with the service-role client, so this is scoped
// explicitly by the caller-supplied email rather than relying solely on the
// customer_accounts.sql RLS policy (that policy exists for any future
// client-side/anon-key access path).
export async function getCustomerOrders(email: string): Promise<CustomerOrderRow[]> {
  const normalizedEmail = email.trim().toLowerCase();
  if (!normalizedEmail) {
    return [];
  }

  const { data, error } = await supabaseAdmin
    .from("orders")
    .select("order_id, amount_paid, payment_status, fulfillment_status, tracking_number, created_at, order_items(product_id, product_name, quantity, line_total, unit_price)")
    .ilike("customer_email", normalizedEmail)
    .order("created_at", { ascending: false })
    .limit(200);

  if (error) {
    throw error;
  }

  return (data ?? []).map((order) => ({
    orderId: String(order.order_id),
    amountPaid: Number(order.amount_paid ?? 0),
    paymentStatus: String(order.payment_status ?? ""),
    fulfillmentStatus: String(order.fulfillment_status ?? ""),
    trackingNumber: order.tracking_number ? String(order.tracking_number) : null,
    createdAt: String(order.created_at),
    items: (order.order_items ?? []).map((item) => ({
      productId: String(item.product_id ?? ""),
      productName: String(item.product_name ?? item.product_id ?? "Item"),
      quantity: Number(item.quantity ?? 0),
      lineTotal: Number(item.line_total ?? 0),
      unitPrice: Number(item.unit_price ?? 0),
    })),
  }));
}

export interface CustomerAddress {
  id: string;
  label: string | null;
  fullName: string;
  address: string;
  city: string;
  postalCode: string;
  isDefault: boolean;
}

export async function getCustomerAddresses(userId: string): Promise<CustomerAddress[]> {
  const { data, error } = await supabaseAdmin
    .from("customer_addresses")
    .select("id, label, full_name, address, city, postal_code, is_default")
    .eq("user_id", userId)
    .order("is_default", { ascending: false })
    .order("created_at", { ascending: false });

  if (error) {
    throw error;
  }

  return (data ?? []).map((row) => ({
    id: String(row.id),
    label: row.label ? String(row.label) : null,
    fullName: String(row.full_name),
    address: String(row.address),
    city: String(row.city),
    postalCode: String(row.postal_code),
    isDefault: Boolean(row.is_default),
  }));
}

export async function getDefaultCustomerAddress(userId: string): Promise<CustomerAddress | null> {
  const addresses = await getCustomerAddresses(userId);
  return addresses.find((address) => address.isDefault) ?? addresses[0] ?? null;
}

export interface CustomerPreferences {
  orderUpdateEmails: boolean;
  marketingEmails: boolean;
}

export async function getCustomerPreferences(userId: string): Promise<CustomerPreferences> {
  const { data, error } = await supabaseAdmin
    .from("customer_preferences")
    .select("order_update_emails, marketing_emails")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return {
    orderUpdateEmails: data ? Boolean(data.order_update_emails) : true,
    marketingEmails: data ? Boolean(data.marketing_emails) : false,
  };
}

export async function getWishlistSlugs(userId: string): Promise<string[]> {
  const { data, error } = await supabaseAdmin
    .from("wishlist_items")
    .select("product_slug")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });

  if (error) {
    throw error;
  }

  return (data ?? []).map((row) => String(row.product_slug));
}
