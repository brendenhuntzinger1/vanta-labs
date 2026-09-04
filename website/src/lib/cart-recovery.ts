import "server-only";
import crypto from "crypto";

import { supabaseAdmin } from "@/lib/supabase-server";
import { getCartRecoveryControlConfig, type CartRecoveryConfig } from "@/lib/admin-control";
import { getSiteUrl } from "@/lib/env";
import { formatDisplayDate } from "@/lib/format-date";
import { isMarketingSuppressed, sendMarketingEmail } from "@/lib/email/marketing";
import { claimMarketingSend } from "@/lib/email/frequency";
import { isPaidOrderStatus } from "@/lib/ledger";
import {
  cartRecoveryT30mTemplate,
  cartRecoveryT12hTemplate,
  cartRecoveryT24hTemplate,
  cartRecoveryT72hTemplate,
} from "@/lib/email/templates";

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

// Called from payment-webhook.ts's paid-status transition - stops every
// future reminder immediately, since the sweep only ever looks at
// status='active' rows.
export async function markAbandonedCartsRecovered(email: string, orderId: string) {
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
async function findLiveCouponForCart(cartId: string): Promise<RecoveryCoupon | null> {
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
  buildTemplate: (restoreUrlForEmail: string, coupon: RecoveryCoupon | null) => { subject: string; html: string; text: string };
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
    .insert({ abandoned_cart_id: input.cartId, stage: input.stage, sent_at: new Date().toISOString(), coupon_id: null })
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

  const trackedRestoreUrl = `${getSiteUrl()}/api/email/track/click?id=${reservationId}&url=${encodeURIComponent(restoreUrl(input.cartId))}`;
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
};

/** PostgREST `in` filters ride in the URL; a page of addresses is read in slices. */
const CONTEXT_CHUNK = 100;

function mergeRecoveryContext(into: RecoveryContext, from: RecoveryContext): void {
  for (const [email, orders] of from.paidOrders) into.paidOrders.set(email, orders);
  for (const [email, sends] of from.recoverySends) into.recoverySends.set(email, sends);
  for (const [email, at] of from.lastRecoveryCouponAt) into.lastRecoveryCouponAt.set(email, at);
}

async function loadRecoveryContext(emails: string[], now: number): Promise<RecoveryContext> {
  const context: RecoveryContext = { paidOrders: new Map(), recoverySends: new Map(), lastRecoveryCouponAt: new Map() };
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
      .select("order_id, customer_email, payment_status, created_at")
      .in("customer_email", emails);
    for (const row of (data ?? []) as Array<Record<string, unknown>>) {
      if (!isPaidOrderStatus(row.payment_status as string | null)) continue;
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

  return context;
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

  const context: RecoveryContext = { paidOrders: new Map(), recoverySends: new Map(), lastRecoveryCouponAt: new Map() };
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

  for (const { row, stage } of candidates) {
    const items = row.items as AbandonedCartItemSnapshot[];
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

    const name = row.customer_name ?? "";
    const cartId = String(row.id);
    const base = { name, items, cartValueCents: row.cart_value_cents };
    let sent = false;

    if (stage === "t30m") {
      sent = await reserveAndSendStage({
        cartId, stage, email,
        campaignType: "cart_recovery_t30m",
        templateKey: "cartRecoveryT30mTemplate",
        buildTemplate: (url) => cartRecoveryT30mTemplate({ ...base, restoreUrl: url }),
      });
    } else if (stage === "t12h") {
      sent = await reserveAndSendStage({
        cartId, stage, email,
        campaignType: "cart_recovery_t12h",
        templateKey: "cartRecoveryT12hTemplate",
        buildTemplate: (url) => cartRecoveryT12hTemplate({ ...base, restoreUrl: url }),
      });
    } else if (stage === "t24h") {
      // No code here any more. The second message answers the questions a
      // first-time buyer of a research compound actually has — testing,
      // shipping, who to ask — which is worth more than five percent to the
      // people who were hesitating, and costs nothing for the people who were
      // merely busy.
      sent = await reserveAndSendStage({
        cartId, stage, email,
        campaignType: "cart_recovery_t24h",
        templateKey: "cartRecoveryT24hTemplate",
        buildTemplate: (url) => cartRecoveryT24hTemplate({ ...base, restoreUrl: url }),
      });
    } else {
      const lastPaid = context.paidOrders.get(email)?.[0]?.at ?? null;
      const discountAllowed = config.discountPercent > 0 && recoveryDiscountAllowed({
        lastRecoveryCouponAt: context.lastRecoveryCouponAt.get(email) ?? null,
        lastPaidAt: lastPaid,
        now,
      });

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
          ? () => resolveLastChanceCoupon(cartId, email, config.discountPercent, config.couponExpirationHours)
          : () => findLiveCouponForCart(cartId),
        couponRequired: discountAllowed,
        buildTemplate: (url, coupon) => cartRecoveryT72hTemplate({
          ...base,
          restoreUrl: url,
          couponCode: coupon?.code ?? "",
          discountPercent: coupon ? coupon.percent : 0,
          // K-01. Vercel runs UTC, so a bare toLocaleString told a Pacific
          // customer 10 PM for a code that died at 3 PM their time.
          expiresAt: coupon?.expiresAt ? formatDisplayDate(coupon.expiresAt, "datetime") ?? "" : "",
        }),
      });
    }

    if (sent) result[STAGE_RESULT_KEY[stage]] += 1;
  }

  return result;
}
