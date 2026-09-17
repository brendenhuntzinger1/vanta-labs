import "server-only";

import { supabaseAdmin } from "@/lib/supabase-server";
import { money } from "@/lib/ads/tiktok-events";
import { resolveProductImage } from "@/lib/product-image";
import { siteUrl } from "@/lib/site-identity";
import { omnisendVariantId } from "@/lib/marketing/omnisend/catalog-payload";
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

/**
 * Not selected: the checkout phone. It is the courier's number, not a
 * marketing identifier, and the privacy policy says a phone reaches Omnisend
 * only with SMS consent, which is contact-payload.ts's business alone.
 */
const ORDER_COLUMNS =
  "order_id, order_number, order_type, replacement_of, payment_status, fulfillment_status, amount_paid, subtotal, shipping_amount, discount_amount, tax_amount, currency, coupon_code, customer_email, customer_name, customer_user_id, shipping_address, shipping_address_2, city, state, postal_code, country, paid_at, created_at, shipped_at, tracking_number, shipping_carrier, order_items(product_id, product_name, quantity, unit_price)";

/**
 * The two halves of an `order_items.product_id`.
 *
 * The checkout writes `<slug>::<doseId>`; rows from before doses existed carry
 * a bare slug. Exported and pure so the parsing can be tested without a
 * database — it was the unparsed value being used as a product id that made
 * every Omnisend order line unresolvable.
 */
export function lineSlug(raw: string | null | undefined): string | null {
  const slug = String(raw ?? "").split("::")[0]?.trim();
  return slug || null;
}

export function lineDoseId(raw: string | null | undefined): string | null {
  const parts = String(raw ?? "").split("::");
  if (parts.length < 2) return null;
  const dose = parts[1]?.trim();
  return dose || null;
}

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
    // THE LINE'S `product_id` IS NOT A PRODUCT ID. IT NEVER HAS BEEN.
    //
    // The checkout writes `<slug>::<doseId>` (payment-webhook.ts:969, from the
    // cart line's own composite id); older rows carry a bare slug. Production
    // on 2026-09-17: 101 line items, ZERO of them a UUID, ZERO of them joining
    // to `products.id`, 93 shaped `<slug>::<doseId>` and 8 bare slugs.
    //
    // This block read them with `.in("id", productIds)`, so the lookup matched
    // nothing on every order that has ever existed, and the failure was silent
    // because the fallbacks are all reasonable-looking: `productID` became the
    // raw `tesamorelin::b7f3…` string, the category became [], the image became
    // the grey placeholder and the URL became `/products`.
    //
    // What that costs once Omnisend owns sending: a `productID` its catalogue
    // does not contain (catalogue ids are bare slugs, catalog-payload.ts), so
    // no product block resolves, no "bought product X" segment can ever match,
    // and post-purchase, replenishment and win-back mail renders placeholder
    // tiles linking to the catalogue index instead of the product.
    //
    // So the slug is parsed out and the lookup is BY SLUG, which is what the
    // rest of the system identifies a product by. The dose half is kept too:
    // it is the other end of the catalogue's variant id, so a line item can
    // finally name the exact variant Omnisend holds.
    const slugs = [...new Set(items.map((item) => lineSlug(item.product_id)).filter((slug): slug is string => Boolean(slug)))];
    const productBySlug = new Map<string, ProductRow>();
    if (slugs.length > 0) {
      const { data: products } = await supabaseAdmin.from("products").select("id, slug, category, image_url").in("slug", slugs);
      for (const product of (products ?? []) as ProductRow[]) {
        const slug = text(product.slug);
        if (slug) productBySlug.set(slug, product);
      }
    }

    // A SLUG IS A NAME AND NAMES CHANGE; A DOSE ID DOES NOT.
    //
    // Nineteen live line items name `bac-water` and `bacteriostatic-water`,
    // which are earlier names for the row now slugged `recon-water` — the same
    // product, the same dose id (06126d6b…), renamed twice. On the slug alone
    // every one of those lines is an unknown product, so a rename silently
    // orphans that product's whole order history in Omnisend: no image, no
    // category, no link, no segment. It will happen again; the catalogue is
    // edited from Admin.
    //
    // So a slug that does not resolve falls back to the dose id, which the
    // checkout wrote into the same string and which survives any rename. Two
    // extra reads, and only when something actually failed to resolve.
    const strandedDoseIds = [...new Set(
      items
        .filter((item) => {
          const slug = lineSlug(item.product_id);
          return Boolean(slug) && !productBySlug.has(slug as string);
        })
        .map((item) => lineDoseId(item.product_id))
        .filter((dose): dose is string => Boolean(dose)),
    )];
    /** Dose id → the product it belongs to now, whatever it is called now. */
    const productByDose = new Map<string, ProductRow>();
    if (strandedDoseIds.length > 0) {
      const { data: doses } = await supabaseAdmin.from("product_doses").select("id, product_id").in("id", strandedDoseIds);
      const doseRows = (doses ?? []) as Array<{ id?: string | null; product_id?: string | null }>;
      const productIds = [...new Set(doseRows.map((dose) => text(dose.product_id)).filter((id): id is string => Boolean(id)))];
      if (productIds.length > 0) {
        const { data: renamed } = await supabaseAdmin.from("products").select("id, slug, category, image_url").in("id", productIds);
        const byId = new Map<string, ProductRow>();
        for (const product of (renamed ?? []) as ProductRow[]) {
          const id = text(product.id);
          if (id) byId.set(id, product);
        }
        for (const dose of doseRows) {
          const doseId = text(dose.id);
          const product = byId.get(text(dose.product_id) ?? "");
          if (doseId && product) productByDose.set(doseId, product);
        }
      }
    }

    const origin = siteUrl();
    const lineItems: OmnisendLineItem[] = [];
    for (const item of items) {
      const parsedSlug = lineSlug(item.product_id);
      const product = (parsedSlug ? productBySlug.get(parsedSlug) : undefined)
        ?? productByDose.get(lineDoseId(item.product_id) ?? "");
      // The catalogue's slug when the product still exists, else whatever the
      // line recorded — a discontinued slug is still the truest name we have.
      const slug = text(product?.slug) ?? parsedSlug;
      const productID = slug ?? text(item.product_id);
      if (!productID) continue;
      const category = text(product?.category);
      const doseId = lineDoseId(item.product_id);
      lineItems.push({
        productID,
        // Only when the product resolved: a variant id built on a slug the
        // catalogue no longer carries names nothing on Omnisend's side either.
        ...(product && doseId ? { productVariantID: omnisendVariantId(productID, doseId) } : {}),
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
