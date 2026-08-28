import "server-only";
import crypto from "crypto";

import { supabaseAdmin } from "@/lib/supabase-server";
import { getCartRecoveryControlConfig, type CartRecoveryConfig } from "@/lib/admin-control";
import { getSiteUrl } from "@/lib/env";
import { formatDisplayDate } from "@/lib/format-date";
import { isMarketingSuppressed, sendMarketingEmail } from "@/lib/email/marketing";
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
  if (!input.items.length || !input.email.trim()) {
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
    email: input.email.trim().toLowerCase(),
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

export interface AbandonedCartSnapshot {
  id: string;
  items: AbandonedCartItemSnapshot[];
  email: string;
  customerName: string | null;
}

// The cart id (a gen_random_uuid()) doubles as the restore token - it's
// already cryptographically random (122 bits) and never sequential, so a
// separate signed token isn't needed to keep it unguessable.
export async function getAbandonedCartById(id: string): Promise<AbandonedCartSnapshot | null> {
  const { data, error } = await supabaseAdmin
    .from("abandoned_carts")
    .select("id, items, email, customer_name, status")
    .eq("id", id)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;

  return {
    id: String(data.id),
    items: Array.isArray(data.items) ? (data.items as AbandonedCartItemSnapshot[]) : [],
    email: String(data.email),
    customerName: data.customer_name ? String(data.customer_name) : null,
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
  return { id: (insertedCoupon as { id?: string } | null)?.id ?? null, code, expiresAt };
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
async function resolveLastChanceCoupon(
  cartId: string,
  email: string,
  discountPercent: number,
  expiresInHours: number,
): Promise<RecoveryCoupon | null> {
  const { data: priorStage } = await supabaseAdmin
    .from("abandoned_cart_emails")
    .select("coupon_id")
    .eq("abandoned_cart_id", cartId)
    .eq("stage", "t24h")
    .maybeSingle();

  const priorCouponId = (priorStage as { coupon_id?: string | null } | null)?.coupon_id ?? null;

  if (priorCouponId) {
    const { data: existing } = await supabaseAdmin
      .from("coupons")
      .select("id, code, ends_at, active")
      .eq("id", priorCouponId)
      .maybeSingle();

    const row = existing as { id: string; code: string; ends_at: string | null; active: boolean } | null;
    // Same predicate the checkout will run (coupons.ts validateCoupon): active,
    // and not past ends_at. Anything this rejects would be rejected at the till.
    const stillLive = Boolean(
      row
      && row.active
      && row.ends_at
      && new Date(row.ends_at).getTime() > Date.now(),
    );
    if (stillLive && row) {
      return { id: row.id, code: row.code, expiresAt: row.ends_at as string };
    }
  }

  // Expired, missing, or never recorded. A fresh code is the only way to keep
  // the promise the email is about to make.
  return mintCartRecoveryCoupon(email, discountPercent, expiresInHours);
}

interface DueCartRow {
  id: string;
  email: string;
  customer_name: string | null;
  items: AbandonedCartItemSnapshot[];
  cart_value_cents: number;
  first_seen_at: string;
}

/**
 * The coupon a previous stage already minted for this cart, if any.
 *
 * t72h re-offers the code from t24h rather than minting a second one. It used to
 * print the literal string "SEE PREVIOUS EMAIL", which was already poor, and
 * became wrong once a claimed stage stopped implying a delivered email: the
 * "previous email" may never have arrived. Reading the real coupon off the
 * reservation gives the shopper a usable code either way, and mints nothing new.
 */
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
 * mints for ever for someone who has UNSUBSCRIBED. Bounded retry is a follow-up
 * and needs a column to count attempts; see PROPOSED-abandoned-cart-email-retry.sql.
 *
 * A FAILED MINT releases the claim, and that is safe for the opposite reason: no
 * coupon row exists, so a later pass cannot accumulate one. It is the only path
 * that still deletes a reservation.
 */
async function reserveAndSendStage(input: {
  cartId: string;
  stage: "t30m" | "t12h" | "t24h" | "t72h";
  email: string;
  campaignType: string;
  templateKey: string;
  /** Stages that carry a discount supply this; it runs only once the slot is held. */
  mintCoupon?: () => Promise<RecoveryCoupon | null>;
  buildTemplate: (restoreUrlForEmail: string, coupon: RecoveryCoupon | null) => { subject: string; html: string; text: string };
}): Promise<boolean> {
  const { data: inserted, error: insertError } = await supabaseAdmin
    .from("abandoned_cart_emails")
    .insert({ abandoned_cart_id: input.cartId, stage: input.stage, sent_at: new Date().toISOString(), coupon_id: null })
    .select("id")
    .single();

  if (insertError) {
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
    if (!coupon) {
      // No coupon exists, so releasing the slot cannot accumulate one. Let a
      // later sweep try again rather than silently dropping the stage.
      await supabaseAdmin.from("abandoned_cart_emails").delete().eq("id", reservationId);
      return false;
    }
    // Link the claim to the coupon so a later stage re-offers this code.
    await supabaseAdmin
      .from("abandoned_cart_emails")
      .update({ coupon_id: coupon.id })
      .eq("id", reservationId);
  }

  const trackedRestoreUrl = `${getSiteUrl()}/api/email/track/click?id=${reservationId}&url=${encodeURIComponent(restoreUrl(input.cartId))}`;
  const openTrackingPixelUrl = `${getSiteUrl()}/api/email/track/open?id=${reservationId}`;

  const sendResult = await sendMarketingEmail({
    to: input.email,
    campaignType: input.campaignType,
    referenceId: input.cartId,
    templateKey: input.templateKey,
    openTrackingPixelUrl,
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
}

/**
 * WHEN EACH STAGE BECOMES DUE. Stated once, because two things now need it:
 * the send blocks below, and the candidate filter that decides which carts are
 * worth spending the tick's budget on. Two copies of these numbers would drift,
 * and the drift would be silent — a cart the filter thought had nothing due
 * simply never gets its email.
 */
const STAGE_DUE_AFTER_MS = {
  t30m: 30 * MINUTE_MS,
  t12h: 12 * HOUR_MS,
  t24h: 24 * HOUR_MS,
  t72h: 72 * HOUR_MS,
} as const;

type RecoveryStage = keyof typeof STAGE_DUE_AFTER_MS;

const STAGE_ENABLED: Record<RecoveryStage, (config: CartRecoveryConfig) => boolean> = {
  t30m: (config) => config.t30mEnabled,
  t12h: (config) => config.t12hEnabled,
  t24h: (config) => config.t24hEnabled,
  t72h: (config) => config.t72hEnabled,
};

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
 * t30m email actually due — were never reached. So the stage claims are read in
 * bulk first and carts with nothing outstanding are dropped for free; the
 * budget is spent only on carts that have an unsent stage due right now. That
 * drains, because sending a stage removes it from the outstanding set for good.
 */
const CART_SWEEP_BUDGET = 200;
const CART_SCAN_PAGE = 500;
const CART_MAX_SCAN = 5000;

/** Stages this cart is old enough for, that the operator has left switched on. */
function dueStages(elapsedMs: number, config: CartRecoveryConfig): RecoveryStage[] {
  return (Object.keys(STAGE_DUE_AFTER_MS) as RecoveryStage[]).filter(
    (stage) => STAGE_ENABLED[stage](config) && elapsedMs >= STAGE_DUE_AFTER_MS[stage],
  );
}

/** Which (cart, stage) slots are already claimed, for a page of carts. */
async function claimedStagesFor(cartIds: string[]): Promise<Set<string>> {
  if (cartIds.length === 0) return new Set();
  const { data, error } = await supabaseAdmin
    .from("abandoned_cart_emails")
    .select("abandoned_cart_id, stage")
    .in("abandoned_cart_id", cartIds);

  // Fail OPEN: an unreadable claim table means we cannot subtract anything, so
  // every cart stays a candidate and the unique index does the deduplication as
  // it always did. Slower for a tick, never a wrong send.
  if (error || !data) return new Set();
  return new Set(data.map((row) => `${String(row.abandoned_cart_id)}::${String(row.stage)}`));
}

// Idempotent - each stage reserves its slot in abandoned_cart_emails via a
// unique index before sending (see reserveAndSendStage), so a coarser cron
// interval just means coarser timing on when a stage fires, never a
// duplicate send.
export async function runAbandonedCartSweep(): Promise<AbandonedCartSweepResult> {
  const config = await getCartRecoveryControlConfig();
  const now = Date.now();
  const result: AbandonedCartSweepResult = {
    t30mSent: 0, t12hSent: 0, t24hSent: 0, t72hSent: 0, scanned: 0, eligible: 0,
  };

  // Only sweep carts new enough to still have a pending stage. The last stage
  // fires at 72h; past ~96h every stage has been sent (or is past its value), so
  // a still-"active" cart older than that would just be re-scanned every tick
  // forever. Bounding by first_seen_at keeps per-tick work flat as active carts
  // accumulate. (If the sweep is down >96h, those carts are past recovery value
  // anyway.)
  const RECOVERY_MAX_AGE_MS = 96 * HOUR_MS;
  const oldestFirstSeenIso = new Date(now - RECOVERY_MAX_AGE_MS).toISOString();

  const candidates: DueCartRow[] = [];
  for (let offset = 0; offset < CART_MAX_SCAN && candidates.length < CART_SWEEP_BUDGET; offset += CART_SCAN_PAGE) {
    const { data, error } = await supabaseAdmin
      .from("abandoned_carts")
      .select("id, email, customer_name, items, cart_value_cents, first_seen_at")
      .eq("status", "active")
      .gte("first_seen_at", oldestFirstSeenIso)
      // Oldest first: the cart closest to ageing out of the window is the one
      // with the least time left to be recovered.
      .order("first_seen_at", { ascending: true })
      .range(offset, offset + CART_SCAN_PAGE - 1);

    if (error) throw error;

    const page = (data ?? []) as unknown as DueCartRow[];
    if (page.length === 0) break;
    result.scanned += page.length;

    const claimed = await claimedStagesFor(page.map((row) => String(row.id)));

    for (const row of page) {
      const elapsedMs = now - new Date(row.first_seen_at).getTime();
      const outstanding = dueStages(elapsedMs, config).some(
        (stage) => !claimed.has(`${String(row.id)}::${stage}`),
      );
      if (!outstanding) continue;
      candidates.push(row);
      if (candidates.length >= CART_SWEEP_BUDGET) break;
    }

    if (page.length < CART_SCAN_PAGE) break;
  }

  result.eligible = candidates.length;

  for (const row of candidates) {
    const elapsedMs = now - new Date(row.first_seen_at).getTime();
    const items = Array.isArray(row.items) ? row.items : [];
    if (items.length === 0) continue;

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
    if (await isMarketingSuppressed(row.email)) continue;

    const name = row.customer_name ?? "";

    if (config.t30mEnabled && elapsedMs >= STAGE_DUE_AFTER_MS.t30m) {
      const sent = await reserveAndSendStage({
        cartId: row.id,
        stage: "t30m",
        email: row.email,
        campaignType: "cart_recovery_t30m",
        templateKey: "cartRecoveryT30mTemplate",
        buildTemplate: (url) => cartRecoveryT30mTemplate({ name, items, cartValueCents: row.cart_value_cents, restoreUrl: url }),
      });
      if (sent) result.t30mSent += 1;
    }

    if (config.t12hEnabled && elapsedMs >= STAGE_DUE_AFTER_MS.t12h) {
      const sent = await reserveAndSendStage({
        cartId: row.id,
        stage: "t12h",
        email: row.email,
        campaignType: "cart_recovery_t12h",
        templateKey: "cartRecoveryT12hTemplate",
        buildTemplate: (url) => cartRecoveryT12hTemplate({ name, items, cartValueCents: row.cart_value_cents, restoreUrl: url }),
      });
      if (sent) result.t12hSent += 1;
    }

    if (config.t24hEnabled && elapsedMs >= STAGE_DUE_AFTER_MS.t24h) {
      // C-06: the mint is handed to reserveAndSendStage rather than performed
      // here, so it cannot run until the (cart, stage) slot is claimed. Minting
      // first, then claiming, is what let a failed send re-mint on every sweep —
      // 2,994 passes and 335 live coupons in production.
      const sent = await reserveAndSendStage({
        cartId: row.id,
        stage: "t24h",
        email: row.email,
        campaignType: "cart_recovery_t24h",
        templateKey: "cartRecoveryT24hTemplate",
        mintCoupon: () => mintCartRecoveryCoupon(row.email, config.discountPercent, config.couponExpirationHours),
        buildTemplate: (url, coupon) => cartRecoveryT24hTemplate({
          name,
          items,
          cartValueCents: row.cart_value_cents,
          restoreUrl: url,
          couponCode: coupon?.code ?? "",
          // K-01. Vercel runs UTC, so a bare toLocaleString told a Pacific
          // customer 10 PM for a code that died at 3 PM their time.
          expiresAt: coupon?.expiresAt ? formatDisplayDate(coupon.expiresAt, "datetime") ?? "" : "",
        }),
      });
      if (sent) result.t24hSent += 1;
    }

    if (config.t72hEnabled && elapsedMs >= STAGE_DUE_AFTER_MS.t72h) {
      // Both fixes, and they need each other.
      //
      // C-06 says claim the slot BEFORE resolving a coupon, so a failed send can
      // never re-mint. K-05 says the coupon this email advertises must be one
      // the database will actually honour — the old code invented the literal
      // string "SEE PREVIOUS EMAIL" and an expiry no row held, and simply
      // re-offering t24h's code is not enough either: under the shipped
      // defaults that code is already 24 hours dead by the time this stage
      // fires (t24h and t72h are 48h apart; couponExpirationHours defaults to
      // 48). resolveLastChanceCoupon re-offers it only while it is still live
      // and mints a fresh one otherwise, and it runs behind the claim.
      const sent = await reserveAndSendStage({
        cartId: row.id,
        stage: "t72h",
        email: row.email,
        campaignType: "cart_recovery_t72h",
        templateKey: "cartRecoveryT72hTemplate",
        mintCoupon: () => resolveLastChanceCoupon(
          row.id, row.email, config.discountPercent, config.couponExpirationHours,
        ),
        buildTemplate: (url, coupon) => cartRecoveryT72hTemplate({
          name,
          items,
          cartValueCents: row.cart_value_cents,
          restoreUrl: url,
          couponCode: coupon?.code ?? "",
          expiresAt: coupon?.expiresAt ? formatDisplayDate(coupon.expiresAt, "datetime") ?? "" : "",
        }),
      });
      if (sent) result.t72hSent += 1;
    }
  }

  return result;
}
