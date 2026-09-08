import "server-only";

import crypto from "crypto";
import { supabaseAdmin } from "@/lib/supabase-server";
import { redactEmailForLog } from "@/lib/log-redaction";
import { BAC_WATER_SLUG } from "@/lib/bac-water";
import {
  describeGiftTerms,
  offerRewardQuantity,
  type GiftConfig,
  type OfferReward,
} from "@/lib/offers/gift-terms";

// Re-exported so every existing caller keeps importing "what a gift means"
// from here. The definitions moved to gift-terms.ts only because they are pure
// and this module is `server-only`, and the campaign composer — a Client
// Component — has to render the same terms sentence the checkout enforces.
export {
  describeGiftTerms,
  offerRewardQuantity,
  type GiftConfig,
  type OfferReward,
};

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
    reward: { kind: "free_product", productSlug: "ghk-cu" } as OfferReward,
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
  winback_60_free_shipping: {
    label: "Free shipping",
    reward: { kind: "free_shipping" } as OfferReward,
    /**
     * THIS MINIMUM HAS A CEILING AS WELL AS A FLOOR, which is particular to
     * free shipping and easy to get wrong.
     *
     * The store already ships free over $200 domestic and $400 to the rest of
     * North America (shipping.ts, and the live admin config agrees). So a
     * free-shipping gift is worth $15 or $25 BELOW those thresholds and worth
     * exactly nothing at or above them — set the minimum to $200 and the gift
     * silently grants no discount at all, while still looking like a gift in
     * the email.
     *
     * $35 is a floor with room underneath the ceiling: about half a vial, so
     * the order is real, and far enough below $200 that the offer has value
     * across the whole band it can apply to.
     */
    minSubtotalCents: 3500,
    ttlDays: 30,
  },
  winback_60_free_shipping_15: {
    label: "Free shipping + 15% off",
    reward: { kind: "free_shipping_percent", percent: 15 } as OfferReward,
    // Same ceiling logic as the shipping-only gift: below $200 the customer
    // gets both halves, above it the shipping half is already theirs and only
    // the percentage bites. That degrades gracefully, so the floor is the only
    // number that needs choosing.
    minSubtotalCents: 3500,
    ttlDays: 30,
  },
  winback_60_free_shipping_10: {
    label: "Free shipping + 10% off",
    reward: { kind: "free_shipping_percent", percent: 10 } as OfferReward,
    // Same ceiling logic as the other shipping gift: below $200 the customer
    // gets both halves, above it only the percentage bites.
    minSubtotalCents: 3500,
    ttlDays: 30,
  },
  winback_60_bac_water_10: {
    label: "10% off + free BAC water",
    // THE SLUG COMES FROM bac-water.ts, IT IS NOT TYPED HERE. quoteOrder
    // resolves the gift with an exact `candidate.slug === offer.product_slug`
    // and has no candidate-list fallback, so a stale literal does not degrade —
    // the product half silently does not apply and only the percentage lands.
    // That is exactly what happened: this entry still said
    // "bacteriostatic-water" after rename-bac-water-slug.sql moved production
    // to "bac-water", so the day-40 mail promised "a free BAC Water on us" and
    // shipped none. The catalogue mock in offer-percent-competition.test.ts
    // carried the same stale literal, so the suite stayed green throughout.
    reward: { kind: "free_product_percent", productSlug: BAC_WATER_SLUG, percent: 10 } as OfferReward,
    // The vial is cheap, so the percentage is the real gift here; the floor
    // is the same half-a-vial the other discount gifts use.
    minSubtotalCents: 3500,
    ttlDays: 30,
  },
  winback_60_bac_water_15: {
    label: "15% off + free BAC water",
    reward: { kind: "free_product_percent", productSlug: BAC_WATER_SLUG, percent: 15 } as OfferReward,
    // The vial is cheap, so the percentage is the real gift here; the floor
    // is the same half-a-vial the other discount gifts use.
    minSubtotalCents: 3500,
    ttlDays: 30,
  },
  /**
   * TWO VIALS OF BAC WATER, FOR THE LABOR DAY CART RECOVERY.
   *
   * Issued by hand to two named abandoned carts rather than by an automation,
   * so it carries no `winback_` prefix — nothing on the retention ladder points
   * at it and nothing should.
   *
   * The two carts want opposite halves of the same mechanism, which is why the
   * gift is expressed as a count rather than as two separate offers: one cart
   * holds no BAC Water and receives two, the other already holds two and has
   * those made free. quote-order decides which from the cart, not from here.
   *
   * The floor is the same half-a-vial the other product gifts use — the vials
   * are $14.99 and the carts they are aimed at are $99 and $650, so it is a
   * guard against a token being spent on a basket of nothing, not a hurdle.
   */
  labor_day_bac_water_2: {
    label: "2 free BAC Water",
    reward: { kind: "free_product", productSlug: BAC_WATER_SLUG, quantity: 2 } as OfferReward,
    minSubtotalCents: 3500,
    // Long enough to outlast the Labor Day promotion it rides beside, so the
    // gift never dies before the sale the email pairs it with.
    ttlDays: 8,
  },
  /**
   * THE 72-HOUR FOLLOW-UP, for the four carts that did not come back.
   *
   * Forty percent is not a round number picked to sound generous — it is the
   * first one that changes anything for the two carts that matter. The store
   * grants ONE discount per order (bundleStacking is off), so a gift's
   * percentage competes with Buy 2 Get 1 rather than adding to it, and Buy 2
   * Get 1 is already worth 30% on a ten-unit cart and 33% on a three-unit one.
   * A 30% gift therefore loses the slot and is worth exactly $0 to both of
   * them; measured, not assumed. Forty beats it and is worth $64.99 and $34.00
   * more respectively.
   *
   * The two free vials ride ALONGSIDE it rather than competing, because a $0
   * product line is not in the discount race at all — which is what makes
   * "40% off AND two free BAC Water" expressible without touching the
   * store-wide stacking rule that every other customer depends on.
   *
   * What it must NOT be sold as is "Buy 2 Get 1 plus 40%". The customer gets
   * the better of the two, and at 40% that is the 40%.
   *
   * Five days, so a token minted at the 72-hour mark still outlives the sale
   * it sits beside.
   */
  labor_day_bac_water_2_40: {
    label: "2 free BAC Water",
    reward: { kind: "free_product_percent", productSlug: BAC_WATER_SLUG, percent: 40, quantity: 2 } as OfferReward,
    minSubtotalCents: 3500,
    ttlDays: 5,
  },
  /**
   * BOTH DISCOUNTS, WITHOUT LETTING THE WHOLE STORE STACK.
   *
   * The owner asked that these carts be able to use Buy 2 Get 1 AND the
   * follow-up percentage together. The store grants one discount per order,
   * and the only switches that change that — stackWithCoupon on the promotion,
   * or store-wide coupon stacking — apply to EVERY customer and every coupon in
   * circulation for as long as they are on. One of these four is holding a 5%
   * recovery coupon right now; so is anyone else who ever got a last-chance
   * email. That is not a risk worth taking for four people.
   *
   * So the stacked price is reproduced by a SINGLE percentage instead.
   * Measured through resolveCustomerDiscount, not derived on paper — an
   * earlier pass of this arithmetic was wrong twice, once by omitting the
   * quantity-bundle savings the promotion has to beat:
   *
   *   Heath   Buy 2 Get 1 + 40% stacked -> pays $194.97. 70% alone -> $194.97.
   *   Nikki   stacked -> $135.99. 70% alone -> $152.99, within $17.
   *
   * Heidi and Candace need no entry here: once the free vials are absorbed
   * neither has three paid units, so no Buy 2 Get 1 reward exists on their
   * carts and forty percent already IS both discounts for them.
   *
   * Seventy is a deep number and it is meant to be — it is the last message
   * before the cart ages out of the sequence entirely, and it still clears 37%
   * margin on the largest cart before shipping and card fees.
   */
  labor_day_bac_water_2_70: {
    label: "2 free BAC Water",
    reward: { kind: "free_product_percent", productSlug: BAC_WATER_SLUG, percent: 70, quantity: 2 } as OfferReward,
    minSubtotalCents: 3500,
    ttlDays: 5,
  },
  winback_60_percent_15: {
    label: "15% off",
    reward: { kind: "percent", percent: 15 } as OfferReward,
    // The same floor as the other discount gifts: about half a vial, so the
    // order is real. No ceiling to worry about — unlike free shipping, a
    // percentage is worth something at every basket size.
    minSubtotalCents: 3500,
    ttlDays: 30,
  },
  /**
   * THE STANDING CART-RECOVERY GIFT, carried by stages 3 and 4.
   *
   * A PURE PRODUCT, WITH NO PERCENTAGE ATTACHED, AND THAT IS THE WHOLE POINT.
   * The store grants one discount per order, so a gift's percentage competes
   * for the discount slot against the live promotion and can lose outright —
   * with Buy 2 Get 1 running, ten percent was measured worth exactly $0 to
   * Heath's cart and to Nikki's. A $0 product line is not in that race at all,
   * so this gift is worth its full $14.99 whatever else the store is running,
   * on the largest carts as much as the smallest.
   *
   * It is also the cheapest thing the ladder can offer: one vial of COGS
   * against a $230 median recovery cart, versus roughly $25 for ten percent of
   * one. Stage 4 pairs it with a coupon, and the two ride together for the same
   * reason the Labor Day gifts did — the product half and the percentage half
   * occupy different slots.
   *
   * TEN DAYS, not the five the Labor Day tokens used. Stage 3 fires anywhere in
   * the 24-72 hour window and stage 4 up to 96 hours, and the SAME entitlement
   * is re-offered at stage 4 rather than a second one being minted — so the
   * token has to outlive the whole tail of the sequence plus a weekend.
   *
   * Its own key, with no `winback_` prefix: nothing on the retention ladder
   * points at it and nothing should.
   */
  cart_recovery_bac_water: {
    label: "Free BAC Water",
    reward: { kind: "free_product", productSlug: BAC_WATER_SLUG, quantity: 1 } as OfferReward,
    minSubtotalCents: 3500,
    ttlDays: 10,
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
  /** 'free_product' | 'free_shipping'. Stored, not inferred — see the SQL. */
  reward_kind: string;
  /** Null for a shipping gift. A check constraint keeps the two in step. */
  product_slug: string | null;
  /** How many units the product half grants. Null when there is no product
   *  half; null ALSO on a row minted before the column existed, which is why
   *  every reader treats null as one rather than as zero. */
  quantity: number | null;
  /** Set only for free_shipping_percent. */
  percent_off: number | null;
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
/**
 * Mint the gift a CATALOGUE key names.
 *
 * The original entry point, unchanged for every existing caller and still
 * typed on OfferKey so a mistyped key is a compile error rather than a silent
 * null at 3am. The work happens in issueResolvedOffer below, which takes the
 * catalogue entry rather than the key that names it — because a campaign gift
 * an operator built has exactly the same shape and no key in the catalogue.
 */
export async function issueCustomerOffer(input: {
  offerKey: OfferKey;
  email: string;
  automationKey?: string;
  referenceId?: string;
  now?: number;
}): Promise<{ token: string; expiresAt: string } | null> {
  return issueResolvedOffer({ ...input, config: OFFER_CATALOG[input.offerKey] });
}

/**
 * Mint a gift from a RESOLVED config, whatever produced it.
 *
 * `offerKey` is a plain string here on purpose: a campaign gift files under
 * `campaign:<id>` (campaign-gift.ts), which is deliberately not a catalogue
 * key. It still governs the one-live-offer index, so the invariant holds
 * per campaign per recipient exactly as it holds per automation per recipient.
 *
 * The row records what was PROMISED, so nothing downstream ever needs to
 * resolve the key back to a config — which is what makes an operator-built
 * gift redeem through the identical path as a catalogue one.
 */
export async function issueResolvedOffer(input: {
  offerKey: string;
  config: GiftConfig;
  email: string;
  /**
   * Which automation send is minting this gift. Written onto the row so a
   * redemption can credit that automation without a click cookie (see
   * marketing-attribution.ts). Optional: a hand-minted or legacy row carries
   * null and simply cannot be attributed that way.
   */
  automationKey?: string;
  referenceId?: string;
  now?: number;
}): Promise<{ token: string; expiresAt: string } | null> {
  const config = input.config;
  const email = String(input.email ?? "").trim().toLowerCase();
  if (!email || !config) return null;

  const now = input.now ?? Date.now();
  const expiresAt = new Date(now + config.ttlDays * 24 * 60 * 60 * 1000).toISOString();
  const quantity = offerRewardQuantity(config.reward);

  const mint = async (): Promise<{ token: string; expiresAt: string } | { code: string; message: string }> => {
    const token = crypto.randomBytes(TOKEN_BYTES).toString("base64url");
    const row = {
      offer_key: input.offerKey,
      token_hash: hashOfferToken(token),
      email,
      // The row records what was promised, so a token minted today still redeems
      // as this even if the catalogue entry is edited or retired inside its
      // thirty-day life.
      reward_kind: config.reward.kind,
      product_slug: config.reward.kind === "free_product" || config.reward.kind === "free_product_percent" ? config.reward.productSlug : null,
      percent_off: config.reward.kind === "free_shipping_percent" || config.reward.kind === "percent" || config.reward.kind === "free_product_percent" ? config.reward.percent : null,
      // Null for a gift with no product line, so the check constraint can say
      // "a count only where there is something to count".
      ...(quantity === null ? {} : { quantity }),
      min_subtotal_cents: config.minSubtotalCents,
      expires_at: expiresAt,
    };
    // REFERENCE_ID IS WRITTEN WHENEVER IT IS GIVEN, automation or not.
    //
    // It used to ride only alongside `automation_key`, so a caller that passed
    // a referenceId and no automationKey — every cart-recovery gift does — had
    // it silently dropped. Nothing failed; the breadcrumb simply was not there,
    // which is how the cart-recovery gift cooldown could not tell a second gift
    // to one address from the SAME cart's second stage re-minting its own.
    const provenance = {
      ...(input.automationKey ? { automation_key: input.automationKey } : {}),
      ...(input.referenceId ? { reference_id: input.referenceId } : {}),
    };
    let { error } = await supabaseAdmin.from("customer_offers").insert({ ...row, ...provenance });
    // A database that has not run the 2026-09-04 section of customer-offers.sql
    // has no automation_key column (42703). The gift still has to go out; it is
    // only the redemption-attribution breadcrumb that is lost, and that is
    // logged rather than silently dropped.
    //
    // NOTE THE RETRY STILL CARRIES `row`, AND SO STILL CARRIES `quantity`.
    // That is the difference between the two columns and it is deliberate: a
    // missing provenance column costs a report, while a missing quantity column
    // would let the row's default answer 1 for a gift whose email promised two.
    // Retrying without the count would ship one vial against a two-vial
    // promise; failing the mint sends nothing, which is the recoverable half.
    if (error && String(error.code ?? "") === "42703" && Object.keys(provenance).length > 0) {
      console.error("[offers] customer_offers has no provenance columns yet; minting without them", error.message);
      ({ error } = await supabaseAdmin.from("customer_offers").insert(row));
    }
    if (error) return { code: String(error.code ?? ""), message: String(error.message ?? "") };
    return { token, expiresAt };
  };

  const first = await mint();
  if ("token" in first) return first;

  // Anything but the one-live-offer index is a real failure. The caller must
  // not mail a token that does not exist, so it gets null, and this is logged.
  if (first.code !== "23505") {
    console.error("[offers] unable to issue", input.offerKey, redactEmailForLog(email), first.message);
    return null;
  }

  // THE INDEX FIRED: this address already holds an unredeemed row. That row is
  // one of three things, and only one of them is a reason to hand out nothing.
  //
  //   * EXPIRED. The last win-back's token ran out unused. The customer has
  //     lapsed again and is being written to again; a dead row must not stand
  //     in the way of the gift the new email promises.
  //   * LIVE BUT LOST. The last sweep minted it, then its send failed (the
  //     token exists only in that dead process — it is never stored). The
  //     retry is this call, and it needs a token it can actually deliver.
  //   * LIVE AND HELD BY A CHECKOUT IN FLIGHT. The customer is spending it at
  //     this moment. Retiring it now would race their order, so this send
  //     waits for the next sweep, when the hold has settled either way.
  //
  // Retiring the old row and minting a fresh one keeps the invariant the
  // index exists for — at most one spendable token per address per campaign —
  // while making the email honest: the link in the NEWEST message always works,
  // and only that one. A previous message's link stops working, which is what
  // "one live offer" means.
  if (!(await retireStaleOffer(input.offerKey, email, now))) return null;

  const second = await mint();
  if ("token" in second) return second;
  // A concurrent sweep re-minted between the retire and the insert. It holds
  // the token; this caller has none, and says so.
  if (second.code !== "23505") {
    console.error("[offers] unable to reissue", input.offerKey, redactEmailForLog(email), second.message);
  }
  return null;
}

/**
 * Withdraw a gift that was minted and then never delivered.
 *
 * WHY THIS IS NEEDED, and it is specific to campaigns. A gift has to be minted
 * BEFORE the message is rendered, because its token goes in the button and its
 * terms go in the body. If the send then fails — the provider refuses, the
 * address is suppressed, the render throws — the row survives in
 * `customer_offers` as a live, spendable, unredeemed offer that nobody was
 * ever told about. It then blocks the one-live-offer index, so the RETRY on
 * the next sweep has to retire it before it can mint again, and in the window
 * between the two an unnannounced gift sits open against the store.
 *
 * The automations avoid this by minting only after the frequency guard has
 * granted the claim, and the campaign sender now does the same. This closes
 * the remainder: the failures that happen after a claim is held.
 *
 * Keyed on the TOKEN because that is the only handle the caller has — the row
 * id is never returned and the token is never stored, only its hash. Best
 * effort and never throws: an un-withdrawn offer costs at most one gift, and
 * failing a send over the bookkeeping would cost the whole campaign.
 *
 * Only ever touches an offer that is still unspent. A row a customer has
 * already reserved or redeemed is left exactly as it is.
 */
export async function revokeUnredeemedOffer(token: string, reason = "send_failed"): Promise<boolean> {
  const raw = String(token ?? "").trim();
  if (!raw) return false;
  try {
    const { error } = await supabaseAdmin
      .from("customer_offers")
      .update({ revoked_at: new Date().toISOString(), revoke_reason: reason })
      .eq("token_hash", hashOfferToken(raw))
      .is("revoked_at", null)
      .is("redeemed_at", null)
      .is("reserved_order_id", null);
    if (error) {
      console.error("[offers] unable to withdraw an undelivered gift", error.message);
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** How long a checkout's hold on an offer is respected before it is presumed abandoned. */
const OFFER_HOLD_SECONDS = 1800;

/**
 * Retire the unredeemed row blocking a reissue, unless a checkout is holding it.
 * Returns true when the way is clear for a fresh insert.
 */
async function retireStaleOffer(offerKey: string, email: string, now: number): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from("customer_offers")
    .select("id, expires_at, reserved_order_id, reserved_at")
    .eq("offer_key", offerKey)
    .eq("email", email)
    .is("revoked_at", null)
    .is("redeemed_at", null)
    .maybeSingle();
  if (error) {
    console.error("[offers] unable to read the blocking offer", offerKey, redactEmailForLog(email), error.message);
    return false;
  }
  // No unredeemed row. Either something else retired it between the two calls,
  // or the database still carries the ORIGINAL index — `where revoked_at is
  // null` — under which a REDEEMED row blocks the insert too. The migration
  // that narrows it may land after this code does, so retire a redeemed row
  // here as well: every reader refuses a redeemed row before it looks at
  // revoked_at, so the flag changes nothing about that row's meaning.
  if (!data) {
    const { error: redeemedError } = await supabaseAdmin
      .from("customer_offers")
      .update({ revoked_at: new Date(now).toISOString() })
      .eq("offer_key", offerKey)
      .eq("email", email)
      .is("revoked_at", null)
      .not("redeemed_at", "is", null);
    if (redeemedError) {
      console.error("[offers] unable to retire the redeemed offer", offerKey, redactEmailForLog(email), redeemedError.message);
      return false;
    }
    return true;
  }

  const row = data as { id: string; expires_at: string; reserved_order_id: string | null; reserved_at: string | null };
  const expired = new Date(row.expires_at).getTime() <= now;
  const heldAt = row.reserved_at ? new Date(row.reserved_at).getTime() : 0;
  const heldByLiveCheckout = Boolean(row.reserved_order_id) && heldAt > now - OFFER_HOLD_SECONDS * 1000;
  if (!expired && heldByLiveCheckout) return false;

  const { error: revokeError } = await supabaseAdmin
    .from("customer_offers")
    .update({ revoked_at: new Date(now).toISOString(), revoke_reason: "reissued" })
    .eq("id", row.id)
    .is("revoked_at", null)
    .is("redeemed_at", null);
  if (revokeError) {
    console.error("[offers] unable to retire the stale offer", offerKey, redactEmailForLog(email), revokeError.message);
    return false;
  }
  return true;
}

/**
 * The gift's terms, in the customer's words, for the email that carries it.
 *
 * Rendered by the sweep beneath the operator's copy, from the same catalogue
 * entry the checkout enforces — so whatever the operator writes, the message
 * also states the minimum, the deadline and the one-per-customer rule that
 * quoteOrder and customer_offer_reserve will actually apply. Copy that promises
 * more than the till honours is the failure this line exists to prevent.
 */
export function describeOfferTerms(offerKey: OfferKey, expiresAt: string): string {
  return describeGiftTerms(OFFER_CATALOG[offerKey], expiresAt);
}

/**
 * The same sentence, for a gift that has no catalogue key.
 *
 * Split out rather than duplicated because this line is the ONE place the
 * customer's copy and the checkout are guaranteed to agree. A campaign gift
 * with its own wording of the minimum and the deadline would be a second
 * statement of the terms, free to drift from the row quoteOrder actually
 * prices — which is the whole failure this sentence exists to prevent.
 */
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
  /**
   * How long this order's hold outlasts a competing checkout. Defaults to the
   * database's 30 minutes, which fits a card checkout that is abandoned. The
   * manual-payment lane holds stock for a day while the transfer arrives and
   * must hold the gift for exactly as long — otherwise a second checkout by
   * the same customer 31 minutes later is priced with the same gift, takes
   * over the hold, and both orders ship the free unit on one token.
   */
  holdSeconds?: number;
}): Promise<CustomerOffer | null> {
  const token = String(input.token ?? "").trim();
  if (!token) return null;

  try {
    const { data, error } = await supabaseAdmin.rpc("customer_offer_reserve", {
      p_token_hash: hashOfferToken(token),
      p_order_id: String(input.orderId ?? "").trim(),
      p_email: String(input.email ?? "").trim().toLowerCase(),
      ...(input.holdSeconds !== undefined ? { p_hold_seconds: Math.max(0, Math.round(input.holdSeconds)) } : {}),
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

/**
 * A PAID ORDER CLOSES THE RETENTION CYCLE.
 *
 * Every unredeemed gift this address holds dies, except the one the order is
 * spending (redeem has already marked it, and the SQL skips this order's own
 * reservation regardless). Runs beside redeemCustomerOffer in the paid
 * side-effects path, and for the same reason: a retention offer exists to
 * recover ONE purchase, and once that purchase is paid the day-30, day-40 and
 * day-50 gifts must not stay collectable for three separate later orders. A
 * customer who reorders without clicking the email is covered too — nothing
 * was reserved, so everything they held is closed.
 *
 * Idempotent, scoped to one address and to customer_offers only, and
 * non-throwing: an un-migrated database costs the closure, never the order.
 * Returns how many gifts were closed, for the log.
 */
export async function closeCustomerOfferCycle(input: { orderId: string; email: string | null | undefined }): Promise<number> {
  const orderId = String(input.orderId ?? "").trim();
  const email = String(input.email ?? "").trim().toLowerCase();
  if (!orderId || !email) return 0;
  try {
    const { data, error } = await supabaseAdmin.rpc("customer_offer_close_cycle", {
      p_order_id: orderId,
      p_email: email,
    });
    if (error) {
      console.error("[offers] close-cycle failed", orderId, error.message);
      return 0;
    }
    const closed = Number(data ?? 0);
    // The order id is the join key an operator needs; the address is PII that
    // would otherwise sit in the platform log store in clear (see log-redaction.ts).
    if (closed > 0) console.log(`[offers] order ${orderId} closed ${closed} unused gift(s) for ${redactEmailForLog(email)}`);
    return Number.isFinite(closed) ? closed : 0;
  } catch (error) {
    console.error("[offers] close-cycle unavailable", orderId, error);
    return 0;
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
      .select("id, offer_key, email, reward_kind, product_slug, percent_off, quantity, variant_id, min_subtotal_cents, expires_at, reserved_order_id, redeemed_at, revoked_at")
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
  rewardKind: string;
  productSlug: string | null;
  percentOff: number | null;
  /** Units the product half grants; null when there is no product half. */
  quantity: number | null;
  minSubtotalCents: number;
  expiresAt: string;
  /**
   * The address this offer is bound to. SERVER-SIDE ONLY — do not put it in a
   * response body.
   *
   * /api/checkout/quote needs it: a preview asked before the shopper has typed
   * their email would otherwise resolve no offer at all (peekCustomerOffer
   * matches on the address, correctly), and the cart would quote the gift away
   * in the one place the shopper is deciding what to buy. Previewing against
   * the bound address answers the question the banner already poses — "what do
   * I get if I check out with the address this was sent to" — and grants
   * nothing: reserveCustomerOffer re-checks the binding under a lock, so an
   * order placed under a different address still gets no free unit.
   */
  email: string;
} | null> {
  const value = String(token ?? "").trim();
  if (!value) return null;
  try {
    const { data } = await supabaseAdmin
      .from("customer_offers")
      .select("offer_key, reward_kind, product_slug, percent_off, quantity, min_subtotal_cents, expires_at, redeemed_at, revoked_at, email")
      .eq("token_hash", hashOfferToken(value))
      .maybeSingle();
    if (!data) return null;
    const row = data as { offer_key: string; reward_kind: string; product_slug: string | null; percent_off: number | null; quantity: number | null; min_subtotal_cents: number; expires_at: string; redeemed_at: string | null; revoked_at: string | null; email: string };
    if (row.redeemed_at || row.revoked_at) return null;
    if (new Date(row.expires_at).getTime() <= now) return null;
    return {
      offerKey: row.offer_key,
      rewardKind: row.reward_kind,
      productSlug: row.product_slug,
      percentOff: row.percent_off === null ? null : Number(row.percent_off),
      // Null only where there is no product. A row minted before the column
      // existed reads null too, and every reader treats that as one.
      quantity: row.product_slug === null ? null : Math.max(1, Math.floor(Number(row.quantity ?? 1))),
      minSubtotalCents: Number(row.min_subtotal_cents ?? 0),
      expiresAt: row.expires_at,
      email: String(row.email ?? ""),
    };
  } catch {
    return null;
  }
}
