import "server-only";

import { supabaseAdmin } from "@/lib/supabase-server";
import { money } from "@/lib/ads/tiktok-events";
import { resolveProductImage } from "@/lib/product-image";
import { siteUrl } from "@/lib/site-identity";
import { slugify, type OmnisendLineItem, type OmnisendOrder } from "@/lib/marketing/omnisend/events";

/**
 * One order, read from the row and shaped for the Omnisend event builders.
 *
 * Every figure comes from `orders` and `order_items` — the settled amount,
 * the subtotal, the per-line unit price — never from anything the browser
 * sent. The product ids on the lines are database ids; the catalogue slug is
 * what every other platform identifies a product by, so the lines are joined
 * to `products` here and carry the slug (with the id as the only fallback).
 *
 * `linkFor` turns a site path into the URL the line item carries. The caller
 * passes the per-contact link builder (spec §5.2: productURL carries the
 * contact's token) so this module does not need to know how the token is
 * minted, and a test can pass the identity function.
 *
 * Never throws. Returns null when the row is missing, has no email to attach
 * the event to, or the read fails — the hooks treat null as "nothing to
 * send" and the backstop sweep will try again.
 */

type OrderItemRow = {
  product_id?: string | null;
  product_name?: string | null;
  quantity?: number | string | null;
  unit_price?: number | string | null;
};

type OrderRow = {
  order_id: string;
  order_number?: string | null;
  order_type?: string | null;
  replacement_of?: string | null;
  payment_status?: string | null;
  fulfillment_status?: string | null;
  amount_paid?: number | string | null;
  subtotal?: number | string | null;
  shipping_amount?: number | string | null;
  discount_amount?: number | string | null;
  tax_amount?: number | string | null;
  currency?: string | null;
  coupon_code?: string | null;
  customer_email?: string | null;
  customer_name?: string | null;
  customer_user_id?: string | null;
  phone?: string | null;
  shipping_address?: string | null;
  shipping_address_2?: string | null;
  city?: string | null;
  state?: string | null;
  postal_code?: string | null;
  country?: string | null;
  paid_at?: string | null;
  created_at?: string | null;
  shipped_at?: string | null;
  tracking_number?: string | null;
  shipping_carrier?: string | null;
  order_items?: OrderItemRow[] | null;
};

type ProductRow = {
  id?: string | null;
  slug?: string | null;
  category?: string | null;
  image_url?: string | null;
};

const ORDER_COLUMNS =
  "order_id, order_number, order_type, replacement_of, payment_status, fulfillment_status, amount_paid, subtotal, shipping_amount, discount_amount, tax_amount, currency, coupon_code, customer_email, customer_name, customer_user_id, phone, shipping_address, shipping_address_2, city, state, postal_code, country, paid_at, created_at, shipped_at, tracking_number, shipping_carrier, order_items(product_id, product_name, quantity, unit_price)";

function amount(value: number | string | null | undefined): number {
  return money(Number(value ?? 0));
}

function text(value: string | null | undefined): string | null {
  const trimmed = String(value ?? "").trim();
  return trimmed || null;
}

/** Absolute, always: Omnisend renders the image in mail, where a relative path is nothing. */
function absoluteImage(imageUrl: string | null | undefined, origin: string): string {
  const resolved = resolveProductImage(imageUrl);
  return resolved.startsWith("/") ? `${origin}${resolved}` : resolved;
}

export async function loadOrderForOmnisend(
  orderId: string,
  linkFor: (path: string) => Promise<string> | string,
): Promise<OmnisendOrder | null> {
  try {
    const { data, error } = await supabaseAdmin.from("orders").select(ORDER_COLUMNS).eq("order_id", orderId).maybeSingle();
    if (error || !data) return null;
    const row = data as OrderRow;
    const email = String(row.customer_email ?? "").trim().toLowerCase();
    if (!email) return null;

    const items = row.order_items ?? [];
    const productIds = [...new Set(items.map((item) => item.product_id).filter((id): id is string => Boolean(id)))];
    const productById = new Map<string, ProductRow>();
    if (productIds.length > 0) {
      const { data: products } = await supabaseAdmin.from("products").select("id, slug, category, image_url").in("id", productIds);
      for (const product of (products ?? []) as ProductRow[]) {
        if (product.id) productById.set(product.id, product);
      }
    }

    const origin = siteUrl();
    const lineItems: OmnisendLineItem[] = [];
    for (const item of items) {
      const product = item.product_id ? productById.get(item.product_id) : undefined;
      const slug = text(product?.slug);
      const productID = slug ?? text(item.product_id);
      if (!productID) continue;
      const category = text(product?.category);
      lineItems.push({
        productID,
        productTitle: text(item.product_name) ?? productID,
        productPrice: amount(item.unit_price),
        productQuantity: Math.max(1, Math.floor(Number(item.quantity) || 1)),
        productImageURL: absoluteImage(product?.image_url, origin),
        // A line whose product no longer resolves to a slug links to the
        // catalogue rather than to a page that does not exist.
        productURL: await linkFor(slug ? `/products/${slug}` : "/products"),
        productCategories: category ? [{ id: slugify(category), title: category }] : [],
      });
    }

    return {
      orderId: row.order_id,
      orderNumber: text(row.order_number),
      orderType: text(row.order_type),
      replacementOf: text(row.replacement_of),
      email,
      customerName: text(row.customer_name),
      phone: text(row.phone),
      currency: (text(row.currency) ?? "USD").toUpperCase(),
      amountPaid: amount(row.amount_paid),
      subtotal: amount(row.subtotal),
      shipping: amount(row.shipping_amount),
      discount: amount(row.discount_amount),
      tax: amount(row.tax_amount),
      couponCode: text(row.coupon_code),
      createdAt: text(row.created_at) ?? new Date().toISOString(),
      paidAt: text(row.paid_at),
      shippedAt: text(row.shipped_at),
      trackingNumber: text(row.tracking_number),
      carrier: text(row.shipping_carrier),
      address: {
        line1: text(row.shipping_address),
        line2: text(row.shipping_address_2),
        city: text(row.city),
        state: text(row.state),
        postalCode: text(row.postal_code),
        country: text(row.country),
      },
      lineItems,
      siteOrigin: origin,
      paymentStatus: text(row.payment_status),
      fulfillmentStatus: text(row.fulfillment_status),
    };
  } catch (error) {
    console.error("[omnisend] loadOrderForOmnisend failed", orderId, error);
    return null;
  }
}
