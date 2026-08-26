import "server-only";
import crypto from "crypto";

import { supabaseAdmin } from "@/lib/supabase-server";
import { getCartRecoveryControlConfig } from "@/lib/admin-control";
import { getSiteUrl } from "@/lib/env";
import { formatDisplayDate } from "@/lib/format-date";
import { sendMarketingEmail } from "@/lib/email/marketing";
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

export async function mintCartRecoveryCoupon(email: string, discountPercent: number, expiresInHours: number): Promise<{ id: string | null; code: string; expiresAt: string } | null> {
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

  // The id is what abandoned_cart_emails.coupon_id records, so the t72h stage can
  // load THIS coupon rather than describing one from memory (see resolveLastChanceCoupon).
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
): Promise<{ id: string | null; code: string; expiresAt: string } | null> {
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

async function hasSentStage(cartId: string, stage: string): Promise<boolean> {
  const { data } = await supabaseAdmin
    .from("abandoned_cart_emails")
    .select("id")
    .eq("abandoned_cart_id", cartId)
    .eq("stage", stage)
    .maybeSingle();
  return Boolean(data);
}

function restoreUrl(cartId: string) {
  return `${getSiteUrl()}/cart/restore?id=${cartId}`;
}

// Reserves the (abandoned_cart_id, stage) slot via the unique index on
// abandoned_cart_emails BEFORE sending, then uses the reserved row's id to
// build open/click tracking links for that specific send. If a stage was
// already reserved (duplicate-key error) this returns null, meaning
// "already sent - skip" rather than an error; any other insert failure
// throws. If the send itself fails, the reservation is rolled back so a
// later sweep pass can retry.
async function reserveAndSendStage(input: {
  cartId: string;
  stage: "t30m" | "t12h" | "t24h" | "t72h";
  email: string;
  campaignType: string;
  templateKey: string;
  couponId?: string | null;
  buildTemplate: (restoreUrlForEmail: string) => { subject: string; html: string; text: string };
}): Promise<boolean> {
  const { data: inserted, error: insertError } = await supabaseAdmin
    .from("abandoned_cart_emails")
    .insert({ abandoned_cart_id: input.cartId, stage: input.stage, sent_at: new Date().toISOString(), coupon_id: input.couponId ?? null })
    .select("id")
    .single();

  if (insertError) {
    if (insertError.code === "23505") {
      return false;
    }
    throw insertError;
  }

  const trackedRestoreUrl = `${getSiteUrl()}/api/email/track/click?id=${inserted.id}&url=${encodeURIComponent(restoreUrl(input.cartId))}`;
  const openTrackingPixelUrl = `${getSiteUrl()}/api/email/track/open?id=${inserted.id}`;

  const sendResult = await sendMarketingEmail({
    to: input.email,
    campaignType: input.campaignType,
    referenceId: input.cartId,
    templateKey: input.templateKey,
    openTrackingPixelUrl,
    ...input.buildTemplate(trackedRestoreUrl),
  });

  if (!sendResult.success) {
    await supabaseAdmin.from("abandoned_cart_emails").delete().eq("id", inserted.id);
    return false;
  }

  return true;
}

export interface AbandonedCartSweepResult {
  t30mSent: number;
  t12hSent: number;
  t24hSent: number;
  t72hSent: number;
}

// Idempotent - each stage reserves its slot in abandoned_cart_emails via a
// unique index before sending (see reserveAndSendStage), so a coarser cron
// interval just means coarser timing on when a stage fires, never a
// duplicate send.
export async function runAbandonedCartSweep(): Promise<AbandonedCartSweepResult> {
  const config = await getCartRecoveryControlConfig();
  const now = Date.now();
  const result: AbandonedCartSweepResult = { t30mSent: 0, t12hSent: 0, t24hSent: 0, t72hSent: 0 };

  // Only sweep carts new enough to still have a pending stage. The last stage
  // fires at 72h; past ~96h every stage has been sent (or is past its value), so
  // a still-"active" cart older than that would just be re-scanned every tick
  // forever. Bounding by first_seen_at keeps per-tick work flat as active carts
  // accumulate. (If the sweep is down >96h, those carts are past recovery value
  // anyway.)
  const RECOVERY_MAX_AGE_MS = 96 * HOUR_MS;
  const oldestFirstSeenIso = new Date(now - RECOVERY_MAX_AGE_MS).toISOString();
  const { data, error } = await supabaseAdmin
    .from("abandoned_carts")
    .select("id, email, customer_name, items, cart_value_cents, first_seen_at")
    .eq("status", "active")
    .gte("first_seen_at", oldestFirstSeenIso);

  if (error) throw error;

  for (const row of (data ?? []) as unknown as DueCartRow[]) {
    const elapsedMs = now - new Date(row.first_seen_at).getTime();
    const items = Array.isArray(row.items) ? row.items : [];
    if (items.length === 0) continue;

    const name = row.customer_name ?? "";

    if (config.t30mEnabled && elapsedMs >= 30 * MINUTE_MS) {
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

    if (config.t12hEnabled && elapsedMs >= 12 * HOUR_MS) {
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

    if (config.t24hEnabled && elapsedMs >= 24 * HOUR_MS) {
      // Mint a coupon only if this cart hasn't already had its t24h email — the
      // sweep runs repeatedly, so minting before the send-dedup check (as this
      // did) re-created a fresh SAVE-… code on every pass for any cart that
      // stayed abandoned. Guarding the mint (matching the t72h stage below)
      // means each forgotten cart gets exactly one recovery code.
      const alreadySent = await hasSentStage(row.id, "t24h");
      const coupon = alreadySent
        ? null
        : await mintCartRecoveryCoupon(row.email, config.discountPercent, config.couponExpirationHours);
      if (coupon) {
        const sent = await reserveAndSendStage({
          cartId: row.id,
          stage: "t24h",
          email: row.email,
          campaignType: "cart_recovery_t24h",
          templateKey: "cartRecoveryT24hTemplate",
          // Recorded so the t72h stage can load THIS coupon instead of
          // describing one from memory. reserveAndSendStage already writes
          // coupon_id; this call site simply never supplied it (K-05).
          couponId: coupon.id,
          buildTemplate: (url) => cartRecoveryT24hTemplate({
            name,
            items,
            cartValueCents: row.cart_value_cents,
            restoreUrl: url,
            couponCode: coupon.code,
            // K-01. Vercel runs UTC, so a bare toLocaleString told a Pacific
            // customer 10 PM for a code that died at 3 PM their time.
            expiresAt: formatDisplayDate(coupon.expiresAt, "datetime") ?? "",
          }),
        });
        if (sent) result.t24hSent += 1;
      }
    }

    if (config.t72hEnabled && elapsedMs >= 72 * HOUR_MS) {
      const couponForEmail = await resolveLastChanceCoupon(
        row.id, row.email, config.discountPercent, config.couponExpirationHours,
      );

      if (couponForEmail) {
        const sent = await reserveAndSendStage({
          cartId: row.id,
          stage: "t72h",
          email: row.email,
          campaignType: "cart_recovery_t72h",
          templateKey: "cartRecoveryT72hTemplate",
          couponId: couponForEmail.id,
          buildTemplate: (url) => cartRecoveryT72hTemplate({
            name,
            items,
            cartValueCents: row.cart_value_cents,
            restoreUrl: url,
            couponCode: couponForEmail.code,
            expiresAt: formatDisplayDate(couponForEmail.expiresAt, "datetime") ?? "",
          }),
        });
        if (sent) result.t72hSent += 1;
      }
    }
  }

  return result;
}
