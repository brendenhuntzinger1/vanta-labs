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

/**
 * WHAT AN OFFER CAN GRANT.
 *
 * Two shapes, because they are genuinely different operations rather than two
 * settings of one:
 *
 *   free_product   adds a real order line at $0. Inventory reserves it and its
 *                  COGS is booked, so the store knows what the gift cost.
 *   free_shipping  zeroes the shipping charge. There is no line, no stock and
 *                  no COGS — it is the absence of a fee.
 *   free_shipping_percent
 *                  both at once. The percentage competes in the store's
 *                  single-best-discount rule exactly as a coupon does; the free
 *                  shipping does not, because shipping was never in that race.
 *                  Worst case: the customer keeps a better discount and still
 *                  gets free shipping.
 *
 * Adding another kind means a new branch in quoteOrder and nothing else; adding
 * another PRODUCT gift means one entry below and no code at all.
 */
export type OfferReward =
  | { kind: "free_product"; productSlug: string }
  | { kind: "free_shipping" }
  | { kind: "free_shipping_percent"; percent: number }
  /** A percentage off and nothing else. Competes in the coupon slot exactly
   *  as the combined gift's percentage does; shipping is charged as usual. */
  | { kind: "percent"; percent: number }
  /** A $0 product line AND a percentage off the rest. */
  | { kind: "free_product_percent"; productSlug: string; percent: number };

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
  winback_60_bac_water_10: {
    label: "10% off + free BAC water",
    reward: { kind: "free_product_percent", productSlug: "bacteriostatic-water", percent: 10 } as OfferReward,
    // The vial is cheap, so the percentage is the real gift here; the floor
    // is the same half-a-vial the other discount gifts use.
    minSubtotalCents: 3500,
    ttlDays: 30,
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
export async function issueCustomerOffer(input: {
  offerKey: OfferKey;
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
  const config = OFFER_CATALOG[input.offerKey];
  const email = String(input.email ?? "").trim().toLowerCase();
  if (!email) return null;

  const now = input.now ?? Date.now();
  const expiresAt = new Date(now + config.ttlDays * 24 * 60 * 60 * 1000).toISOString();

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
      min_subtotal_cents: config.minSubtotalCents,
      expires_at: expiresAt,
    };
    const provenance = input.automationKey
      ? { automation_key: input.automationKey, reference_id: input.referenceId ?? null }
      : {};
    let { error } = await supabaseAdmin.from("customer_offers").insert({ ...row, ...provenance });
    // A database that has not run the 2026-09-04 section of customer-offers.sql
    // has no automation_key column (42703). The gift still has to go out; it is
    // only the redemption-attribution breadcrumb that is lost, and that is
    // logged rather than silently dropped.
    if (error && String(error.code ?? "") === "42703" && input.automationKey) {
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
    console.error("[offers] unable to issue", input.offerKey, email, first.message);
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
    console.error("[offers] unable to reissue", input.offerKey, email, second.message);
  }
  return null;
}

/** How long a checkout's hold on an offer is respected before it is presumed abandoned. */
const OFFER_HOLD_SECONDS = 1800;

/**
 * Retire the unredeemed row blocking a reissue, unless a checkout is holding it.
 * Returns true when the way is clear for a fresh insert.
 */
async function retireStaleOffer(offerKey: OfferKey, email: string, now: number): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from("customer_offers")
    .select("id, expires_at, reserved_order_id, reserved_at")
    .eq("offer_key", offerKey)
    .eq("email", email)
    .is("revoked_at", null)
    .is("redeemed_at", null)
    .maybeSingle();
  if (error) {
    console.error("[offers] unable to read the blocking offer", offerKey, email, error.message);
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
      console.error("[offers] unable to retire the redeemed offer", offerKey, email, redeemedError.message);
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
    console.error("[offers] unable to retire the stale offer", offerKey, email, revokeError.message);
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
  const config = OFFER_CATALOG[offerKey];
  const minimum = `$${(config.minSubtotalCents / 100).toFixed(config.minSubtotalCents % 100 === 0 ? 0 : 2)}`;
  const deadline = new Date(expiresAt).toLocaleDateString("en-US", {
    month: "long", day: "numeric", year: "numeric", timeZone: "America/New_York",
  });
  const gift = config.reward.kind === "free_product"
    ? `a free ${config.label.replace(/^free\s+/i, "")} is added to your order`
    : config.reward.kind === "free_product_percent"
      ? `${config.reward.percent}% off, and a free ${config.label.replace(/^.*free\s+/i, "")} is added to your order`
    : config.reward.kind === "free_shipping_percent"
      ? `${config.reward.percent}% off plus free shipping`
      : config.reward.kind === "percent"
        ? `${config.reward.percent}% off`
        : "free shipping";
  return `Your gift: ${gift} on any order of ${minimum} or more, through ${deadline}. `
    + "One per customer, for this email address only. It is applied automatically when you shop through the button below — no code needed.";
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
    if (closed > 0) console.log(`[offers] order ${orderId} closed ${closed} unused gift(s) for ${email}`);
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
      .select("id, offer_key, email, reward_kind, product_slug, percent_off, variant_id, min_subtotal_cents, expires_at, reserved_order_id, redeemed_at, revoked_at")
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
      .select("offer_key, reward_kind, product_slug, percent_off, min_subtotal_cents, expires_at, redeemed_at, revoked_at, email")
      .eq("token_hash", hashOfferToken(value))
      .maybeSingle();
    if (!data) return null;
    const row = data as { offer_key: string; reward_kind: string; product_slug: string | null; percent_off: number | null; min_subtotal_cents: number; expires_at: string; redeemed_at: string | null; revoked_at: string | null; email: string };
    if (row.redeemed_at || row.revoked_at) return null;
    if (new Date(row.expires_at).getTime() <= now) return null;
    return {
      offerKey: row.offer_key,
      rewardKind: row.reward_kind,
      productSlug: row.product_slug,
      percentOff: row.percent_off === null ? null : Number(row.percent_off),
      minSubtotalCents: Number(row.min_subtotal_cents ?? 0),
      expiresAt: row.expires_at,
      email: String(row.email ?? ""),
    };
  } catch {
    return null;
  }
}
