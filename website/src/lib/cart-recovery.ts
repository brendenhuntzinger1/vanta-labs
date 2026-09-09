import "server-only";
import crypto from "crypto";

import { supabaseAdmin } from "@/lib/supabase-server";
import { getCartRecoveryControlConfig, getShippingConfig, type CartRecoveryConfig } from "@/lib/admin-control";
import { DEFAULT_RECOVERY_TIERS, type RecoveryGiftItem } from "@/lib/cart-recovery-tiers";
import { getSiteUrl } from "@/lib/env";
import { isFreeShippingSitewide } from "@/lib/shipping";
import { formatDisplayDate } from "@/lib/format-date";
import { isMarketingSuppressed, sendMarketingEmail } from "@/lib/email/marketing";
import { claimMarketingSend } from "@/lib/email/frequency";
import { plainGreetingName } from "@/lib/email/greeting-name";
import { getCatalogProductsBySlugs, getStockLevelsBySlugs } from "@/lib/catalog";
import { isPaidOrderStatus, isProductPurchaseOrder } from "@/lib/ledger";
import {
  cartRecoveryGiftTemplate,
  cartRecoveryT30mTemplate,
  cartRecoveryT12hTemplate,
  cartRecoveryT24hTemplate,
  cartRecoveryT72hTemplate,
} from "@/lib/email/templates";
import { getApplicableBxgyPromotions } from "@/lib/bxgy-promotions";
import {
  describeGiftTerms,
  describeOfferTerms,
  issueCustomerOffer,
  issueResolvedOffer,
  OFFER_CATALOG,
} from "@/lib/offers/customer-offers";
import { loadCartRecoveryOverrides, resolveOverridePerks, markCartRecoveryOverrideConsumed } from "@/lib/cart-recovery-overrides";
import { recoveryVariantFor } from "@/lib/cart-recovery-experiments";
import {
  planStageOffer,
  recoveryGiftConfig,
  RECOVERY_GIFT_COOLDOWN_MS,
  RECOVERY_GIFT_OFFER_KEY,
} from "@/lib/cart-recovery-offers";

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

export interface AbandonedCartItemSnapshot {
  slug: string;
  variantId?: string;
  name: string;
  quantity: number;
  unitPrice: number;
  image?: string;
}

export interface TrackCartInput {
  sessionId: string;
  customerUserId?: string | null;
  email: string;
  customerName?: string | null;
  items: AbandonedCartItemSnapshot[];
  cartValueCents: number;
}

// Called on every debounced cart change once an email is known (signed-in
// account, or typed into the checkout email field). One active row per
// session - later calls update the same row rather than creating
// duplicates, since a partial unique index can't be targeted through the
// query builder's upsert() (see the read-then-branch pattern also used in
// payment-webhook.ts's upsertOrderRecord).
export async function trackCart(input: TrackCartInput) {
  const email = input.email.trim().toLowerCase();
  if (!email) return;

  // AN EMPTY CART IS AN EXIT, NOT A NON-EVENT.
  //
  // This used to return early on an empty item list, which left the last
  // non-empty snapshot 'active' for ever: a shopper who removed everything
  // still received every recovery stage for products they had already decided
  // against. Clearing the row is what "they changed their mind" looks like to
  // the sweep.
  if (!input.items.length) {
    await clearAbandonedCart(input.sessionId);
    return;
  }

  const { data: existing, error: existingError } = await supabaseAdmin
    .from("abandoned_carts")
    .select("id")
    .eq("session_id", input.sessionId)
    .eq("status", "active")
    .maybeSingle();

  if (existingError) throw existingError;

  const payload = {
    session_id: input.sessionId,
    customer_user_id: input.customerUserId ?? null,
    email,
    customer_name: input.customerName ?? null,
    items: input.items,
    cart_value_cents: Math.round(input.cartValueCents),
    last_updated_at: new Date().toISOString(),
  };

  if (existing) {
    const { error } = await supabaseAdmin.from("abandoned_carts").update(payload).eq("id", existing.id);
    if (error) throw error;
    return;
  }

  const { error } = await supabaseAdmin.from("abandoned_carts").insert({
    ...payload,
    first_seen_at: new Date().toISOString(),
    status: "active",
    created_at: new Date().toISOString(),
  });
  if (error) throw error;
}

/**
 * Retire the active cart for a browser session: the shopper emptied it.
 *
 * 'cleared' rather than deleted, so the admin history still shows the cart
 * existed and what was in it; the sweep only ever reads 'active' rows, so a
 * cleared cart can never be mailed again. A later add-to-cart in the same
 * session starts a NEW row with its own clock, which is what a new decision
 * deserves.
 */
export async function clearAbandonedCart(sessionId: string): Promise<void> {
  if (!sessionId) return;
  const { error } = await supabaseAdmin
    .from("abandoned_carts")
    .update({ status: "cleared", last_updated_at: new Date().toISOString() })
    .eq("session_id", sessionId)
    .eq("status", "active");
  if (error) throw error;
}

export interface AbandonedCartSnapshot {
  id: string;
  items: AbandonedCartItemSnapshot[];
  email: string;
  customerName: string | null;
  /** active | recovered | cleared — the restore link arms a code only while active. */
  status: string;
  /** The browser session that built the cart; a restore elsewhere continues it. */
  sessionId: string | null;
}

// The cart id (a gen_random_uuid()) doubles as the restore token - it's
// already cryptographically random (122 bits) and never sequential, so a
// separate signed token isn't needed to keep it unguessable.
export async function getAbandonedCartById(id: string): Promise<AbandonedCartSnapshot | null> {
  const { data, error } = await supabaseAdmin
    .from("abandoned_carts")
    .select("id, items, email, customer_name, status, session_id")
    .eq("id", id)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;

  return {
    id: String(data.id),
    items: Array.isArray(data.items) ? (data.items as AbandonedCartItemSnapshot[]) : [],
    email: String(data.email),
    customerName: data.customer_name ? String(data.customer_name) : null,
    status: String(data.status ?? "active"),
    sessionId: data.session_id ? String(data.session_id) : null,
  };
}

/**
 * Note that a recovery link actually worked.
 *
 * THE MISSING MIDDLE OF THE FUNNEL. The programme could see a click and it
 * could see an order, and between them nothing at all — so "the click produced
 * a cart the shopper could buy" was an assumption rather than a measurement,
 * and it was a wrong one for every cart holding a dead slug.
 *
 * FIRST TOUCH ONLY, conditioned on the column still being null, so the
 * timestamp answers "when did this link first work" rather than "when was it
 * last used". That also makes it idempotent, which matters because a shopper
 * who reloads the restore page hits this again.
 *
 * Never throws. It is bookkeeping on the path a customer is walking down, and
 * a failed stamp must not cost them their cart.
 */
export async function markCartRestored(cartId: string): Promise<void> {
  try {
    await supabaseAdmin
      .from("abandoned_carts")
      .update({ restored_at: new Date().toISOString() })
      .eq("id", cartId)
      .is("restored_at", null);
  } catch (error) {
    console.error("[cart-recovery] could not stamp a restore", cartId, error);
  }
}

// Called from payment-webhook.ts's paid-status transition - stops every
// future reminder immediately, since the sweep only ever looks at
// status='active' rows.
//
// ONLY A PRODUCT PURCHASE RECOVERS A PRODUCT CART (EMAIL-03). The webhook
// called this for every paid order, so a member's monthly renewal landing
// inside the 96-hour window silently ended the sequence for the product cart
// they had abandoned, pointed recovered_order_id at a membership order, and
// counted a recovery on the dashboard. Callers that know the order pass it;
// an order that is not a purchase of product leaves the cart exactly as it was.
export async function markAbandonedCartsRecovered(
  email: string,
  orderId: string,
  order?: { order_type?: string | null; replacement_of?: string | null },
) {
  if (order && !isProductPurchaseOrder(order)) return;
  const { error } = await supabaseAdmin
    .from("abandoned_carts")
    .update({ status: "recovered", recovered_order_id: orderId })
    .eq("email", email.trim().toLowerCase())
    .eq("status", "active");

  if (error) throw error;
}

function generateCouponCode(): string {
  return `SAVE-${crypto.randomBytes(5).toString("hex").toUpperCase()}`;
}

/**
 * A minted (or re-offered) cart-recovery discount.
 *
 * `id` is nullable: the insert reads the row back with `maybeSingle()`, which
 * returns null rather than throwing when PostgREST returns no representation.
 * A coupon whose id could not be read is still a valid, mailable code — it just
 * cannot be re-offered by a later stage.
 */
export interface RecoveryCoupon {
  id: string | null;
  code: string;
  expiresAt: string;
  /** The percentage the coupon row actually carries — never the current setting. */
  percent: number;
  /** The address the code is bound to (coupons.assigned_email). */
  email: string | null;
}

export async function mintCartRecoveryCoupon(email: string, discountPercent: number, expiresInHours: number): Promise<RecoveryCoupon | null> {
  const code = generateCouponCode();
  const expiresAt = new Date(Date.now() + expiresInHours * HOUR_MS).toISOString();

  const { data: insertedCoupon, error } = await supabaseAdmin.from("coupons").insert({
    code,
    discount_type: "percent",
    discount_value: discountPercent,
    ends_at: expiresAt,
    max_redemptions: 1,
    redemptions_count: 0,
    active: true,
    assigned_email: email.trim().toLowerCase(),
    source: "cart_recovery",
    created_at: new Date().toISOString(),
  }).select("id").maybeSingle();

  if (error) {
    console.error("Unable to mint cart recovery coupon:", error);
    return null;
  }

  // The id is carried onto the stage reservation (abandoned_cart_emails.coupon_id)
  // so a later stage can re-offer the SAME code instead of minting another one,
  // and so the t72h stage can load THIS coupon rather than describing one from
  // memory (see resolveLastChanceCoupon).
  return { id: (insertedCoupon as { id?: string } | null)?.id ?? null, code, expiresAt, percent: discountPercent, email: email.trim().toLowerCase() };
}

/**
 * The coupon the LAST-CHANCE email may advertise.
 *
 * K-05. The t72h stage is right not to mint a second code for a cart — one cart,
 * one code. It was wrong about what to do instead: it invented
 * `{ code: "SEE PREVIOUS EMAIL", expiresAt: now + couponExpirationHours }`, so
 * the customer was shown a literal placeholder where a code belongs and an
 * expiry no row in the database held.
 *
 * Under the shipped defaults that expiry was not merely unverified, it was
 * false by 48 hours: the t24h and t72h stages are 48h apart on the fixed
 * every-30-minute cron, and couponExpirationHours defaults to 48, so the t24h
 * coupon dies on the very tick that sends this mail.
 *
 * So: load the real coupon this cart was given, and use it ONLY if it is still
 * live. If it has expired, or cannot be found (a row written before coupon_id
 * was recorded, or a coupon since deleted), mint a fresh one. The email then
 * always carries a code that `validateCoupon` will accept and a date the
 * database will honour — which is the only honest thing to put in it.
 *
 * Never describe a coupon that was not read back from the database.
 */
/**
 * The live coupon an EARLIER stage of this cart already minted, or null.
 *
 * Re-offering it is not a new discount — the shopper already holds it — so it
 * is offered regardless of the per-address cooldown that gates minting. Only a
 * code the checkout will still accept counts: same predicate validateCoupon
 * runs (active, and not past ends_at).
 */
export async function findLiveCouponForCart(cartId: string): Promise<RecoveryCoupon | null> {
  const { data: priorStages } = await supabaseAdmin
    .from("abandoned_cart_emails")
    .select("coupon_id")
    .eq("abandoned_cart_id", cartId);

  const priorCouponIds = ((priorStages ?? []) as Array<{ coupon_id?: string | null }>)
    .map((row) => row.coupon_id)
    .filter((id): id is string => Boolean(id));

  for (const priorCouponId of priorCouponIds) {
    const { data: existing } = await supabaseAdmin
      .from("coupons")
      .select("id, code, ends_at, active, discount_type, discount_value, assigned_email, redemptions_count, max_redemptions")
      .eq("id", priorCouponId)
      .maybeSingle();

    const row = existing as {
      id: string; code: string; ends_at: string | null; active: boolean;
      discount_type?: string | null; discount_value?: number | string | null;
      assigned_email?: string | null; redemptions_count?: number | null; max_redemptions?: number | null;
    } | null;
    // Live means the checkout will still honour it: active, unexpired, and
    // not already spent. A redeemed single-use code is still `active` in the
    // row; only its count says it is gone.
    const unspent = row ? row.max_redemptions === null || row.max_redemptions === undefined || Number(row.redemptions_count ?? 0) < Number(row.max_redemptions) : false;
    const stillLive = Boolean(row && row.active && unspent && row.ends_at && new Date(row.ends_at).getTime() > Date.now());
    if (stillLive && row) {
      // The percentage is READ BACK, not remembered: a code minted at 8% is
      // described as 8% even if the setting has since been changed to 5%.
      const percent = String(row.discount_type ?? "percent") === "percent" ? Math.max(0, Math.round(Number(row.discount_value ?? 0))) : 0;
      return { id: row.id, code: row.code, expiresAt: row.ends_at as string, percent, email: row.assigned_email ? String(row.assigned_email).trim().toLowerCase() : null };
    }
  }
  return null;
}

/**
 * The live recovery code a cart's OWN emails promised, for the restore link.
 *
 * Looked up by the cart id the link already carries — never a code taken from
 * the URL — and returned only while the coupon is live. It is bound to the
 * cart's address and single-use, and the checkout validates it again with the
 * address the shopper enters, so arming it here gives away nothing the email
 * had not already given: it only saves the shopper retyping it.
 */
export async function liveRecoveryCouponForCart(cartId: string): Promise<{
  code: string;
  discountType: "percent";
  discountValue: number;
  expiresAt: string;
  /** The address the code is bound to; the checkout will accept it for no other. */
  email: string;
} | null> {
  const coupon = await findLiveCouponForCart(cartId);
  if (!coupon || coupon.percent <= 0 || !coupon.email) return null;
  return { code: coupon.code, discountType: "percent", discountValue: coupon.percent, expiresAt: coupon.expiresAt, email: coupon.email };
}

/**
 * The coupon the LAST message may advertise: the cart's own live code if it
 * has one, otherwise a fresh mint.
 *
 * K-05 still holds: never describe a coupon that was not read back from the
 * database. A code this cart was given earlier is re-offered only while it is
 * live; expired, missing or never recorded means a fresh one.
 */
async function resolveLastChanceCoupon(
  cartId: string,
  email: string,
  discountPercent: number,
  expiresInHours: number,
): Promise<RecoveryCoupon | null> {
  return (await findLiveCouponForCart(cartId)) ?? mintCartRecoveryCoupon(email, discountPercent, expiresInHours);
}

interface DueCartRow {
  id: string;
  email: string;
  customer_name: string | null;
  items: AbandonedCartItemSnapshot[];
  cart_value_cents: number;
  first_seen_at: string;
  /** Last cart change. Absent on rows written before the column existed. */
  last_updated_at?: string | null;
}

function restoreUrl(cartId: string) {
  return `${getSiteUrl()}/cart/restore?id=${cartId}`;
}

/**
 * Claim a (cart, stage) slot, mint its coupon if it needs one, and send — in
 * that order, once, ever.
 *
 * THE ORDER IS THE FIX (finding C-06). Minting used to happen in the caller,
 * BEFORE the slot was claimed, and a failed send deleted the claim "so a later
 * sweep pass can retry". Those two together made the retry unbounded: every
 * failed send re-armed the stage and minted another live coupon, once per
 * 30-minute sweep for as long as the cart stayed in the 96-hour window. In
 * production that ran 2,994 times and left 335 coupons.
 *
 * Now the unique index on (abandoned_cart_id, stage) is claimed FIRST and the
 * mint happens behind it. A coupon cannot be minted for a stage that is already
 * claimed, so "at most one coupon per cart per stage" is a property of the
 * schema rather than of this function remembering to check.
 *
 * A FAILED SEND KEEPS ITS CLAIM. That costs a retry: a stage whose send fails is
 * not attempted again, and the shopper does not get that email. It is the
 * deliberate trade. An unbounded retry that re-mints is worse in every
 * direction — it spams the shopper if the failure was a false negative, and it
 * mints for ever for someone who has UNSUBSCRIBED.
 *
 * A FAILED MINT releases the claim, and that is safe for the opposite reason: no
 * coupon row exists, so a later pass cannot accumulate one. It is the only path
 * that still deletes a reservation.
 */
async function reserveAndSendStage(input: {
  cartId: string;
  stage: RecoveryStage;
  email: string;
  campaignType: string;
  templateKey: string;
  /** Stages that carry a discount supply this; it runs only once the slot is held. */
  mintCoupon?: () => Promise<RecoveryCoupon | null>;
  /**
   * False when the message is allowed to go out WITHOUT a coupon — the final
   * stage for a shopper the cooldown says not to pay, who may still hold a
   * live code from an earlier stage. Default true: a stage that promises a
   * code and cannot produce one releases its claim and waits.
   */
  couponRequired?: boolean;
  /**
   * Mint the entitlement this stage carries, BEHIND the claim, for the same
   * reason mintCoupon runs there (C-06): minting before the slot is held lets
   * a failing send re-mint once per sweep for as long as the window is open.
   * Returns the plaintext token, which exists only for the length of this
   * function and the email it renders — it is never stored or logged.
   *
   * A stage that names an offer and cannot mint one sends NOTHING and releases
   * its claim, so the next sweep retries. That is stricter than the coupon
   * path's `couponRequired: false` escape and deliberately has no escape: the
   * body of a gift email is about the gift, so sending it without one would
   * promise a customer something the till would refuse.
   */
  mintOffer?: () => Promise<string | null>;
  /**
   * An entitlement token the CALLER already minted, for a stage where the gift
   * is a bonus rather than the subject.
   *
   * `mintOffer` above is deliberately fatal — a gift email with no gift is a
   * promise the till would refuse. The last-chance message is not a gift email:
   * it stands on the code and the cart summary, and going silent because a vial
   * could not be attached would waste the only remaining chance to convert. So
   * that stage mints first, sends either way, and passes whatever it got here.
   */
  offerToken?: string | null;
  /** Called once the send has actually succeeded. Best-effort bookkeeping. */
  onSent?: (reservationId: string) => Promise<void>;
  buildTemplate: (
    restoreUrlForEmail: string,
    coupon: RecoveryCoupon | null,
  ) => { subject: string; html: string; text: string };
}): Promise<boolean> {
  // THE FREQUENCY GUARD COMES BEFORE THE STAGE CLAIM AND THE MINT. If another
  // marketing email reached this inbox inside the window the stage is simply
  // not attempted this sweep: nothing is reserved, no coupon exists, and the
  // next sweep tries again while the stage's window is open. Doing it in this
  // order is what keeps "at most one coupon per cart per stage" true — a
  // deferral after the mint would have to either burn the stage or re-mint.
  // A cart's own earlier reminders do not defer its later ones (see
  // quietFamilyFor); anybody else's mail does.
  const guard = await claimMarketingSend({
    email: input.email,
    campaignType: input.campaignType,
    referenceId: input.cartId,
    templateKey: input.templateKey,
  });
  if (guard.outcome === "deferred") {
    console.log("[cart-recovery] stage deferred by the frequency guard", input.cartId, input.stage, new Date(guard.retryAt).toISOString());
    return false;
  }
  if (guard.outcome === "duplicate" || guard.outcome === "refused") return false;
  const claimedLogId = guard.outcome === "claimed" ? guard.logId : null;
  if (guard.outcome === "unavailable") {
    console.error("[cart-recovery] frequency guard unavailable; sending without it", guard.error);
  }
  // A claim that ends up unused (the stage was already taken, the mint failed)
  // is closed 'failed' so it neither blocks this inbox nor reads as a send.
  const releaseClaim = async () => {
    if (!claimedLogId) return;
    try {
      await supabaseAdmin.from("email_send_log").update({ status: "failed" }).eq("id", claimedLogId);
    } catch {
      // Best-effort: a stranded claim ages out of the guard's window on its own.
    }
  };

  const { data: inserted, error: insertError } = await supabaseAdmin
    .from("abandoned_cart_emails")
    // THE VARIANT IS WRITTEN WITH THE CLAIM, not after the send. An experiment
    // whose assignment lives only in the process that chose it cannot be joined
    // to an outcome later, and a send that fails after the claim still consumed
    // an arm - so the arm has to be on the row either way.
    .insert({
      abandoned_cart_id: input.cartId,
      stage: input.stage,
      sent_at: new Date().toISOString(),
      coupon_id: null,
      variant: recoveryVariantFor(input.cartId),
    })
    .select("id")
    .single();

  if (insertError) {
    await releaseClaim();
    // 23505 — another sweep, or an earlier pass, already holds this stage.
    // Nothing to mint, nothing to send.
    if (insertError.code === "23505") {
      return false;
    }
    throw insertError;
  }

  const reservationId = inserted.id;

  let coupon: RecoveryCoupon | null = null;
  if (input.mintCoupon) {
    coupon = await input.mintCoupon();
    if (!coupon && input.couponRequired !== false) {
      // No coupon exists, so releasing the slot cannot accumulate one. Let a
      // later sweep try again rather than silently dropping the stage.
      await supabaseAdmin.from("abandoned_cart_emails").delete().eq("id", reservationId);
      await releaseClaim();
      return false;
    }
    // Link the claim to the coupon so a later stage re-offers this code.
    if (coupon) {
      await supabaseAdmin
        .from("abandoned_cart_emails")
        .update({ coupon_id: coupon.id })
        .eq("id", reservationId);
    }
  }

  // THE ENTITLEMENT IS MINTED BEHIND THE CLAIM, exactly like the coupon above,
  // and a stage that cannot mint one sends nothing at all.
  let offerToken: string | null = input.offerToken ?? null;
  if (input.mintOffer) {
    offerToken = await input.mintOffer();
    if (!offerToken) {
      // No token exists, so releasing the slot cannot accumulate one — the same
      // argument that makes a failed mint safe to retry for coupons.
      await supabaseAdmin.from("abandoned_cart_emails").delete().eq("id", reservationId);
      await releaseClaim();
      console.error("[cart-recovery] stage carries an offer that could not be minted; nothing sent", input.cartId, input.stage);
      return false;
    }
  }

  // The token rides in the tracking redirect's `o`, which sets it as an
  // httpOnly cookie and drops it — it never reaches the landing page's URL,
  // its Referer header, or any script on it. Same treatment, and the same
  // reasoning, as the retention automations' click route.
  const offerParam = offerToken ? `&o=${encodeURIComponent(offerToken)}` : "";
  const trackedRestoreUrl = `${getSiteUrl()}/api/email/track/click?id=${reservationId}&url=${encodeURIComponent(restoreUrl(input.cartId))}${offerParam}`;
  const openTrackingPixelUrl = `${getSiteUrl()}/api/email/track/open?id=${reservationId}`;

  const sendResult = await sendMarketingEmail({
    to: input.email,
    campaignType: input.campaignType,
    referenceId: input.cartId,
    templateKey: input.templateKey,
    openTrackingPixelUrl,
    // The guard's row already exists for this send; close it, don't claim twice.
    // And if the guard was unavailable just now, do not ask it a second time.
    claimedLogId,
    guardUnavailable: guard.outcome === "unavailable",
    ...input.buildTemplate(trackedRestoreUrl, coupon),
  });

  if (!sendResult.success) {
    // The claim STANDS. See the header: re-arming this stage is what produced
    // the coupon flood, and for a suppressed recipient it never terminates.
    console.error(
      "[cart-recovery] stage send failed; claim retained so it cannot re-mint",
      input.cartId,
      input.stage,
      sendResult.error,
    );
    return false;
  }

  if (input.onSent) await input.onSent(reservationId);

  return true;
}

export interface AbandonedCartSweepResult {
  t30mSent: number;
  t12hSent: number;
  t24hSent: number;
  t72hSent: number;
  /** Carts read while looking for work — the bound, made visible. */
  scanned: number;
  /** Carts that actually had an unsent stage due. */
  eligible: number;
  /** Carts closed because a paid order turned up that the webhook had not linked. */
  recoveredLate: number;
  /** New sequences not started because the address was mailed about another cart recently. */
  heldForCooldown: number;
}

export const RECOVERY_STAGES = ["t30m", "t12h", "t24h", "t72h"] as const;
export type RecoveryStage = (typeof RECOVERY_STAGES)[number];

/**
 * WHEN EACH STAGE IS DUE — AS A WINDOW, NOT A THRESHOLD.
 *
 * A stage used to be due the moment its delay had elapsed, for ever after. Two
 * production defects followed directly. A cart first processed at hour 25 had
 * three stages "due" and received all three in one sweep (cart c1bb28a8: t24h
 * and t12h in the same minute). And a stage switched on after the fact fired
 * for every old cart still in the window (cart e7a0adde: a t12h thirty-nine
 * days after its t72h).
 *
 * A window closes the moment the next stage opens. A stage whose window has
 * passed is simply skipped — the shopper gets the message that fits where they
 * are now, and never two at once. The keys keep their historic names because
 * they are stored in abandoned_cart_emails.stage and shown in the admin;
 * the numbers are what changed. Stage 1 opens at ONE hour, not thirty
 * minutes: a shopper still comparing products forty minutes in is not an
 * abandoner, and the clock runs from their LAST cart change (see elapsedFor).
 *
 * The sequence, with the shipped defaults (t12h off):
 *   1 h   reminder, no offer
 *   24 h  the things worth knowing before ordering — COA, shipping, support
 *   72 h  the last message about this cart, with the discount if allowed
 */
export const STAGE_WINDOWS: Record<RecoveryStage, { opensAfterMs: number; closesAfterMs: number }> = {
  t30m: { opensAfterMs: 60 * MINUTE_MS, closesAfterMs: 12 * HOUR_MS },
  t12h: { opensAfterMs: 12 * HOUR_MS, closesAfterMs: 24 * HOUR_MS },
  t24h: { opensAfterMs: 24 * HOUR_MS, closesAfterMs: 72 * HOUR_MS },
  t72h: { opensAfterMs: 72 * HOUR_MS, closesAfterMs: 96 * HOUR_MS },
};

const STAGE_ENABLED: Record<RecoveryStage, (config: CartRecoveryConfig) => boolean> = {
  t30m: (config) => config.t30mEnabled,
  t12h: (config) => config.t12hEnabled,
  t24h: (config) => config.t24hEnabled,
  t72h: (config) => config.t72hEnabled,
};

/**
 * ONE SEQUENCE PER ADDRESS PER WEEK.
 *
 * A shopper who abandons a cart on Monday, buys on Tuesday and abandons another
 * on Wednesday is a customer, not two abandoners. Starting a fresh three-message
 * sequence for every cart turned one July shopper's nine days into four
 * sequences and four discount codes. A sequence already under way for a cart
 * continues; a NEW one waits until a week has passed since the last recovery
 * message to that address.
 *
 * THE COOLDOWN HOLDS THE SEQUENCE, NOT THE CART. A new cart started inside the
 * week used to be skipped tick after tick until it had aged out of the sweep,
 * and was then never mailed at all. Now its clock simply starts when the week
 * is up: the first reminder goes an hour after that, and the rest follow in
 * their windows. See sequenceStartFor.
 */
export const RECOVERY_SEQUENCE_COOLDOWN_MS = 7 * 24 * HOUR_MS;

/**
 * WHEN THIS CART'S SEQUENCE CLOCK STARTED — for every stage, not only the
 * first. Pure. Null means the sequence is still waiting out the cooldown.
 *
 * A sequence not yet begun starts at the later of the shopper's last activity
 * and the end of the address's cooldown (sequenceStartFor). One already under
 * way must keep the SAME clock, or its later stages drift: with the raw
 * activity clock a cart that waited out a week would have its details message
 * due on the very next tick after its first reminder, or never. So the start
 * is re-derived from what is on record: the newest recovery send to another
 * cart that preceded this cart's first stage, plus the cooldown, if that is
 * what this cart waited for; the shopper's last activity otherwise.
 */
export function sequenceClockFor(input: {
  cartId: string;
  lastActivityAt: number;
  /** This cart's claimed stages and when each was sent. */
  claimed: ReadonlyMap<string, number>;
  /** Recovery sends to this address, any cart, within the lookback. */
  sends: ReadonlyArray<{ cartId: string; at: number }>;
  now: number;
}): number | null {
  const others = input.sends.filter((send) => send.cartId !== input.cartId && Number.isFinite(send.at));
  const newest = (list: Array<{ at: number }>) => list.reduce<number | null>((max, send) => (max === null || send.at > max ? send.at : max), null);
  if (input.claimed.size === 0) {
    return sequenceStartFor({ lastActivityAt: input.lastActivityAt, lastRecoverySendAt: newest(others), now: input.now });
  }
  const firstClaimAt = Math.min(...[...input.claimed.values()].filter(Number.isFinite));
  if (!Number.isFinite(firstClaimAt)) return input.lastActivityAt;
  const newestBefore = newest(others.filter((send) => send.at < firstClaimAt));
  if (newestBefore === null) return input.lastActivityAt;
  const cooldownEnds = newestBefore + RECOVERY_SEQUENCE_COOLDOWN_MS;
  // A first stage sent while that cooldown still ran was started under the
  // old rule (or by hand): it is on the activity clock, not a deferred one.
  return cooldownEnds <= firstClaimAt ? Math.max(input.lastActivityAt, cooldownEnds) : input.lastActivityAt;
}

/**
 * When a NEW sequence's clock starts for this cart: the shopper's last
 * activity, or the end of the address's cooldown if that is later. Pure.
 * Returns null while the cooldown is still running.
 */
export function sequenceStartFor(input: {
  lastActivityAt: number;
  /** The newest recovery send to this address about ANOTHER cart, if any. */
  lastRecoverySendAt: number | null;
  now: number;
}): number | null {
  if (input.lastRecoverySendAt === null) return input.lastActivityAt;
  const cooldownEnds = input.lastRecoverySendAt + RECOVERY_SEQUENCE_COOLDOWN_MS;
  if (cooldownEnds > input.now) return null;
  return Math.max(input.lastActivityAt, cooldownEnds);
}

/**
 * WHEN A DISCOUNT MAY BE OFFERED.
 *
 * The code is the most expensive thing in the sequence and the easiest to
 * teach people to wait for. So it appears on the final stage only, once per
 * address per thirty days, and never to someone who has bought in the last
 * thirty days — a customer inside their own reorder cycle does not need paying
 * to come back, and paying them anyway is margin given away to the people most
 * likely to have ordered regardless.
 */
export const RECOVERY_DISCOUNT_COOLDOWN_MS = 30 * 24 * HOUR_MS;
export const RECOVERY_DISCOUNT_RECENT_BUYER_MS = 30 * 24 * HOUR_MS;

export function recoveryDiscountAllowed(input: {
  lastRecoveryCouponAt: number | null;
  lastPaidAt: number | null;
  now: number;
}): boolean {
  if (input.lastRecoveryCouponAt !== null && input.now - input.lastRecoveryCouponAt < RECOVERY_DISCOUNT_COOLDOWN_MS) return false;
  if (input.lastPaidAt !== null && input.now - input.lastPaidAt < RECOVERY_DISCOUNT_RECENT_BUYER_MS) return false;
  return true;
}

/**
 * The single stage this cart should receive right now, or null.
 *
 * Pure, so the window rules can be asserted without a database: exactly one
 * window contains any given elapsed time, and a stage is due only if that
 * window is its own, the operator has it switched on, and it has not already
 * been claimed.
 */
export function selectDueStage(
  elapsedMs: number,
  config: CartRecoveryConfig,
  claimed: ReadonlySet<string>,
): RecoveryStage | null {
  for (const stage of RECOVERY_STAGES) {
    const window = STAGE_WINDOWS[stage];
    if (elapsedMs < window.opensAfterMs || elapsedMs >= window.closesAfterMs) continue;
    if (!STAGE_ENABLED[stage](config)) return null;
    if (claimed.has(stage)) return null;
    return stage;
  }
  return null;
}

/** When the shopper last touched the cart, falling back to first sight for old rows. */
function lastActivityFor(row: DueCartRow): number {
  const last = row.last_updated_at ? new Date(row.last_updated_at).getTime() : NaN;
  const first = new Date(row.first_seen_at).getTime();
  return Number.isFinite(last) ? Math.max(last, Number.isFinite(first) ? first : last) : first;
}

/** Time since the shopper last touched the cart. */
function elapsedFor(row: DueCartRow, now: number): number {
  return now - lastActivityFor(row);
}

/**
 * HOW MUCH RECOVERY ONE TICK MAY DO.
 *
 * The sweep used to read every active cart in the 96-hour window and then await
 * per cart — a suppression check, and an insert for each of the four stages
 * whether or not that stage could still fire. On a 60-second function the cost
 * per tick therefore grew with the number of shoppers, and past some traffic
 * level the sweep simply stopped finishing.
 *
 * A bare `.limit()` would have been actively harmful here: the oldest carts sort
 * first and have already had every stage claimed, so the budget would have been
 * spent proving that, tick after tick, while newer carts — the ones with a
 * first email actually due — were never reached. So the stage claims are read in
 * bulk first and carts with nothing outstanding are dropped for free; the
 * budget is spent only on carts that have an unsent stage due right now. That
 * drains, because sending a stage removes it from the outstanding set for good.
 */
const CART_SWEEP_BUDGET = 200;
const CART_SCAN_PAGE = 500;
const CART_MAX_SCAN = 5000;

/** Which (cart, stage) slots are already claimed, and when, for a page of carts. */
async function claimedStagesFor(cartIds: string[]): Promise<Map<string, Map<string, number>>> {
  const claimed = new Map<string, Map<string, number>>();
  if (cartIds.length === 0) return claimed;
  const { data, error } = await supabaseAdmin
    .from("abandoned_cart_emails")
    .select("abandoned_cart_id, stage, sent_at")
    .in("abandoned_cart_id", cartIds);

  // Fail OPEN: an unreadable claim table means we cannot subtract anything, so
  // every cart stays a candidate and the unique index does the deduplication as
  // it always did. Slower for a tick, never a wrong send.
  if (error || !data) return claimed;
  for (const row of data) {
    const id = String(row.abandoned_cart_id);
    const stages = claimed.get(id) ?? new Map<string, number>();
    stages.set(String(row.stage), new Date(String(row.sent_at ?? "")).getTime());
    claimed.set(id, stages);
  }
  return claimed;
}

/**
 * What the sweep needs to know about an address before mailing it, read once
 * per tick for every candidate rather than once per cart.
 *
 * Every read here FAILS OPEN to "nothing known", deliberately and separately:
 * an orders table that cannot be read must not stop recovery mail (the payment
 * webhook's own mark still ends a sequence), and a coupon table that cannot be
 * read must not stop a stage. What it may cost is a discount offered one time
 * too many, which is the cheaper mistake.
 */
type RecoveryContext = {
  /** Paid orders per address, newest first. */
  paidOrders: Map<string, Array<{ orderId: string; at: number }>>;
  /** Every recovery-stage send per address across ALL carts, within the cooldown plus the last window. */
  recoverySends: Map<string, Array<{ at: number; cartId: string }>>;
  /** Newest cart-recovery coupon per address, within the discount cooldown. */
  lastRecoveryCouponAt: Map<string, number>;
  /**
   * Cart-recovery GIFTS issued per address inside the gift cooldown, each with
   * the cart it was issued for.
   *
   * THE CART ID IS WHY THIS IS A LIST RATHER THAN A TIMESTAMP. One sequence
   * issues the gift at stage 3 and re-issues the SAME entitlement at stage 4 —
   * issueCustomerOffer retires the older row so only the newest link works — and
   * that is one gift, not two. A flat "when did this address last get a gift"
   * would read stage 3's own row two days later and withhold stage 4's, which
   * is the opposite of what the cooldown is for. The rule is about a SECOND
   * sequence to the same address, so the cart has to be part of the answer.
   */
  recoveryGifts: Map<string, Array<{ at: number; cartId: string | null }>>;
};

/** PostgREST `in` filters ride in the URL; a page of addresses is read in slices. */
const CONTEXT_CHUNK = 100;

function mergeRecoveryContext(into: RecoveryContext, from: RecoveryContext): void {
  for (const [email, orders] of from.paidOrders) into.paidOrders.set(email, orders);
  for (const [email, sends] of from.recoverySends) into.recoverySends.set(email, sends);
  for (const [email, at] of from.lastRecoveryCouponAt) into.lastRecoveryCouponAt.set(email, at);
  for (const [email, gifts] of from.recoveryGifts) into.recoveryGifts.set(email, gifts);
}

async function loadRecoveryContext(emails: string[], now: number): Promise<RecoveryContext> {
  const context: RecoveryContext = { paidOrders: new Map(), recoverySends: new Map(), lastRecoveryCouponAt: new Map(), recoveryGifts: new Map() };
  if (emails.length === 0) return context;
  if (emails.length > CONTEXT_CHUNK) {
    for (let i = 0; i < emails.length; i += CONTEXT_CHUNK) {
      mergeRecoveryContext(context, await loadRecoveryContext(emails.slice(i, i + CONTEXT_CHUNK), now));
    }
    return context;
  }

  try {
    const { data } = await supabaseAdmin
      .from("orders")
      .select("order_id, customer_email, payment_status, created_at, order_type")
      .in("customer_email", emails);
    for (const row of (data ?? []) as Array<Record<string, unknown>>) {
      if (!isPaidOrderStatus(row.payment_status as string | null)) continue;
      // Same rule as the webhook mark above: a membership charge or a reship is
      // not "they already bought", and it does not make them a recent buyer for
      // the discount rule either.
      if (!isProductPurchaseOrder(row as { order_type?: string | null })) continue;
      const email = String(row.customer_email ?? "").trim().toLowerCase();
      const at = new Date(String(row.created_at)).getTime();
      if (!email || !Number.isFinite(at)) continue;
      const list = context.paidOrders.get(email) ?? [];
      list.push({ orderId: String(row.order_id ?? ""), at });
      context.paidOrders.set(email, list);
    }
    for (const list of context.paidOrders.values()) list.sort((a, b) => b.at - a.at);
  } catch (error) {
    console.error("[cart-recovery] could not read orders for the sweep; relying on the webhook mark", error);
  }

  try {
    const { data: carts } = await supabaseAdmin
      .from("abandoned_carts")
      .select("id, email")
      .in("email", emails);
    const emailByCart = new Map<string, string>();
    for (const row of (carts ?? []) as Array<Record<string, unknown>>) {
      emailByCart.set(String(row.id), String(row.email ?? "").trim().toLowerCase());
    }
    if (emailByCart.size > 0) {
      // Far enough back to place a sequence whose cooldown ended up to four
      // days ago: the last send that started the week is what its clock runs
      // from (sequenceStartFor), so it must still be visible then.
      const { data: stages } = await supabaseAdmin
        .from("abandoned_cart_emails")
        .select("abandoned_cart_id, sent_at")
        .in("abandoned_cart_id", [...emailByCart.keys()])
        .gte("sent_at", new Date(now - RECOVERY_SEQUENCE_COOLDOWN_MS - STAGE_WINDOWS.t72h.closesAfterMs).toISOString());
      for (const row of (stages ?? []) as Array<Record<string, unknown>>) {
        const cartId = String(row.abandoned_cart_id);
        const email = emailByCart.get(cartId);
        const at = new Date(String(row.sent_at)).getTime();
        if (!email || !Number.isFinite(at)) continue;
        const list = context.recoverySends.get(email) ?? [];
        list.push({ at, cartId });
        context.recoverySends.set(email, list);
      }
    }
  } catch (error) {
    console.error("[cart-recovery] could not read recent recovery sends; cooldown not applied this tick", error);
  }

  try {
    const { data } = await supabaseAdmin
      .from("coupons")
      .select("assigned_email, created_at")
      .eq("source", "cart_recovery")
      .in("assigned_email", emails)
      .gte("created_at", new Date(now - RECOVERY_DISCOUNT_COOLDOWN_MS).toISOString());
    for (const row of (data ?? []) as Array<Record<string, unknown>>) {
      const email = String(row.assigned_email ?? "").trim().toLowerCase();
      const at = new Date(String(row.created_at)).getTime();
      if (!email || !Number.isFinite(at)) continue;
      const existing = context.lastRecoveryCouponAt.get(email);
      if (existing === undefined || at > existing) context.lastRecoveryCouponAt.set(email, at);
    }
  } catch (error) {
    console.error("[cart-recovery] could not read recent recovery coupons; discount cooldown not applied this tick", error);
  }

  try {
    const { data } = await supabaseAdmin
      .from("customer_offers")
      .select("email, issued_at, reference_id")
      .eq("offer_key", RECOVERY_GIFT_OFFER_KEY)
      .in("email", emails)
      .gte("issued_at", new Date(now - RECOVERY_GIFT_COOLDOWN_MS).toISOString());
    for (const row of (data ?? []) as Array<Record<string, unknown>>) {
      const email = String(row.email ?? "").trim().toLowerCase();
      const at = new Date(String(row.issued_at)).getTime();
      if (!email || !Number.isFinite(at)) continue;
      const list = context.recoveryGifts.get(email) ?? [];
      list.push({ at, cartId: row.reference_id ? String(row.reference_id) : null });
      context.recoveryGifts.set(email, list);
    }
  } catch (error) {
    // FAILS OPEN like every other read here: an unreadable offers table must
    // not stop recovery mail. What it can cost is one gift too many, which is
    // the cheaper mistake — the same trade the coupon cooldown above makes.
    console.error("[cart-recovery] could not read recent recovery gifts; gift cooldown not applied this tick", error);
  }

  return context;
}

/**
 * When this ADDRESS was last gifted for some OTHER cart.
 *
 * A gift issued for this same cart is this sequence's own stage 3, re-minted
 * at stage 4; it is not a second gift and must not block one.
 */
function lastGiftForOtherCarts(
  gifts: ReadonlyArray<{ at: number; cartId: string | null }> | undefined,
  cartId: string,
): number | null {
  let last: number | null = null;
  for (const gift of gifts ?? []) {
    if (gift.cartId === cartId) continue;
    if (last === null || gift.at > last) last = gift.at;
  }
  return last;
}

/** Close a cart the payment webhook missed, so the sweep stops looking at it. */
async function markRecoveredLate(cartId: string, orderId: string): Promise<void> {
  try {
    await supabaseAdmin
      .from("abandoned_carts")
      .update({ status: "recovered", recovered_order_id: orderId || null })
      .eq("id", cartId);
  } catch (error) {
    console.error("[cart-recovery] could not mark a late recovery", cartId, error);
  }
}

const STAGE_RESULT_KEY: Record<RecoveryStage, keyof Pick<AbandonedCartSweepResult, "t30mSent" | "t12hSent" | "t24hSent" | "t72hSent">> = {
  t30m: "t30mSent", t12h: "t12hSent", t24h: "t24hSent", t72h: "t72hSent",
};

// Idempotent - each stage reserves its slot in abandoned_cart_emails via a
// unique index before sending (see reserveAndSendStage), so a coarser cron
// interval just means coarser timing on when a stage fires, never a
// duplicate send. At most ONE stage per cart per sweep, by construction of
// selectDueStage.
/** The most units one line of a recovery email will claim, whatever was stored. */
const MAX_RECOVERY_LINE_QUANTITY = 99;

/**
 * What the CATALOGUE says about a slug the cart holds.
 *
 * Everything a recovery email renders about a product comes from here, so that
 * the beacon's stored snapshot decides only WHICH products are shown and never
 * how they are described or priced.
 */
export interface RecoveryCatalogueEntry {
  name: string;
  unitPriceCents: number;
  image?: string;
  batchNumber?: string;
  /**
   * THE DOSES, BECAUSE A PRODUCT DOES NOT HAVE ONE PRICE.
   *
   * This entry used to carry only the product's headline figure, and the cart
   * lines it priced carry a `variantId` — the dose the shopper actually chose.
   * GLP-3 sells at $49.99 for its base dose and $169.99 for the one in a real
   * abandoned cart here, so the email quoted a third of what that shopper had
   * in front of them, and the cart total under it was wrong by the same amount.
   *
   * It got worse once the offer ladder read cart value: a $524.96 basket priced
   * at $164.96 falls two bands, so the largest carts in the store — the ones
   * the top band exists for — would have been offered the small-cart gift.
   *
   * Keyed by dose id, which is exactly what the snapshot stores.
   */
  variantPriceCents?: Map<string, number>;
  variantLabel?: Map<string, string>;
}

/** What a recovery email renders per line — and nothing the client typed. */
export interface RecoveryEmailItem {
  name: string;
  quantity: number;
  /**
   * From the catalogue, so the email prices what the till will price. Optional
   * because a product row with no usable price still has a name worth showing:
   * a line rendered without a figure is a smaller loss than a line dropped, and
   * far smaller than a wrong figure.
   */
  unitPriceCents?: number;
  /** Absolute URL. A relative src resolves against the mail client and fails. */
  image?: string;
}

/**
 * The lines a recovery email may show, rendered FROM THE CATALOGUE.
 *
 * The guest tracking beacon stores whatever the browser posted: a `name`, an
 * `image`, a price, per line, verbatim. Rendering those back out meant an
 * anonymous POST to /api/cart/track could have any text — "Your account is
 * locked, call +1 555 0100" — delivered as a genuine, branded, four-message
 * series to any address it named, from the store's own domain. The catalogue
 * is the only source of a product name this email will print: a line whose
 * slug is not a live product is dropped, and the name is the product's own.
 * Quantity is kept, as a bounded integer, because it is the one thing about
 * the line that is genuinely the shopper's.
 *
 * Pure, so the rule is pinned without a database.
 */
export function recoveryEmailItems(
  items: ReadonlyArray<Partial<AbandonedCartItemSnapshot>>,
  catalogue: ReadonlyMap<string, RecoveryCatalogueEntry>,
): RecoveryEmailItem[] {
  const out: RecoveryEmailItem[] = [];
  for (const item of items) {
    const slug = String(item?.slug ?? "").trim();
    const entry = slug ? catalogue.get(slug) : undefined;
    if (!entry?.name) continue;
    const quantity = Math.floor(Number(item?.quantity ?? 0));
    if (!Number.isFinite(quantity) || quantity < 1) continue;

    // THE DOSE THE SHOPPER CHOSE, NOT THE ONE THE PRODUCT LEADS WITH.
    //
    // A line carrying a variantId is a specific dose, and doses differ in price
    // by more than 3x on this catalogue. Priced by product alone, a real cart
    // holding three GLP-3 at $169.99 was described at $49.99 each — a third of
    // what the shopper was actually looking at, on the email asking them to
    // come back and pay it.
    //
    // AN UNRESOLVABLE VARIANT LEAVES THE LINE UNPRICED, and that is the safe
    // direction on purpose: reconciledCartValueCents falls back to the stored
    // figure the moment any line is unpriced, so a dose this code cannot find
    // can never quietly shrink a cart into a smaller offer band. A missing
    // price loses a number on one line; a wrong one loses the sale.
    const variantId = String(item?.variantId ?? "").trim();
    const variantPrice = variantId ? entry.variantPriceCents?.get(variantId) : undefined;
    const unitPriceCents = variantId ? Number(variantPrice) : Number(entry.unitPriceCents);
    // The dose label qualifies the name for the same reason: "GLP-3" and
    // "GLP-3 10mg" are different lines to whoever is reading the summary.
    //
    // ONLY WHEN THE NAME CARRIES NO DOSE OF ITS OWN. A product named after one
    // of its doses — "BPC-157 10mg", whose slug is bpc-157-10mg, selling a 5mg
    // as well — produced "BPC-157 10mg 5mg" when the label was simply appended.
    // Two contradictory strengths on one line is worse than none, so the test
    // is for ANY dose token in the name, not just this dose's.
    const variantLabel = variantId ? entry.variantLabel?.get(variantId) : undefined;
    const nameCarriesADose = /\d\s*(mg|mcg|ml|iu|g)\b/i.test(entry.name);
    const name = variantLabel && !nameCarriesADose ? `${entry.name} ${variantLabel}` : entry.name;
    out.push({
      name,
      quantity: Math.min(MAX_RECOVERY_LINE_QUANTITY, quantity),
      ...(Number.isFinite(unitPriceCents) && unitPriceCents > 0 ? { unitPriceCents } : {}),
      ...(entry.image ? { image: entry.image } : {}),
    });
  }
  return out;
}

/**
 * WHAT THIS CART IS WORTH, judged on the lines the email will actually print.
 *
 * `cart_value_cents` is a SNAPSHOT taken when the beacon was posted. The lines
 * are not: recoveryEmailItems reconciles them against the live catalogue,
 * dropping a slug that no longer sells and re-pricing the rest, so the two
 * disagree the moment a product is retired or repriced. Using the snapshot
 * regardless cost money in both directions:
 *
 *   THE EMAIL. A cart stored at $519.90 whose live lines came to $95.98 was
 *   mailed with "Cart total $519.90" printed under a summary that added up to
 *   $95.98. The shopper clicks, sees the real basket, and the message has been
 *   wrong about the one number they can check for themselves.
 *
 *   THE OFFER. The band is chosen from cart value, so that same cart drew the
 *   TOP band — three free products — on $95.98 of goods, redeemable against a
 *   $35 minimum. The ladder is generous at the top precisely BECAUSE the basket
 *   is large; paying out on a stale figure hands that away to carts that never
 *   qualified for it.
 *
 * THE SUM IS ONLY TRUSTED WHEN EVERY SURVIVING LINE CARRIES A LIVE PRICE.
 * recoveryEmailItems omits the price rather than printing a wrong one, so a
 * partial sum would understate the cart and quietly demote a real one; in that
 * case the stored figure stands and behaviour is exactly as it was.
 *
 * An empty basket returns the stored value too — the sweep drops those carts
 * before this point, and returning 0 would only mislabel one if it ever did not.
 */
export function reconciledCartValueCents(
  items: ReadonlyArray<RecoveryEmailItem>,
  storedCents: number,
): number {
  const stored = Number.isFinite(storedCents) ? Math.max(0, Math.round(storedCents)) : 0;
  if (items.length === 0) return stored;
  if (!items.every((item) => typeof item.unitPriceCents === "number")) return stored;
  return items.reduce((sum, item) => sum + (item.unitPriceCents ?? 0) * item.quantity, 0);
}

/**
 * Everything the emails need about these slugs, in one catalogue read.
 *
 * Throws on a read failure, deliberately: the sweep catches it and sends
 * nothing that tick rather than mailing a cart it cannot describe. No stage
 * has been claimed at that point, so the next tick simply tries again.
 *
 * IMAGES ARE ABSOLUTISED HERE. The catalogue stores site-relative paths, and a
 * relative src in an email resolves against the mail client rather than the
 * site, so it renders as a broken image in every inbox.
 */
/** Where a shopper replies. Rendered as a mailto, so it must stay a real inbox. */
const SUPPORT_EMAIL = "support@vantalabsresearch.com";

/**
 * The slug of the highest-value line in a cart, for the one product the proof
 * message names. Highest value rather than first, so the batch number shown is
 * for the thing the shopper actually wants.
 */
function leadSlugFor(
  row: DueCartRow,
  catalogue: ReadonlyMap<string, RecoveryCatalogueEntry>,
): string {
  let best = "";
  let bestValue = -1;
  for (const item of Array.isArray(row.items) ? row.items : []) {
    const slug = String(item?.slug ?? "").trim();
    const entry = slug ? catalogue.get(slug) : undefined;
    if (!entry) continue;
    const quantity = Math.max(1, Math.floor(Number(item?.quantity ?? 1)) || 1);
    const value = (Number(entry.unitPriceCents) || 0) * quantity;
    if (value > bestValue) { bestValue = value; best = slug; }
  }
  return best;
}

export async function loadRecoveryCatalogue(slugs: string[]): Promise<Map<string, RecoveryCatalogueEntry>> {
  const unique = [...new Set(slugs.map((slug) => String(slug ?? "").trim()).filter(Boolean))];
  const entries = new Map<string, RecoveryCatalogueEntry>();
  if (unique.length === 0) return entries;
  const site = getSiteUrl();
  for (const product of await getCatalogProductsBySlugs(unique)) {
    if (!product?.slug || !product.name) continue;
    const price = Number(String(product.salePrice ?? product.price ?? "").replace(/[^0-9.]/g, ""));
    const rawImage = product.image ? String(product.image) : "";
    const image = rawImage.startsWith("http")
      ? rawImage
      : rawImage.startsWith("/") ? `${site}${rawImage}` : "";
    // Every dose, keyed by the id the cart snapshot stores, so a line naming a
    // variant is priced at that variant. Sale price first, exactly as the
    // product-level figure above resolves it.
    const variantPriceCents = new Map<string, number>();
    const variantLabel = new Map<string, string>();
    for (const dose of product.doses ?? []) {
      if (!dose?.id) continue;
      const dosePrice = Number(String(dose.salePrice ?? dose.price ?? "").replace(/[^0-9.]/g, ""));
      if (Number.isFinite(dosePrice) && dosePrice > 0) variantPriceCents.set(String(dose.id), Math.round(dosePrice * 100));
      if (dose.label) variantLabel.set(String(dose.id), String(dose.label));
    }
    entries.set(String(product.slug), {
      name: String(product.name),
      unitPriceCents: Number.isFinite(price) ? Math.round(price * 100) : 0,
      ...(image ? { image } : {}),
      ...(product.batchNumber ? { batchNumber: String(product.batchNumber) } : {}),
      ...(variantPriceCents.size > 0 ? { variantPriceCents } : {}),
      ...(variantLabel.size > 0 ? { variantLabel } : {}),
    });
  }
  return entries;
}

export async function runAbandonedCartSweep(): Promise<AbandonedCartSweepResult> {
  const config = await getCartRecoveryControlConfig();
  const now = Date.now();
  const result: AbandonedCartSweepResult = {
    t30mSent: 0, t12hSent: 0, t24hSent: 0, t72hSent: 0, scanned: 0, eligible: 0, recoveredLate: 0, heldForCooldown: 0,
  };

  // Only sweep carts new enough to still have a pending stage. The stage clock
  // runs from the shopper's LAST activity (elapsedFor), so the age-out must
  // too: bounding the scan by first_seen_at dropped a cart edited on day two
  // before its 72-hour message — the one with the discount — could ever go.
  // A new sequence may also be waiting out the address's week-long cooldown
  // (sequenceClockFor), so a cart is scanned for the cooldown plus the last
  // window. A cart with nothing due is dropped here and never costs a
  // candidate slot: the budget is spent only on carts with a stage to send.
  const RECOVERY_MAX_AGE_MS = STAGE_WINDOWS.t72h.closesAfterMs;
  const oldestActivityIso = new Date(now - RECOVERY_MAX_AGE_MS - RECOVERY_SEQUENCE_COOLDOWN_MS).toISOString();

  const context: RecoveryContext = { paidOrders: new Map(), recoverySends: new Map(), lastRecoveryCouponAt: new Map(), recoveryGifts: new Map() };
  const candidates: Array<{ row: DueCartRow; stage: RecoveryStage; claimed: Set<string> }> = [];
  for (let offset = 0; offset < CART_MAX_SCAN && candidates.length < CART_SWEEP_BUDGET; offset += CART_SCAN_PAGE) {
    const { data, error } = await supabaseAdmin
      .from("abandoned_carts")
      .select("id, email, customer_name, items, cart_value_cents, first_seen_at, last_updated_at")
      .eq("status", "active")
      .or(`last_updated_at.gte.${oldestActivityIso},first_seen_at.gte.${oldestActivityIso}`)
      // Oldest first: the cart closest to ageing out of the window is the one
      // with the least time left to be recovered.
      .order("first_seen_at", { ascending: true })
      .range(offset, offset + CART_SCAN_PAGE - 1);

    if (error) throw error;

    const page = (data ?? []) as unknown as DueCartRow[];
    if (page.length === 0) break;
    result.scanned += page.length;

    const claimedByCart = await claimedStagesFor(page.map((row) => String(row.id)));
    // What this page's addresses bought, what recovery mail they were sent and
    // which codes they were given — read per page, so the clock below can be
    // placed for every cart, and bounded by the page so the cost stays flat.
    mergeRecoveryContext(context, await loadRecoveryContext(
      [...new Set(page.map((row) => String(row.email ?? "").trim().toLowerCase()).filter(Boolean))],
      now,
    ));

    for (const row of page) {
      const items = Array.isArray(row.items) ? row.items : [];
      if (items.length === 0) continue;
      const email = String(row.email ?? "").trim().toLowerCase();
      if (!email) continue;
      const claimed = claimedByCart.get(String(row.id)) ?? new Map<string, number>();

      // THEY ALREADY BOUGHT — checked before anything else, so a cart the
      // shopper has paid for is closed rather than counted as held or due. The
      // payment webhook marks carts recovered by email and is the primary
      // exit; this is the second line for a mark that did not land.
      const firstSeenAt = new Date(row.first_seen_at).getTime();
      const paidSince = (context.paidOrders.get(email) ?? []).find((order) => order.at >= firstSeenAt);
      if (paidSince) {
        await markRecoveredLate(String(row.id), paidSince.orderId);
        result.recoveredLate++;
        continue;
      }

      const clock = sequenceClockFor({
        cartId: String(row.id),
        lastActivityAt: lastActivityFor(row),
        claimed,
        sends: context.recoverySends.get(email) ?? [],
        now,
      });
      if (clock === null) {
        result.heldForCooldown++;
        continue;
      }
      const claimedStages = new Set(claimed.keys());
      const stage = selectDueStage(now - clock, config, claimedStages);
      if (!stage) continue;
      candidates.push({ row, stage, claimed: claimedStages });
      if (candidates.length >= CART_SWEEP_BUDGET) break;
    }

    if (page.length < CART_SCAN_PAGE) break;
  }

  result.eligible = candidates.length;
  if (candidates.length === 0) return result;

  // Product names come from the catalogue, never from the stored snapshot —
  // see recoveryEmailItems. One read for every candidate's lines. If the
  // catalogue cannot be read nothing is sent this sweep: no stage has been
  // claimed yet, so the next tick simply tries again.
  // THE BANDS, DEFENDED. `config.tiers` is validated on the way out of the
  // control store, but a config assembled by an older deploy — or by a caller
  // that predates the field — has none, and a sweep that throws here sends no
  // recovery mail at all. Falling back to the shipped ladder keeps the
  // programme running on the defaults it was designed with.
  const recoveryTiers = config.tiers ?? DEFAULT_RECOVERY_TIERS;

  let catalogueNames: Map<string, RecoveryCatalogueEntry>;
  try {
    catalogueNames = await loadRecoveryCatalogue([
      ...candidates.flatMap(({ row }) => (Array.isArray(row.items) ? row.items : []).map((item) => String(item?.slug ?? ""))),
      // THE GIFT PRODUCTS TOO, or a banded gift could not be named. Every band
      // is known before the sweep runs, so this costs one wider read rather
      // than a lookup per cart — and a gift the sweep cannot name is a gift the
      // email would advertise as a slug.
      ...recoveryTiers.flatMap((tier) => [
        ...tier.stage3.map((item) => item.slug),
        ...tier.stage4.gifts.map((item) => item.slug),
      ]),
    ]);
  } catch (error) {
    console.error("[cart-recovery] catalogue unavailable; no recovery mail sent this sweep", error);
    return result;
  }

  // Slug to product name, for naming a banded gift in the email and on the
  // offer row. Derived rather than loaded again: the read above already covers
  // both the cart's products and every band's.
  const catalogueNameBySlug = new Map<string, string>(
    [...catalogueNames.entries()].map(([slug, entry]) => [slug, entry.name]),
  );

  // WHICH GIFT PRODUCTS CAN ACTUALLY SHIP TODAY.
  //
  // quoteOrder already skips an unshippable gift item at the till, and the rest
  // of a multi-item gift still lands — but that is the WRONG PLACE for this to
  // be the only check. The email is written first: without this, a band naming
  // an out-of-stock product mails "TB-500 + GHK-Cu + Recon Water" and the
  // checkout hands over two of the three. Promising what cannot ship is the one
  // failure this whole programme is least able to afford, because the customer
  // reads the promise and then counts the box.
  //
  // Found by sending a real top-band cart through the sweep against a harness
  // where TB-500 was out of stock, and comparing the email against the quote.
  //
  // Unknown is treated as SHIPPABLE: an untracked supply has no count, and
  // withholding a gift because a stock read was silent would quietly empty the
  // ladder. quoteOrder and reserve_inventory both still guard the real order.
  //
  // THE CATALOGUE STATUS ALONE IS NOT ENOUGH, and the first version of this
  // check believed it was. resolveStockStatus() in catalog.ts returns "In Stock"
  // for EVERY product while the global inventory-tracking flag is off — which is
  // its default — so a shelf holding zero units still reads In Stock there. The
  // count from getStockLevelsBySlugs() is not masked that way: it carries the
  // per-row tracked quantity regardless of the flag, which is exactly why
  // quoteOrder tests both. Testing both here too is what makes the email and the
  // till agree; testing only the status mailed a three-gift promise that the
  // quote then honoured two thirds of.
  const giftSlugs = Array.from(new Set(recoveryTiers.flatMap((tier) => [
    ...tier.stage3.map((item) => item.slug),
    ...tier.stage4.gifts.map((item) => item.slug),
  ])));
  const unshippableGiftSlugs = new Set<string>();
  if (giftSlugs.length > 0) {
    try {
      const [giftProducts, giftStock] = await Promise.all([
        getCatalogProductsBySlugs(giftSlugs),
        getStockLevelsBySlugs(giftSlugs),
      ]);
      for (const slug of giftSlugs) {
        const product = giftProducts.find((candidate) => candidate.slug === slug);
        // Absent from the catalogue is unshippable too — a retired or unpublished
        // slug resolves to nothing at the till and would be promised for ever.
        if (!product) { unshippableGiftSlugs.add(slug); continue; }
        // The same dose quoteOrder picks for a gift that names no variant, and
        // the same key order: dose id for a variant, slug for a product.
        const dose = product.doses?.find((entry) => entry.isDefault) ?? product.doses?.[0];
        const status = dose?.stockStatus ?? product.stockStatus;
        const count = dose ? giftStock.get(dose.id) : giftStock.get(slug);
        if (status === "Out of Stock" || status === "Reserved") unshippableGiftSlugs.add(slug);
        else if (typeof count === "number" && Number.isFinite(count) && count <= 0) unshippableGiftSlugs.add(slug);
      }
    } catch (error) {
      // A failed read leaves the set empty, so every gift is attempted and the
      // till decides. Better than silently mailing a ladder with no gifts.
      console.error("[cart-recovery] gift stock unreadable; offering every configured gift", error);
    }
  }
  /** Drop what cannot ship, so the email promises only what the box will hold. */
  const shippableGifts = (gifts: RecoveryGiftItem[]) =>
    gifts.filter((item) => !unshippableGiftSlugs.has(item.slug));

  // IS THE STORE SHIPPING EVERYTHING FREE RIGHT NOW? Read once for the sweep,
  // from the configuration the checkout prices through, so no message can state
  // a policy the till would then charge for. Unreadable means NOT CLAIMED.
  let freeShippingSitewide = false;
  try {
    freeShippingSitewide = isFreeShippingSitewide(await getShippingConfig());
  } catch {
    // A perk we cannot confirm is a perk we do not claim.
  }

  // One read for the whole sweep. A cart with no row here — which is every
  // cart, almost always — takes the ordinary path untouched.
  const overrides = await loadCartRecoveryOverrides(candidates.map(({ row }) => String(row.id)));

  for (const { row, stage } of candidates) {
    const items = recoveryEmailItems(Array.isArray(row.items) ? row.items : [], catalogueNames);
    // Nothing in this cart is a live product — a retired listing, or a beacon
    // that never named one. There is no honest email to build from it.
    if (items.length === 0) continue;
    const email = String(row.email ?? "").trim().toLowerCase();

    // UNSUBSCRIBED SHOPPERS ARE SKIPPED BEFORE ANYTHING IS WRITTEN.
    //
    // sendMarketingEmail already refuses to mail them, but it reports that
    // refusal as `{ success: false, suppressed: true }` — the same shape as a
    // provider outage. Cart recovery used to treat it as a retryable failure and
    // re-mint a coupon on every sweep, so one unsubscribe became a permanent
    // coupon-generation loop for someone who had explicitly opted out (C-06).
    //
    // Checking here, before the claim and before the mint, means a suppressed
    // shopper produces NO coupon, NO reservation row and NO send attempt at all.
    // It is re-checked each sweep rather than recorded, so re-subscribing
    // restores normal service by itself.
    if (await isMarketingSuppressed(email)) continue;

    // The greeting name is held to the shape of a name for the same reason
    // the line names come from the catalogue: it was typed by whoever posted
    // the beacon, and it is printed at the top of a branded email.
    const name = plainGreetingName(row.customer_name);
    const cartId = String(row.id);

    const reconciledCartCents = reconciledCartValueCents(items, Number(row.cart_value_cents ?? 0));
    const base = { name, items, cartValueCents: reconciledCartCents };
    let sent = false;

    // A NAMED CART'S STAGE CAN BE REPLACED, and that is all this does.
    //
    // It does not add a send, skip a stage, restart a sequence or change a
    // window: the branch below still goes through reserveAndSendStage, still
    // claims (cart, stage) before anything else, and still sends exactly once
    // behind that claim. Only the body and the entitlement differ. So every
    // property the ordinary sequence has — retry, concurrent sweep, redeploy,
    // conversion before the send, unsubscribe, the frequency guard — holds
    // here unchanged, because this IS the ordinary path.
    const override = overrides.get(`${cartId}::${stage}`);
    if (override) {
      const offerKey = override.offerKey;
      // A PROMOTION IS MENTIONED ONLY IF THE LIVE CONFIGURATION IS RUNNING ONE.
      //
      // getApplicableBxgyPromotions is the same resolver the checkout prices
      // through: switched on, inside its own schedule, and not used up for this
      // customer. So the sentence cannot outlive the promotion, and nothing
      // here invents a deadline, a discount or an urgency the store does not
      // already hold. No live promotion means the sentence is simply absent.
      // FREE SHIPPING IS STATED ONLY IF THE STORE IS ACTUALLY GIVING IT.
      // Read from the live shipping configuration, the same one the checkout
      // prices through, so the line cannot outlive the setting.
      //
      // DEDUPLICATED, because the operator can type the same perk the store
      // already adds. Four override rows waiting to send carry "Free shipping"
      // in their own perks list, and with the sitewide switch on this unshifted
      // a second one — so the highest-value cart in the store was about to be
      // mailed a bullet list that read "Free shipping / Free shipping / 2-day
      // shipping, on us". Case-insensitive and whitespace-insensitive, first
      // occurrence wins, so the operator's own wording is what survives.
      const overridePerks = resolveOverridePerks(override.perks, freeShippingSitewide);

      let livePromotionNote: string | null = null;
      try {
        const livePromotions = await getApplicableBxgyPromotions({ customerEmail: email });
        const headline = livePromotions.find((promotion) => !promotion.hidden) ?? livePromotions[0];
        if (headline) {
          // THE DEADLINE COMES OFF THE PROMOTION ROW, not out of the copy. So
          // "limited time" is only ever said when the store genuinely holds an
          // end date, and the date shown is the one the checkout stops honouring
          // the promotion at. Clear the endsAt and this sentence loses its
          // deadline by itself rather than going stale in a template.
          const endsAt = headline.endsAt ? new Date(headline.endsAt) : null;
          const endsOn = endsAt && Number.isFinite(endsAt.getTime())
            ? endsAt.toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "America/New_York" })
            : null;
          livePromotionNote = endsOn
            ? `Our ${headline.name} offer runs through ${endsOn} \u2014 a limited-time sale.`
            : `Our ${headline.name} offer is still running where eligible.`;
        }
      } catch (error) {
        // Not worth failing the send over — the message is about the gift.
        console.error("[cart-recovery] could not read live promotions; sending without the mention", error);
      }
      sent = await reserveAndSendStage({
        cartId, stage, email,
        campaignType: `cart_recovery_${stage}`,
        templateKey: "cartRecoveryGiftTemplate",
        // Minted behind the claim; a stage that cannot mint sends nothing.
        mintOffer: offerKey
          ? async () => {
            const issued = await issueCustomerOffer({ email, offerKey, referenceId: cartId });
            return issued?.token ?? null;
          }
          : undefined,
        onSent: (reservationId) => markCartRecoveryOverrideConsumed({ cartId, stage, reservationId }),
        buildTemplate: (url) => cartRecoveryGiftTemplate({
          ...base,
          restoreUrl: url,
          giftLabel: offerKey ? OFFER_CATALOG[offerKey].label : "",
          // The store's own statement of what the till will do, generated from
          // the same catalogue entry the checkout reads — so the copy and the
          // checkout cannot drift apart.
          offerTerms: offerKey
            ? describeOfferTerms(offerKey, new Date(now + OFFER_CATALOG[offerKey].ttlDays * 24 * HOUR_MS).toISOString())
            : "",
          promotionNote: livePromotionNote,
          perks: overridePerks,
          offerPercent: offerKey && "percent" in OFFER_CATALOG[offerKey].reward
            ? Number((OFFER_CATALOG[offerKey].reward as { percent: number }).percent)
            : 0,
          }),
      });
      if (sent) result[STAGE_RESULT_KEY[stage]] += 1;
      continue;
    }

    // WHAT THIS PARTICULAR CART'S STAGE MAY OFFER.
    //
    // The plan is a REQUEST, never a promise: what the email says is built
    // below from what was actually minted behind the stage claim. A gift that
    // fails to mint produces a message without one, not a message promising
    // one.
    const lastPaid = context.paidOrders.get(email)?.[0]?.at ?? null;
    // One arm per CART, held across all four stages - see the header of
    // cart-recovery-experiments.ts for why re-drawing per stage would make
    // neither arm describe an experience anyone had.
    const variant = recoveryVariantFor(cartId);
    const plan = planStageOffer({
      stage,
      // The reconciled figure, not the snapshot — see the note where it is
      // computed. The band a cart draws must match the basket it will restore.
      cartValueCents: reconciledCartCents,
      lastPaidAt: lastPaid,
      lastRecoveryCouponAt: context.lastRecoveryCouponAt.get(email) ?? null,
      lastRecoveryGiftAt: lastGiftForOtherCarts(context.recoveryGifts.get(email), cartId),
      discountPercent: config.discountPercent,
      tiers: recoveryTiers,
      now,
    });

    if (stage === "t30m") {
      sent = await reserveAndSendStage({
        cartId, stage, email,
        campaignType: "cart_recovery_t30m",
        templateKey: "cartRecoveryT30mTemplate",
        buildTemplate: (url) => cartRecoveryT30mTemplate({ ...base, restoreUrl: url, variant }),
      });
    } else if (stage === "t12h") {
      // THE PROOF MESSAGE. The batch number is whatever the catalogue holds for
      // the highest-value line in this cart, and it is omitted entirely when
      // there is none — a blanket "everything is tested" is false the moment
      // one product has no published report, and an invented batch number is
      // the worst thing this email could carry.
      const leadSlug = leadSlugFor(row, catalogueNames);
      const batchNumber = leadSlug ? catalogueNames.get(leadSlug)?.batchNumber ?? "" : "";
      sent = await reserveAndSendStage({
        cartId, stage, email,
        campaignType: "cart_recovery_t12h",
        templateKey: "cartRecoveryT12hTemplate",
        buildTemplate: (url) => cartRecoveryT12hTemplate({
          ...base,
          restoreUrl: url,
          coaUrl: `${getSiteUrl()}/coa-library`,
          batchNumber,
          supportEmail: SUPPORT_EMAIL,
        }),
      });
    } else if (stage === "t24h") {
      // THE GIFT STAGE. A pure product, so it lands alongside whatever
      // promotion is running instead of competing with it for the one discount
      // slot — the reason a percentage does not belong here is measured, not
      // preferred (10% was worth $0 to the two largest carts under Buy 2 Get 1).
      // THE BAND DECIDES THE GIFT. A $61 cart is offered a Recon Water and a
      // $520 cart a GHK-Cu and a Recon Water, because one flat gift under-serves
      // the carts holding most of the money and over-serves the rest.
      const giftKey = plan.offerKey;
      const giftConfig = recoveryGiftConfig(shippableGifts(plan.gifts), catalogueNameBySlug);
      let giftTerms = "";
      sent = await reserveAndSendStage({
        cartId, stage, email,
        campaignType: "cart_recovery_t24h",
        templateKey: "cartRecoveryT24hTemplate",
        mintOffer: giftKey && giftConfig
          ? async () => {
            const issued = await issueResolvedOffer({
              email, offerKey: giftKey, config: giftConfig, referenceId: cartId,
            });
            if (issued) {
              // From the SAME config the mint wrote onto the row, so what the
              // email states and what the till applies cannot disagree.
              giftTerms = describeGiftTerms(giftConfig, issued.expiresAt);
            }
            return issued?.token ?? null;
          }
          : undefined,
        buildTemplate: (url) => cartRecoveryT24hTemplate({
          ...base,
          restoreUrl: url,
          giftLabel: giftConfig?.label ?? "",
          offerTerms: giftTerms,
          variant,
          freeShipping: freeShippingSitewide,
        }),
      });
    } else {
      const discountAllowed = plan.coupon && recoveryDiscountAllowed({
        lastRecoveryCouponAt: context.lastRecoveryCouponAt.get(email) ?? null,
        lastPaidAt: lastPaid,
        now,
      });

      // THE GIFT IS SOFT HERE AND THE CODE IS NOT.
      //
      // reserveAndSendStage treats a failed `mintOffer` as fatal, because the
      // body of a gift email is about the gift. This message is not: it is the
      // last note about the cart, and it stands on the code and the cart
      // summary whether or not a vial can be attached. So the gift is minted
      // BEFORE the send is arranged, and a failure just means the gift block is
      // absent — never a stage that goes silent on its last chance to convert.
      //
      // issueCustomerOffer retires this cart's own stage-3 row and mints a
      // fresh token, so the link in the NEWEST email is the one that works.
      const giftKey = plan.offerKey;
      const giftConfig = recoveryGiftConfig(shippableGifts(plan.gifts), catalogueNameBySlug);
      let giftToken: string | null = null;
      let giftTerms = "";
      if (giftKey && giftConfig) {
        try {
          const issued = await issueResolvedOffer({
            email, offerKey: giftKey, config: giftConfig, referenceId: cartId,
          });
          if (issued) {
            giftToken = issued.token;
            giftTerms = describeGiftTerms(giftConfig, issued.expiresAt);
          }
        } catch (error) {
          console.error("[cart-recovery] last-chance gift could not be minted; sending without it", cartId, error);
        }
      }
      const giftLabel = giftToken && giftConfig ? giftConfig.label : "";

      // C-06 and K-05 both hold here: the claim comes first, and any code the
      // email advertises is one the database will honour at the till. When the
      // discount is not allowed the message still goes — it is the last note
      // about this cart either way — it simply carries no code.
      sent = await reserveAndSendStage({
        cartId, stage, email,
        campaignType: "cart_recovery_t72h",
        templateKey: "cartRecoveryT72hTemplate",
        // Not allowed a NEW code: re-offer one this cart already holds, if it
        // is live, and otherwise send without. Allowed: the cart's own live
        // code first, a fresh mint second — and a stage that can mint nothing
        // waits for the next sweep rather than promising a code it lacks.
        mintCoupon: discountAllowed
          // THE BAND'S PERCENTAGE, NOT THE GLOBAL ONE. `config.discountPercent`
          // is now the master switch — zero turns every recovery coupon off at
          // once — while each band carries the rate it was configured with.
          // Passing the global figure here made the band's percentage a number
          // that was computed, logged, and then quietly ignored: a $150 cart
          // whose band said 10% was mailed the global 5%.
          ? () => resolveLastChanceCoupon(cartId, email, plan.percent, config.couponExpirationHours)
          : () => findLiveCouponForCart(cartId),
        couponRequired: discountAllowed,
        offerToken: giftToken,
        buildTemplate: (url, coupon) => cartRecoveryT72hTemplate({
          ...base,
          restoreUrl: url,
          couponCode: coupon?.code ?? "",
          discountPercent: coupon ? coupon.percent : 0,
          // K-01. Vercel runs UTC, so a bare toLocaleString told a Pacific
          // customer 10 PM for a code that died at 3 PM their time.
          expiresAt: coupon?.expiresAt ? formatDisplayDate(coupon.expiresAt, "datetime") ?? "" : "",
          giftLabel,
          offerTerms: giftLabel ? giftTerms : "",
        }),
      });
    }

    if (sent) result[STAGE_RESULT_KEY[stage]] += 1;
  }

  return result;
}
