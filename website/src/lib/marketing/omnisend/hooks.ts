import "server-only";

import { createHash } from "node:crypto";
import { restoreUrl, type OmnisendCartHookInput } from "@/lib/cart-recovery";
import { getCatalogProductsBySlugs } from "@/lib/catalog";
import type { Product } from "@/lib/catalog-types";
import { omnisendActive } from "@/lib/marketing/omnisend/client";
import {
  CART_EVENT_DEBOUNCE_MS,
  PRODUCT_VIEW_DEBOUNCE_MS,
  priceCartLines,
  priceToCents,
} from "@/lib/marketing/omnisend/cart-plan";
import { ensureContactCode, findLiveContactCodes } from "@/lib/marketing/omnisend/codes";
import { collectContactFacts, upsertOmnisendContact, type ContactExtras } from "@/lib/marketing/omnisend/contacts";
import {
  buildCartEvent,
  buildViewedProduct,
  sendOmnisendEvent,
  slugify,
  type OmnisendCartEventName,
  type OmnisendLineItem,
} from "@/lib/marketing/omnisend/events";
import { omnisendLedger } from "@/lib/marketing/omnisend/ledger";
import { OMNISEND_LINK_TTL_MS, signOmnisendLink } from "@/lib/marketing/omnisend/link-token";
import { resolveProductImage } from "@/lib/product-image";
import { siteUrl } from "@/lib/site-identity";
import { supabaseAdmin } from "@/lib/supabase-server";

/**
 * The consent, cart, checkout and product-view hooks (spec §4 hook points;
 * the order lifecycle lives in order-hooks.ts).
 *
 * Every export is called from a place that has already done the real work
 * — a consent row written, a cart row written, a preference saved, a page
 * rendered — from inside after() or fire-and-forget, so the contract is the
 * one every Omnisend hook keeps:
 *
 *   * the gate is asked FIRST, before any database read, so a preview
 *     deployment or a build without a key returns having touched nothing;
 *   * every body is inside try/catch and logs under `[omnisend/hooks]`;
 *   * nothing here ever throws, and nothing here ever logs an address, a
 *     phone number, a token, a code or a key.
 *
 * ONE OWNER PER CART. A cart that has already received an in-house recovery
 * stage finishes in-house, and Omnisend must never hear about it: an
 * `added product to cart` for a shopper two messages into the ladder would
 * start Omnisend's flow at message one. So both cart hooks ask
 * abandoned_cart_emails before building anything, and fail CLOSED.
 *
 * EVENTS ARE FACTS. A cart event is sent whatever the address's consent,
 * because Omnisend's own sending thresholds (subscribed/subscribed on every
 * automation, spec §6) decide whether a flow may mail; the event only says
 * what happened. Consent itself is copied exactly by the contact upsert and
 * never widened here.
 */

const LOG = "[omnisend/hooks]";

function normalizeEmail(email: string): string | null {
  const value = String(email ?? "").trim().toLowerCase();
  return value && value.includes("@") ? value : null;
}

/** A short, stable, non-reversible handle for an address, for ledger keys and nothing else. */
function hashed(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

/** `${origin}/cart/restore?id=…` → `/cart/restore?id=…`, so it can ride through the signed door. */
function sitePathOf(absoluteUrl: string): string {
  const url = new URL(absoluteUrl);
  return `${url.pathname}${url.search}`;
}

/** Absolute, always: Omnisend renders the image in mail, where a relative path is nothing. */
function absoluteImage(image: string | null | undefined, origin: string): string {
  const resolved = resolveProductImage(image);
  return resolved.startsWith("/") ? `${origin}${resolved}` : resolved;
}

/**
 * The per-contact link builder (spec §3.3): every URL an Omnisend message
 * can click carries the contact's own signed token, so the click lands past
 * the account wall on the page it names rather than on sign-in. Minted here
 * rather than read back from the contact record because the event may be
 * the first thing Omnisend ever hears about this address. When no secret is
 * configured the token is empty and the route sends the click to sign-in,
 * which is what every link did before this module existed.
 */
export function contactLinkFor(email: string, campaign: string): (path: string) => Promise<string> {
  return async (path: string) => {
    const token = (await signOmnisendLink(email)) ?? "";
    return `${siteUrl()}/api/email/omnisend-link?t=${token}&to=${encodeURIComponent(path)}&utm_source=omnisend&utm_medium=email&utm_campaign=${encodeURIComponent(campaign)}`;
  };
}

/** A fresh 30-day link and the live codes this address holds — read, never minted. */
async function contactExtras(email: string): Promise<ContactExtras> {
  const now = Date.now();
  const [token, codes] = await Promise.all([signOmnisendLink(email, now), findLiveContactCodes(email)]);
  const link = token ? { token, endsAt: new Date(now + OMNISEND_LINK_TTL_MS).toISOString() } : null;
  return { link, codes };
}

/**
 * Email consent recorded (spec §3.4, "first time a contact becomes
 * email-subscribed"): mint the welcome code for an address that has never
 * bought, then upsert the contact so the consent, the link and every live
 * code reach Omnisend together. A buyer who opts in later gets no welcome
 * code — the offer is for a first order.
 *
 * NOT FOR THE CHECKOUT OPT-IN. recordMarketingOptIn runs from create-session
 * with source "checkout", BEFORE payment: a welcome code minted there is a
 * first-order discount handed to someone in the middle of their first order,
 * and the push would carry it into the welcome flow's first email at once.
 * The consent still reaches Omnisend; the code waits for a sign-up or an
 * account opt-in, and the paid hook retires it once a first order lands
 * (order-hooks.ts onOrderPaid).
 */
export async function onMarketingOptIn(email: string, source: string): Promise<void> {
  if (!omnisendActive().active) return;
  try {
    const address = normalizeEmail(email);
    if (!address) return;
    const facts = await collectContactFacts(address);
    if (!facts) return;
    if (source !== "checkout" && facts.orders === 0) await ensureContactCode("welcome", address);
    const accepted = await upsertOmnisendContact(address, await contactExtras(address));
    if (!accepted) console.error(LOG, "opt-in contact upsert refused", { source });
  } catch (error) {
    console.error(LOG, "onMarketingOptIn failed", { source }, error);
  }
}

/**
 * Account preferences saved: re-upsert the contact so marketing_emails,
 * sms_marketing, sms_consent_at, sms_opted_out_at and the phone number reach
 * Omnisend exactly as stored (contacts.ts reads them). Mints nothing.
 */
export async function onPreferencesChanged(email: string): Promise<void> {
  if (!omnisendActive().active) return;
  try {
    const address = normalizeEmail(email);
    if (!address) return;
    const accepted = await upsertOmnisendContact(address, await contactExtras(address));
    if (!accepted) console.error(LOG, "preferences contact upsert refused");
  } catch (error) {
    console.error(LOG, "onPreferencesChanged failed", error);
  }
}

/**
 * Has the in-house ladder claimed any stage for this cart?
 *
 * FAILS CLOSED: an unreadable claim table answers "yes, in-house", because a
 * wrong send here double-mails a shopper who is mid-ladder, while a missed
 * one costs Omnisend a flow it can pick up on the next cart change.
 */
async function cartHasInHouseStage(cartId: string): Promise<boolean> {
  try {
    const { data, error } = await supabaseAdmin
      .from("abandoned_cart_emails")
      .select("id")
      .eq("abandoned_cart_id", cartId)
      .limit(1);
    if (error) {
      console.error(LOG, "stage read refused; treating the cart as in-house", cartId, error.message);
      return true;
    }
    return Array.isArray(data) && data.length > 0;
  } catch (error) {
    console.error(LOG, "stage read failed; treating the cart as in-house", cartId, error);
    return true;
  }
}

/**
 * Has this cart reached the checkout?
 *
 * ONCE A CART HAS REACHED THE CHECKOUT, THE CHECKOUT FLOW OWNS IT. An `added
 * product to cart` after `started checkout` would put the shopper back into
 * Omnisend's abandoned-cart flow they had just left for the abandoned-
 * checkout one, and the two flows would then mail the same inbox about the
 * same cart. This used to ask only about the last ten minutes, so a cart
 * edited later in the same session re-entered the cart flow. The question
 * is the fact, not the time: the row's first-touch stamp (written by
 * /api/cart/track before after() runs either hook), or a `started checkout`
 * claim for the cart, whenever either was set. Fails OPEN — a cart event is
 * the cheaper mistake.
 */
async function cartReachedCheckout(cartId: string): Promise<boolean> {
  try {
    const [{ data: cart }, { data: claim }] = await Promise.all([
      supabaseAdmin.from("abandoned_carts").select("checkout_started_at").eq("id", cartId).maybeSingle(),
      supabaseAdmin
        .from("omnisend_events_sent")
        .select("entity_id")
        .eq("entity_id", cartId)
        .eq("event_name", "started checkout")
        .maybeSingle(),
    ]);
    const stamped = Boolean((cart as { checkout_started_at?: string | null } | null)?.checkout_started_at);
    if (stamped) return true;
    const claimed = Boolean((claim as { entity_id?: string | null } | null)?.entity_id);
    return claimed;
  } catch (error) {
    console.error(LOG, "checkout read failed; sending the cart event", cartId, error);
    return false;
  }
}

/**
 * Build one cart event from the ROW, price it from the catalogue, and send
 * it behind a per-cart ledger claim. True when Omnisend accepted it.
 *
 * `debounceMs` null means exactly once per cart (the offer sweep's catch-up
 * event); a window means at most once per cart per window (the beacons).
 * Prices and names come from getCatalogProductsBySlugs, never from what the
 * browser posted (cart-plan.ts priceCartLines). Never throws.
 */
export async function sendCartEventOnce(input: {
  name: OmnisendCartEventName;
  cart: OmnisendCartHookInput;
  /** The utm_campaign every link in the event carries. */
  campaign: string;
  debounceMs: number | null;
}): Promise<boolean> {
  // Exported for the cart-offers sweep, so it asks the gate itself rather
  // than trusting every caller to have asked.
  if (!omnisendActive().active) return false;
  const email = normalizeEmail(input.cart.email);
  const cartId = String(input.cart.cartId ?? "").trim();
  if (!email || !cartId) return false;

  const slugs = [...new Set(input.cart.items.map((item) => String(item?.slug ?? "").trim()).filter(Boolean))];
  if (slugs.length === 0) return false;
  const products = await getCatalogProductsBySlugs(slugs);
  const lines = priceCartLines(input.cart.items, products);
  if (lines.length === 0) return false;

  const origin = siteUrl();
  const link = contactLinkFor(email, input.campaign);
  const lineItems: OmnisendLineItem[] = [];
  for (const line of lines) {
    lineItems.push({
      productID: line.slug,
      productVariantID: line.variantId ? `${line.slug}#${line.variantId}` : undefined,
      productTitle: line.title,
      productVariantTitle: line.variantTitle,
      productPrice: line.priceCents / 100,
      productQuantity: line.quantity,
      productImageURL: absoluteImage(line.image, origin),
      productURL: await link(`/products/${line.slug}`),
      productCategories: line.category ? [{ id: slugify(line.category), title: line.category }] : [],
    });
  }

  const event = buildCartEvent({
    name: input.name,
    email,
    cartId,
    lineItems,
    checkoutUrl: await link(sitePathOf(restoreUrl(input.cart.cartId))),
  });

  const ledger = omnisendLedger(cartId);
  const claimed = input.debounceMs === null
    ? await ledger.claimSend(input.name, event.eventID)
    : await ledger.claimSendWithin(input.name, event.eventID, input.debounceMs);
  if (!claimed) return false;

  try {
    const result = await sendOmnisendEvent(event);
    await ledger.recordSend(input.name, event.eventID, result.ok, result.error);
    if (!result.ok) console.error(LOG, input.name, "refused", cartId, { status: result.status, error: result.error });
    return result.ok;
  } catch (error) {
    // The send never happened, so the claim must not outlive it.
    await ledger.releaseSend(input.name);
    console.error(LOG, input.name, "threw", cartId, error);
    return false;
  }
}

/**
 * Cart changed, email known (trackCart): `added product to cart`, at most
 * once per cart per ten minutes, never for a cart the in-house ladder owns,
 * and never again for a cart that has reached the checkout.
 */
export async function onCartTracked(input: OmnisendCartHookInput): Promise<void> {
  if (!omnisendActive().active) return;
  try {
    if (!normalizeEmail(input.email) || !input.cartId || input.items.length === 0) return;
    if (await cartHasInHouseStage(input.cartId)) return;
    if (await cartReachedCheckout(input.cartId)) return;
    await sendCartEventOnce({ name: "added product to cart", cart: input, campaign: "abandoned-cart", debounceMs: CART_EVENT_DEBOUNCE_MS });
  } catch (error) {
    console.error(LOG, "onCartTracked failed", input.cartId, error);
  }
}

/**
 * Checkout reached (markCheckoutStarted): `started checkout`, same
 * exclusion and debounce, with the checkout URL pointing at the shopper's
 * own restored cart. The recovery code is NOT minted here: the offer sweep
 * (cart-offers.ts) mints it by band, close to the message that carries it.
 */
export async function onCheckoutStarted(input: OmnisendCartHookInput): Promise<void> {
  if (!omnisendActive().active) return;
  try {
    if (!normalizeEmail(input.email) || !input.cartId || input.items.length === 0) return;
    if (await cartHasInHouseStage(input.cartId)) return;
    await sendCartEventOnce({ name: "started checkout", cart: input, campaign: "abandoned-checkout", debounceMs: CART_EVENT_DEBOUNCE_MS });
  } catch (error) {
    console.error(LOG, "onCheckoutStarted failed", input.cartId, error);
  }
}

export type ViewedProductInput = Pick<Product, "slug" | "name" | "price" | "stockStatus" | "category"> & Partial<Pick<Product, "salePrice" | "image">>;

/**
 * Product page rendered for a signed-in viewer: `viewed product`, at most
 * once per address and product per six hours. The price is the catalogue's
 * (the page already resolved the product server-side); the URL carries the
 * contact's own token so the browse-abandonment click lands on the product.
 */
export async function onProductViewed(email: string, product: ViewedProductInput): Promise<void> {
  if (!omnisendActive().active) return;
  try {
    const address = normalizeEmail(email);
    const slug = String(product?.slug ?? "").trim();
    if (!address || !slug) return;
    const origin = siteUrl();
    const event = buildViewedProduct({
      email: address,
      product: {
        slug,
        title: String(product.name ?? slug),
        priceCents: priceToCents(product.salePrice ?? product.price),
        url: await contactLinkFor(address, "browse-abandonment")(`/products/${slug}`),
        imageUrl: absoluteImage(product.image, origin),
        inStock: product.stockStatus !== "Out of Stock",
        category: product.category ?? null,
      },
    });
    const ledger = omnisendLedger(`view:${hashed(address)}:${slug}`);
    if (!(await ledger.claimSendWithin("viewed product", event.eventID, PRODUCT_VIEW_DEBOUNCE_MS))) return;
    try {
      const result = await sendOmnisendEvent(event);
      await ledger.recordSend("viewed product", event.eventID, result.ok, result.error);
      if (!result.ok) console.error(LOG, "viewed product refused", slug, { status: result.status, error: result.error });
    } catch (error) {
      await ledger.releaseSend("viewed product");
      throw error;
    }
  } catch (error) {
    console.error(LOG, "onProductViewed failed", String(product?.slug ?? ""), error);
  }
}
