import "server-only";
import crypto from "crypto";

import { supabaseAdmin } from "@/lib/supabase-server";
import { getCartRecoveryControlConfig } from "@/lib/admin-control";
import { getSiteUrl } from "@/lib/env";
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

export async function mintCartRecoveryCoupon(email: string, discountPercent: number, expiresInHours: number): Promise<{ code: string; expiresAt: string } | null> {
  const code = generateCouponCode();
  const expiresAt = new Date(Date.now() + expiresInHours * HOUR_MS).toISOString();

  const { error } = await supabaseAdmin.from("coupons").insert({
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
  });

  if (error) {
    console.error("Unable to mint cart recovery coupon:", error);
    return null;
  }

  return { code, expiresAt };
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

  const { data, error } = await supabaseAdmin
    .from("abandoned_carts")
    .select("id, email, customer_name, items, cart_value_cents, first_seen_at")
    .eq("status", "active");

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
      const coupon = await mintCartRecoveryCoupon(row.email, config.discountPercent, config.couponExpirationHours);
      if (coupon) {
        const sent = await reserveAndSendStage({
          cartId: row.id,
          stage: "t24h",
          email: row.email,
          campaignType: "cart_recovery_t24h",
          templateKey: "cartRecoveryT24hTemplate",
          buildTemplate: (url) => cartRecoveryT24hTemplate({
            name,
            items,
            cartValueCents: row.cart_value_cents,
            restoreUrl: url,
            couponCode: coupon.code,
            expiresAt: new Date(coupon.expiresAt).toLocaleString("en-US"),
          }),
        });
        if (sent) result.t24hSent += 1;
      }
    }

    if (config.t72hEnabled && elapsedMs >= 72 * HOUR_MS) {
      const alreadyHasCoupon = await hasSentStage(row.id, "t24h");
      const coupon = alreadyHasCoupon ? null : await mintCartRecoveryCoupon(row.email, config.discountPercent, config.couponExpirationHours);

      if (alreadyHasCoupon || coupon) {
        const couponForEmail = coupon ?? { code: "SEE PREVIOUS EMAIL", expiresAt: new Date(now + config.couponExpirationHours * HOUR_MS).toISOString() };
        const sent = await reserveAndSendStage({
          cartId: row.id,
          stage: "t72h",
          email: row.email,
          campaignType: "cart_recovery_t72h",
          templateKey: "cartRecoveryT72hTemplate",
          buildTemplate: (url) => cartRecoveryT72hTemplate({
            name,
            items,
            cartValueCents: row.cart_value_cents,
            restoreUrl: url,
            couponCode: couponForEmail.code,
            expiresAt: new Date(couponForEmail.expiresAt).toLocaleString("en-US"),
          }),
        });
        if (sent) result.t72hSent += 1;
      }
    }
  }

  return result;
}
