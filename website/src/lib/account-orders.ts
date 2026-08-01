import { supabaseAdmin } from "@/lib/supabase-server";
import { getCatalogProductsBySlugs } from "@/lib/catalog";

/**
 * Customer-facing order detail for the account dashboard. Widens the narrow
 * `getCustomerOrders` select to include order number, the full money breakdown,
 * the shipping snapshot, payment method, and shipment tracking (carrier +
 * tracking URL + estimated delivery), and resolves a live product image per
 * line item from the catalog (line items store only a slug, never an image).
 */

export interface AccountOrderItem {
  productId: string;
  slug: string;
  variantId: string | null;
  productName: string;
  variantLabel: string | null;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
  image: string;
}

export interface AccountOrderShipment {
  carrier: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  status: string | null;
  estimatedDelivery: string | null;
}

export interface AccountOrder {
  orderId: string;
  orderNumber: string | null;
  createdAt: string;
  paidAt: string | null;
  paymentStatus: string;
  fulfillmentStatus: string;
  currency: string;
  subtotal: number;
  shippingAmount: number;
  handlingFee: number;
  taxAmount: number;
  discountAmount: number;
  amountPaid: number;
  refundAmount: number;
  customerName: string | null;
  shippingAddress: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  country: string | null;
  phone: string | null;
  paymentMethod: string | null;
  trackingNumber: string | null;
  shipment: AccountOrderShipment | null;
  items: AccountOrderItem[];
}

const ORDER_SELECT =
  "order_id, order_number, created_at, paid_at, payment_status, fulfillment_status, currency, subtotal, shipping_amount, handling_fee, tax_amount, discount_amount, amount_paid, refund_amount, customer_name, customer_email, customer_user_id, shipping_address, city, state, postal_code, country, phone, payment_method, tracking_number, order_items(product_id, product_name, quantity, unit_price, line_total)";

type OrderRow = {
  order_id: string;
  order_number: string | null;
  created_at: string;
  paid_at: string | null;
  payment_status: string | null;
  fulfillment_status: string | null;
  currency: string | null;
  subtotal: number | null;
  shipping_amount: number | null;
  handling_fee: number | null;
  tax_amount: number | null;
  discount_amount: number | null;
  amount_paid: number | null;
  refund_amount: number | null;
  customer_name: string | null;
  customer_email: string | null;
  customer_user_id: string | null;
  shipping_address: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  country: string | null;
  phone: string | null;
  payment_method: string | null;
  tracking_number: string | null;
  order_items: Array<{ product_id: string | null; product_name: string | null; quantity: number | null; unit_price: number | null; line_total: number | null }> | null;
};

function buildTrackingUrl(carrier: string | null, tracking: string | null): string | null {
  if (!tracking) return null;
  const c = (carrier ?? "").toLowerCase();
  const t = encodeURIComponent(tracking);
  if (c.includes("ups")) return `https://www.ups.com/track?tracknum=${t}`;
  if (c.includes("usps")) return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${t}`;
  if (c.includes("fedex")) return `https://www.fedex.com/fedextrack/?trknbr=${t}`;
  if (c.includes("dhl")) return `https://www.dhl.com/us-en/home/tracking.html?tracking-id=${t}`;
  return null;
}

async function resolveItems(rows: OrderRow[]): Promise<Map<string, AccountOrderItem[]>> {
  // Collect every base slug across all orders in one catalog round-trip.
  const slugs = new Set<string>();
  for (const row of rows) {
    for (const item of row.order_items ?? []) {
      const base = String(item.product_id ?? "").split("::")[0];
      if (base) slugs.add(base);
    }
  }
  const products = slugs.size ? await getCatalogProductsBySlugs(Array.from(slugs)).catch(() => []) : [];
  const bySlug = new Map(products.map((p) => [p.slug, p]));

  const result = new Map<string, AccountOrderItem[]>();
  for (const row of rows) {
    const items: AccountOrderItem[] = (row.order_items ?? []).map((item) => {
      const productId = String(item.product_id ?? "");
      const [slug, variantId] = productId.split("::");
      const product = bySlug.get(slug);
      const dose = variantId && product?.doses ? product.doses.find((d) => d.id === variantId) : undefined;
      return {
        productId,
        slug: slug || productId,
        variantId: variantId || null,
        productName: String(item.product_name ?? product?.name ?? "Item"),
        variantLabel: dose?.label ?? null,
        quantity: Number(item.quantity ?? 0),
        unitPrice: Number(item.unit_price ?? 0),
        lineTotal: Number(item.line_total ?? 0),
        image: dose?.imageUrl ?? product?.image ?? "/images/vantalabs.png",
      };
    });
    result.set(row.order_id, items);
  }
  return result;
}

async function attachShipments(orderIds: string[]): Promise<Map<string, AccountOrderShipment>> {
  const map = new Map<string, AccountOrderShipment>();
  if (orderIds.length === 0) return map;
  const { data } = await supabaseAdmin
    .from("order_shipments")
    .select("order_id, carrier, tracking_number, shipping_status, estimated_delivery")
    .in("order_id", orderIds);
  for (const row of data ?? []) {
    const carrier = row.carrier ? String(row.carrier) : null;
    const tracking = row.tracking_number ? String(row.tracking_number) : null;
    map.set(String(row.order_id), {
      carrier,
      trackingNumber: tracking,
      trackingUrl: buildTrackingUrl(carrier, tracking),
      status: row.shipping_status ? String(row.shipping_status) : null,
      estimatedDelivery: row.estimated_delivery ? String(row.estimated_delivery) : null,
    });
  }
  return map;
}

function mapRow(row: OrderRow, items: AccountOrderItem[], shipment: AccountOrderShipment | null): AccountOrder {
  return {
    orderId: String(row.order_id),
    orderNumber: row.order_number ? String(row.order_number) : null,
    createdAt: String(row.created_at),
    paidAt: row.paid_at ? String(row.paid_at) : null,
    paymentStatus: String(row.payment_status ?? ""),
    fulfillmentStatus: String(row.fulfillment_status ?? ""),
    currency: String(row.currency ?? "USD"),
    subtotal: Number(row.subtotal ?? 0),
    shippingAmount: Number(row.shipping_amount ?? 0),
    handlingFee: Number(row.handling_fee ?? 0),
    taxAmount: Number(row.tax_amount ?? 0),
    discountAmount: Number(row.discount_amount ?? 0),
    amountPaid: Number(row.amount_paid ?? 0),
    refundAmount: Number(row.refund_amount ?? 0),
    customerName: row.customer_name ? String(row.customer_name) : null,
    shippingAddress: row.shipping_address ? String(row.shipping_address) : null,
    city: row.city ? String(row.city) : null,
    state: row.state ? String(row.state) : null,
    postalCode: row.postal_code ? String(row.postal_code) : null,
    country: row.country ? String(row.country) : null,
    phone: row.phone ? String(row.phone) : null,
    paymentMethod: row.payment_method ? String(row.payment_method) : null,
    trackingNumber: row.tracking_number ? String(row.tracking_number) : (shipment?.trackingNumber ?? null),
    shipment,
    items,
  };
}

function ownershipFilter(userId: string, email?: string | null): string {
  const safeUserId = userId.replace(/[^a-zA-Z0-9-]/g, "");
  const normalizedEmail = (email ?? "").trim().toLowerCase().replace(/[^a-zA-Z0-9@._-]/g, "");
  return normalizedEmail
    ? `customer_user_id.eq.${safeUserId},customer_email.ilike.${normalizedEmail}`
    : `customer_user_id.eq.${safeUserId}`;
}

export async function getCustomerOrdersDetailed(userId: string, email?: string | null): Promise<AccountOrder[]> {
  const { data, error } = await supabaseAdmin
    .from("orders")
    .select(ORDER_SELECT)
    .or(ownershipFilter(userId, email))
    .order("created_at", { ascending: false })
    .limit(100);

  if (error) throw error;
  const rows = (data ?? []) as OrderRow[];
  if (rows.length === 0) return [];

  const [itemMap, shipmentMap] = await Promise.all([
    resolveItems(rows),
    attachShipments(rows.map((r) => r.order_id)),
  ]);

  return rows.map((row) => mapRow(row, itemMap.get(row.order_id) ?? [], shipmentMap.get(row.order_id) ?? null));
}

export async function getCustomerOrderDetail(userId: string, email: string | null | undefined, orderId: string): Promise<AccountOrder | null> {
  const { data, error } = await supabaseAdmin
    .from("orders")
    .select(ORDER_SELECT)
    .eq("order_id", orderId)
    .maybeSingle();

  if (error) throw error;
  const row = data as OrderRow | null;
  if (!row) return null;

  // Ownership: by account id (survives email change / phone accounts) or by the
  // current email for legacy rows placed before customer_user_id was stored.
  const ownsByUserId = row.customer_user_id && String(row.customer_user_id) === userId;
  const ownsByEmail = email && String(row.customer_email ?? "").toLowerCase() === email.toLowerCase();
  if (!ownsByUserId && !ownsByEmail) return null;

  const [itemMap, shipmentMap] = await Promise.all([
    resolveItems([row]),
    attachShipments([row.order_id]),
  ]);

  return mapRow(row, itemMap.get(row.order_id) ?? [], shipmentMap.get(row.order_id) ?? null);
}
