import "server-only";

import crypto from "crypto";
import { supabaseAdmin } from "@/lib/supabase-server";

/**
 * One-time, per-customer offers.
 *
 * The free GHK-Cu that rides on the 60-day win-back is the first, and the shape
 * generalises: a customer is mailed a token that only they can spend, only
 * once, only before it expires, and only on an order that clears a minimum.
 *
 * THE TOKEN IS A BEARER SECRET AND IS TREATED LIKE ONE. It is 32 random bytes,
 * it is never written to the database, never logged, and never put in a
 * redirect the customer can read off a referrer header. Only its sha256 is
 * stored, so the table is worth nothing to anyone who reads it.
 *
 * WHY NOT A COUPON. `coupons` already has `assigned_email`, and it looks like
 * the answer until you read `redeem_coupon()`: that RPC is one UPDATE keyed on
 * the CODE, and it never reads assigned_email. The binding is enforced when the
 * cart is priced and NOT when the redemption is recorded, which is fine for a
 * percentage-off code and not fine for a physical product. One shared code also
 * means one shared expiry and one shared counter — "expire it for the batch
 * mailed in March" is not expressible at all.
 */

const TOKEN_BYTES = 32;

/**
 * Where the token lives between the click and the checkout.
 *
 * httpOnly, so no script on the page can read it — not ours, and not one
 * injected into it. This is why the token is NOT carried in the URL to the
 * landing page: a query parameter is readable by every script on the page,
 * lands in the Referer header of every outbound request, and is copied into
 * analytics, session recorders and the customer's own shared link. A bearer
 * secret that grants a physical product does not belong in any of those.
 *
 * Lax rather than Strict: the customer arrives from their mail client, which is
 * a cross-site top-level navigation, and Strict would drop the cookie on
 * exactly the hop this exists for.
 */
export const OFFER_COOKIE = "vl_offer";

/** As long as the offer itself could plausibly last. */
export const OFFER_COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

/** Read the offer token off a plain `Request`, server-side only. */
export function readOfferCookie(request: Request): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== OFFER_COOKIE) continue;
    const value = decodeURIComponent(part.slice(separator + 1).trim());
    // Same cap the click route applies. A token is 43 characters of base64url.
    return value && value.length <= 128 ? value : null;
  }
  return null;
}

/** The offers this store knows how to grant. */
export const OFFER_CATALOG = {
  winback_60_free_ghkcu: {
    label: "Free GHK-Cu",
    productSlug: "ghk-cu",
    /**
     * The gate, and it is not optional.
     *
     * With no minimum, the correct play for a recipient is to redeem the token
     * with nothing else in the basket: the store ships a vial, collects the
     * postage, and books the COGS as a loss. A win-back is meant to restart a
     * buying relationship, so the offer only fires on an order that is already
     * a real order. £/$ 60 is a little under one full-price unit, so the
     * customer is always spending more than the gift costs.
     */
    minSubtotalCents: 6000,
    /** How long a recipient has. Long enough to be a real offer, short enough
     *  that the liability does not sit open forever. */
    ttlDays: 30,
  },
} as const;

export type OfferKey = keyof typeof OFFER_CATALOG;

export function isOfferKey(value: unknown): value is OfferKey {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(OFFER_CATALOG, value);
}

export type CustomerOffer = {
  id: string;
  offer_key: string;
  email: string;
  product_slug: string;
  variant_id: string | null;
  min_subtotal_cents: number;
  expires_at: string;
  reserved_order_id: string | null;
  redeemed_at: string | null;
};

/** The stored form of a token. Never reversible; that is the point. */
export function hashOfferToken(token: string): string {
  return crypto.createHash("sha256").update(String(token ?? "").trim()).digest("hex");
}

/**
 * Mint an offer for one customer and return the token to put in their email.
 *
 * Returns null when they already have a live one. That is the ordinary case on
 * a second sweep, not an error: without the partial unique index behind it, a
 * re-run would hand the same person a second valid token and the store would
 * ship two free vials, both perfectly legitimate.
 *
 * THE TOKEN IS RETURNED AND NEVER PERSISTED. If the caller loses it — the send
 * fails, the process dies — the offer row is stranded and unusable, which is
 * the safe direction. A stranded row expires on its own.
 */
export async function issueCustomerOffer(input: {
  offerKey: OfferKey;
  email: string;
  now?: number;
}): Promise<{ token: string; expiresAt: string } | null> {
  const config = OFFER_CATALOG[input.offerKey];
  const email = String(input.email ?? "").trim().toLowerCase();
  if (!email) return null;

  const now = input.now ?? Date.now();
  const expiresAt = new Date(now + config.ttlDays * 24 * 60 * 60 * 1000).toISOString();
  const token = crypto.randomBytes(TOKEN_BYTES).toString("base64url");

  const { error } = await supabaseAdmin.from("customer_offers").insert({
    offer_key: input.offerKey,
    token_hash: hashOfferToken(token),
    email,
    product_slug: config.productSlug,
    min_subtotal_cents: config.minSubtotalCents,
    expires_at: expiresAt,
  });

  if (error) {
    // 23505 is the one-live-offer-per-address index doing its job. Anything
    // else is a real failure and the caller must not mail a token that does not
    // exist, so both return null and only the unexpected one is logged.
    if (error.code !== "23505") {
      console.error("[offers] unable to issue", input.offerKey, email, error.message);
    }
    return null;
  }

  return { token, expiresAt };
}

/**
 * Hold an offer for one order while its checkout runs.
 *
 * Every check that matters lives in the SQL function, under an advisory lock,
 * because "is it still valid" and "mark it mine" have to be one decision. See
 * customer-offers.sql.
 *
 * Returns null for every refusal, with no reason attached. A caller that told a
 * visitor WHY their token failed would let one enumerate valid tokens, valid
 * addresses, and the expiry window.
 */
export async function reserveCustomerOffer(input: {
  token: string;
  orderId: string;
  email: string;
}): Promise<CustomerOffer | null> {
  const token = String(input.token ?? "").trim();
  if (!token) return null;

  try {
    const { data, error } = await supabaseAdmin.rpc("customer_offer_reserve", {
      p_token_hash: hashOfferToken(token),
      p_order_id: String(input.orderId ?? "").trim(),
      p_email: String(input.email ?? "").trim().toLowerCase(),
    });
    if (error) {
      console.error("[offers] reserve failed", error.message);
      return null;
    }
    const rows = (data ?? []) as CustomerOffer[];
    return rows[0] ?? null;
  } catch (error) {
    // An un-migrated database must not take the whole checkout down with it.
    // No offer applies; the customer pays the ordinary price.
    console.error("[offers] reserve unavailable", error);
    return null;
  }
}

/**
 * Consume the offer this order was holding. Permanent.
 *
 * Runs where the other exactly-once side effects of payment run. Nothing
 * un-marks it: a refunded order has usually already shipped, so releasing the
 * offer would let one customer redeem, refund and redeem again indefinitely.
 * That asymmetry with the Buy X Get Y claim table — which DOES release on
 * refund — is deliberate and is written up in customer-offers.sql.
 */
export async function redeemCustomerOffer(orderId: string): Promise<boolean> {
  try {
    const { data, error } = await supabaseAdmin.rpc("customer_offer_redeem", {
      p_order_id: String(orderId ?? "").trim(),
    });
    if (error) {
      console.error("[offers] redeem failed", orderId, error.message);
      return false;
    }
    return Boolean(data);
  } catch (error) {
    console.error("[offers] redeem unavailable", orderId, error);
    return false;
  }
}

/** Drop an unpaid checkout's hold. Never touches a redeemed offer. */
export async function releaseCustomerOffer(orderId: string): Promise<boolean> {
  try {
    const { data } = await supabaseAdmin.rpc("customer_offer_release", {
      p_order_id: String(orderId ?? "").trim(),
    });
    return Boolean(data);
  } catch {
    return false;
  }
}

/**
 * Whether a cart clears the offer's minimum.
 *
 * Pure, and takes the subtotal BEFORE the free unit is added — adding a $0 line
 * cannot move a subtotal, but stating which side of the calculation this sits
 * on stops a future refactor from quietly making the gift pay for itself.
 */
export function offerMinimumMet(offer: { min_subtotal_cents: number }, subtotalCents: number): boolean {
  return Number(subtotalCents) >= Number(offer.min_subtotal_cents ?? 0);
}

/**
 * Look an offer up WITHOUT taking it, for pricing.
 *
 * WHY THERE ARE TWO STEPS. `customer_offer_reserve` needs an order id, and at
 * the moment the cart is priced no order exists yet — it is written seconds
 * later, and if the reservation is refused it must never be written at all.
 * That is the same shape the Buy X Get Y promotion limits have, and it gets the
 * same treatment: price optimistically here, claim authoritatively at order
 * creation, and refuse the order if the claim fails.
 *
 * SO THIS IS ADVISORY AND ONLY ADVISORY. It takes no lock and grants nothing. A
 * second checkout racing the first will also see a spendable offer here; only
 * one of them will win the reserve, and the loser's order is refused rather
 * than shipped. Nothing downstream may treat a peek as permission.
 */
export async function peekCustomerOffer(input: {
  token: string;
  email: string;
  now?: number;
}): Promise<CustomerOffer | null> {
  const token = String(input.token ?? "").trim();
  const email = String(input.email ?? "").trim().toLowerCase();
  if (!token || !email) return null;

  try {
    const { data, error } = await supabaseAdmin
      .from("customer_offers")
      .select("id, offer_key, email, product_slug, variant_id, min_subtotal_cents, expires_at, reserved_order_id, redeemed_at, revoked_at")
      .eq("token_hash", hashOfferToken(token))
      .maybeSingle();
    if (error || !data) return null;

    const offer = data as CustomerOffer & { revoked_at: string | null };
    const now = input.now ?? Date.now();
    if (offer.revoked_at) return null;
    if (offer.redeemed_at) return null;
    if (new Date(offer.expires_at).getTime() <= now) return null;
    // The binding, checked here too. The reserve enforces it authoritatively;
    // repeating it means a mismatched address never even sees a free line
    // appear and then vanish at the last step.
    if (offer.email !== email) return null;
    return offer;
  } catch {
    // An un-migrated database prices the ordinary order. It does not fail it.
    return null;
  }
}

/**
 * The parts of an offer that are safe to show the person holding the cookie.
 *
 * NO EMAIL IS REQUIRED, and that is deliberate rather than an oversight. A
 * shopper who clicked the link has not typed their address yet — they are
 * browsing — and refusing to show them the gift until checkout would make the
 * offer invisible for the whole part of the visit where it changes behaviour.
 *
 * Nothing here is a secret. The holder of the cookie already received the
 * email, and the response says only what that email said: which product, what
 * the minimum is, when it runs out. It grants NOTHING — the binding to an
 * address is enforced where it matters, at pricing and again under a lock at
 * reservation, and a browser that shows this banner and then checks out under a
 * different address gets no free unit.
 */
export async function readOfferStatus(token: string | null | undefined, now = Date.now()): Promise<{
  offerKey: string;
  productSlug: string;
  minSubtotalCents: number;
  expiresAt: string;
} | null> {
  const value = String(token ?? "").trim();
  if (!value) return null;
  try {
    const { data } = await supabaseAdmin
      .from("customer_offers")
      .select("offer_key, product_slug, min_subtotal_cents, expires_at, redeemed_at, revoked_at")
      .eq("token_hash", hashOfferToken(value))
      .maybeSingle();
    if (!data) return null;
    const row = data as { offer_key: string; product_slug: string; min_subtotal_cents: number; expires_at: string; redeemed_at: string | null; revoked_at: string | null };
    if (row.redeemed_at || row.revoked_at) return null;
    if (new Date(row.expires_at).getTime() <= now) return null;
    return {
      offerKey: row.offer_key,
      productSlug: row.product_slug,
      minSubtotalCents: Number(row.min_subtotal_cents ?? 0),
      expiresAt: row.expires_at,
    };
  } catch {
    return null;
  }
}
