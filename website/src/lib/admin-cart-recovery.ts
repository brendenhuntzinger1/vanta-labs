import "server-only";

import { supabaseAdmin } from "@/lib/supabase-server";
import { getCartRecoveryControlConfig } from "@/lib/admin-control";
import {
  cartRecoveryT30mTemplate,
  cartRecoveryT12hTemplate,
  cartRecoveryT24hTemplate,
  cartRecoveryT72hTemplate,
} from "@/lib/email/templates";
import { sendMarketingEmail } from "@/lib/email/marketing";
import { mintCartRecoveryCoupon, type AbandonedCartItemSnapshot } from "@/lib/cart-recovery";
import { getSiteUrl } from "@/lib/env";

export interface AbandonedCartRow {
  id: string;
  email: string;
  customerName: string | null;
  items: AbandonedCartItemSnapshot[];
  cartValueCents: number;
  firstSeenAt: string;
  status: string;
  recoveredOrderId: string | null;
  stagesSent: string[];
}

export async function listAbandonedCarts(limit = 100): Promise<AbandonedCartRow[]> {
  const { data, error } = await supabaseAdmin
    .from("abandoned_carts")
    .select("id, email, customer_name, items, cart_value_cents, first_seen_at, status, recovered_order_id")
    .order("first_seen_at", { ascending: false })
    .limit(limit);

  if (error) throw error;

  const carts = (data ?? []) as unknown as Array<{
    id: string;
    email: string;
    customer_name: string | null;
    items: unknown;
    cart_value_cents: number;
    first_seen_at: string;
    status: string;
    recovered_order_id: string | null;
  }>;

  const cartIds = carts.map((row) => row.id);
  const { data: emailRows } = cartIds.length
    ? await supabaseAdmin.from("abandoned_cart_emails").select("abandoned_cart_id, stage").in("abandoned_cart_id", cartIds)
    : { data: [] as Array<{ abandoned_cart_id: string; stage: string }> };

  const stagesByCart = new Map<string, string[]>();
  for (const row of emailRows ?? []) {
    const list = stagesByCart.get(row.abandoned_cart_id) ?? [];
    list.push(row.stage);
    stagesByCart.set(row.abandoned_cart_id, list);
  }

  return carts.map((row) => ({
    id: row.id,
    email: row.email,
    customerName: row.customer_name,
    items: Array.isArray(row.items) ? (row.items as AbandonedCartItemSnapshot[]) : [],
    cartValueCents: Number(row.cart_value_cents ?? 0),
    firstSeenAt: row.first_seen_at,
    status: row.status,
    recoveredOrderId: row.recovered_order_id,
    stagesSent: stagesByCart.get(row.id) ?? [],
  }));
}

export interface CartRecoveryStats {
  totalAbandoned: number;
  totalRecovered: number;
  recoveryPercent: number;
  potentialLostRevenueCents: number;
  revenueRecoveredCents: number;
  openRatePercent: number;
  clickRatePercent: number;
  couponRedemptionRatePercent: number;
  averageRecoveryTimeHours: number | null;
}

export async function getCartRecoveryStats(): Promise<CartRecoveryStats> {
  const { data: carts, error } = await supabaseAdmin
    .from("abandoned_carts")
    .select("status, cart_value_cents, first_seen_at, recovered_order_id");
  if (error) throw error;

  const rows = carts ?? [];
  const totalAbandoned = rows.length;
  const recoveredRows = rows.filter((row) => row.status === "recovered");
  const totalRecovered = recoveredRows.length;
  const potentialLostRevenueCents = rows
    .filter((row) => row.status === "active")
    .reduce((sum, row) => sum + Number(row.cart_value_cents ?? 0), 0);

  const recoveredOrderIds = recoveredRows.map((row) => row.recovered_order_id).filter((id): id is string => Boolean(id));
  let revenueRecoveredCents = 0;
  if (recoveredOrderIds.length > 0) {
    const { data: orders } = await supabaseAdmin.from("orders").select("amount_paid").in("order_id", recoveredOrderIds);
    revenueRecoveredCents = (orders ?? []).reduce((sum, row) => sum + Math.round(Number(row.amount_paid ?? 0) * 100), 0);
  }

  const { data: emailRows, error: emailError } = await supabaseAdmin
    .from("abandoned_cart_emails")
    .select("sent_at, opened_at, clicked_at, coupon_id");
  if (emailError) throw emailError;

  const sentEmails = emailRows ?? [];
  const openRatePercent = sentEmails.length > 0 ? Math.round((sentEmails.filter((row) => row.opened_at).length / sentEmails.length) * 1000) / 10 : 0;
  const clickRatePercent = sentEmails.length > 0 ? Math.round((sentEmails.filter((row) => row.clicked_at).length / sentEmails.length) * 1000) / 10 : 0;

  const couponEmails = sentEmails.filter((row) => row.coupon_id);
  let couponRedemptionRatePercent = 0;
  if (couponEmails.length > 0) {
    const couponIds = couponEmails.map((row) => row.coupon_id).filter((id): id is string => Boolean(id));
    const { data: coupons } = await supabaseAdmin.from("coupons").select("id, redemptions_count").in("id", couponIds);
    const redeemedCount = (coupons ?? []).filter((row) => Number(row.redemptions_count ?? 0) > 0).length;
    couponRedemptionRatePercent = Math.round((redeemedCount / couponEmails.length) * 1000) / 10;
  }

  let averageRecoveryTimeHours: number | null = null;
  if (recoveredOrderIds.length > 0) {
    const { data: orderTimestamps } = await supabaseAdmin.from("orders").select("order_id, created_at").in("order_id", recoveredOrderIds);
    const orderCreatedAtByOrderId = new Map((orderTimestamps ?? []).map((row) => [row.order_id, row.created_at]));
    const durations = recoveredRows
      .map((row) => {
        const orderCreatedAt = row.recovered_order_id ? orderCreatedAtByOrderId.get(row.recovered_order_id) : null;
        if (!orderCreatedAt) return null;
        return (new Date(String(orderCreatedAt)).getTime() - new Date(row.first_seen_at).getTime()) / (60 * 60 * 1000);
      })
      .filter((value): value is number => value !== null && value >= 0);

    if (durations.length > 0) {
      averageRecoveryTimeHours = Math.round((durations.reduce((sum, value) => sum + value, 0) / durations.length) * 10) / 10;
    }
  }

  return {
    totalAbandoned,
    totalRecovered,
    recoveryPercent: totalAbandoned > 0 ? Math.round((totalRecovered / totalAbandoned) * 1000) / 10 : 0,
    potentialLostRevenueCents,
    revenueRecoveredCents,
    openRatePercent,
    clickRatePercent,
    couponRedemptionRatePercent,
    averageRecoveryTimeHours,
  };
}

export interface RecoveryTrendPoint {
  date: string;
  abandoned: number;
  recovered: number;
}

export async function getCartRecoveryTrend(days: number): Promise<RecoveryTrendPoint[]> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const { data, error } = await supabaseAdmin
    .from("abandoned_carts")
    .select("first_seen_at, status")
    .gte("first_seen_at", since.toISOString());
  if (error) throw error;

  const byDate = new Map<string, { abandoned: number; recovered: number }>();
  for (const row of data ?? []) {
    const date = String(row.first_seen_at).slice(0, 10);
    const entry = byDate.get(date) ?? { abandoned: 0, recovered: 0 };
    entry.abandoned += 1;
    if (row.status === "recovered") entry.recovered += 1;
    byDate.set(date, entry);
  }

  return Array.from(byDate.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, counts]) => ({ date, ...counts }));
}

function restoreUrl(cartId: string) {
  return `${getSiteUrl()}/cart/restore?id=${cartId}`;
}

// Manual "resend recovery email" - re-sends whichever stage the admin
// picks, regardless of what the automatic sweep has already sent (an
// explicit admin action, not subject to the sweep's once-per-stage guard).
export async function resendCartRecoveryEmail(cartId: string, stage: "t30m" | "t12h" | "t24h" | "t72h") {
  const { data: cart, error } = await supabaseAdmin
    .from("abandoned_carts")
    .select("id, email, customer_name, items, cart_value_cents")
    .eq("id", cartId)
    .maybeSingle();

  if (error) throw error;
  if (!cart) throw new Error("Cart not found");

  const config = await getCartRecoveryControlConfig();
  const items = Array.isArray(cart.items) ? (cart.items as AbandonedCartItemSnapshot[]) : [];
  const name = cart.customer_name ?? "";

  let couponId: string | null = null;
  let couponCode: string | null = null;
  let couponExpiresAt: string | null = null;
  if (stage === "t24h" || stage === "t72h") {
    const coupon = await mintCartRecoveryCoupon(cart.email, config.discountPercent, config.couponExpirationHours);
    if (coupon) {
      couponCode = coupon.code;
      couponExpiresAt = coupon.expiresAt;
      const { data: couponRow } = await supabaseAdmin.from("coupons").select("id").eq("code", coupon.code).maybeSingle();
      couponId = couponRow?.id ?? null;
    }
  }

  // "Resend" reuses the same (cart, stage) tracking row rather than
  // inserting a duplicate - the unique index on abandoned_cart_emails
  // enforces one row per stage per cart, and resetting opened_at/clicked_at
  // means tracking reflects this new send, not a stale earlier one.
  const { data: existingRow } = await supabaseAdmin
    .from("abandoned_cart_emails")
    .select("id")
    .eq("abandoned_cart_id", cart.id)
    .eq("stage", stage)
    .maybeSingle();

  let rowId: string;
  if (existingRow) {
    rowId = existingRow.id;
    await supabaseAdmin
      .from("abandoned_cart_emails")
      .update({ sent_at: new Date().toISOString(), opened_at: null, clicked_at: null, coupon_id: couponId })
      .eq("id", rowId);
  } else {
    const { data: inserted, error: insertError } = await supabaseAdmin
      .from("abandoned_cart_emails")
      .insert({ abandoned_cart_id: cart.id, stage, sent_at: new Date().toISOString(), coupon_id: couponId })
      .select("id")
      .single();
    if (insertError || !inserted) throw insertError ?? new Error("Unable to create tracking row");
    rowId = inserted.id;
  }

  const trackedRestoreUrl = `${getSiteUrl()}/api/email/track/click?id=${rowId}&url=${encodeURIComponent(restoreUrl(cart.id))}`;
  const openTrackingPixelUrl = `${getSiteUrl()}/api/email/track/open?id=${rowId}`;

  if (stage === "t30m") {
    return sendMarketingEmail({
      to: cart.email,
      campaignType: "cart_recovery_t30m",
      referenceId: cart.id,
      templateKey: "cartRecoveryT30mTemplate",
      openTrackingPixelUrl,
      ...cartRecoveryT30mTemplate({ name, items, cartValueCents: cart.cart_value_cents, restoreUrl: trackedRestoreUrl }),
    });
  }

  if (stage === "t12h") {
    return sendMarketingEmail({
      to: cart.email,
      campaignType: "cart_recovery_t12h",
      referenceId: cart.id,
      templateKey: "cartRecoveryT12hTemplate",
      openTrackingPixelUrl,
      ...cartRecoveryT12hTemplate({ name, items, cartValueCents: cart.cart_value_cents, restoreUrl: trackedRestoreUrl }),
    });
  }

  const couponForEmail = couponCode ? { code: couponCode, expiresAt: couponExpiresAt ?? new Date().toISOString() } : { code: "CONTACT-SUPPORT", expiresAt: new Date().toISOString() };
  const template = stage === "t24h" ? cartRecoveryT24hTemplate : cartRecoveryT72hTemplate;

  return sendMarketingEmail({
    to: cart.email,
    campaignType: `cart_recovery_${stage}`,
    referenceId: cart.id,
    templateKey: stage === "t24h" ? "cartRecoveryT24hTemplate" : "cartRecoveryT72hTemplate",
    openTrackingPixelUrl,
    ...template({
      name,
      items,
      cartValueCents: cart.cart_value_cents,
      restoreUrl: trackedRestoreUrl,
      couponCode: couponForEmail.code,
      expiresAt: new Date(couponForEmail.expiresAt).toLocaleString("en-US"),
    }),
  });
}
