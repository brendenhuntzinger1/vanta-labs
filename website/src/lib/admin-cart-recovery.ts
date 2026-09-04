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
import { claimMarketingSend } from "@/lib/email/frequency";
import { mintCartRecoveryCoupon, type AbandonedCartItemSnapshot } from "@/lib/cart-recovery";
import { getSiteUrl } from "@/lib/env";
import { formatDisplayDate } from "@/lib/format-date";
import { isRevenueOrderStatus, isSaleOrder, netOrderRevenue } from "@/lib/ledger";
import { readAllRowsBounded } from "@/lib/supabase-page";

/**
 * Ceiling on the paged reads below. Matches the figure admin-email.ts uses for
 * the same shape of read (rates over a whole table) so the two dashboards agree
 * on when a number stops being complete.
 */
const MAX_RECOVERY_ROWS = 500_000;

/**
 * `.in(...)` values travel in the request URL, so a long list has to go out in
 * chunks or the URL is rejected. 150 is the size admin-profit.ts settled on for
 * exactly that reason; each chunk keys on a unique column, so a chunk can never
 * return more rows than it has ids and PostgREST's row cap cannot bite.
 */
const IN_CHUNK = 150;

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
  /**
   * NET revenue kept on the orders that closed a recovered cart — the canonical
   * ledger.netOrderRevenue over revenue-status sale orders, not gross
   * `amount_paid`. See the derivation in getCartRecoveryStats for why this is
   * P&L rather than attribution, and what answers the attribution question
   * instead.
   */
  revenueRecoveredCents: number;
  openRatePercent: number;
  clickRatePercent: number;
  couponRedemptionRatePercent: number;
  averageRecoveryTimeHours: number | null;
  /** Per stage: how many went out, and how many of those were opened and clicked. */
  stages: Array<{ stage: string; sent: number; opened: number; clicked: number }>;
}

export async function getCartRecoveryStats(): Promise<CartRecoveryStats> {
  // PAGED, NOT A BARE SELECT (F-A-14). PostgREST caps a single response at
  // `max-rows` — 1000 by default — and does it SILENTLY: the response is a valid
  // array that simply stops. Every figure below is a count of these rows, a sum
  // over them, or a RATIO over them, so a capped read does not fail, it reports
  // the recovery rate of whichever 1000 carts came back as though it were the
  // store's. `id` is the deterministic page key; `first_seen_at` is not unique,
  // so paging on it alone could repeat or skip a cart across a boundary.
  const { rows } = await readAllRowsBounded<{
    status: string;
    cart_value_cents: number | null;
    first_seen_at: string;
    recovered_order_id: string | null;
  }>(
    (from, to) => supabaseAdmin
      .from("abandoned_carts")
      .select("status, cart_value_cents, first_seen_at, recovered_order_id")
      .order("id", { ascending: true })
      .range(from, to) as unknown as PromiseLike<{
        data: { status: string; cart_value_cents: number | null; first_seen_at: string; recovered_order_id: string | null }[] | null;
        error: unknown;
      }>,
    { maxRows: MAX_RECOVERY_ROWS, label: "cart recovery stats read" },
  );

  const totalAbandoned = rows.length;
  const recoveredRows = rows.filter((row) => row.status === "recovered");
  const totalRecovered = recoveredRows.length;
  const potentialLostRevenueCents = rows
    .filter((row) => row.status === "active")
    .reduce((sum, row) => sum + Number(row.cart_value_cents ?? 0), 0);

  const recoveredOrderIds = recoveredRows.map((row) => row.recovered_order_id).filter((id): id is string => Boolean(id));
  let revenueRecoveredCents = 0;
  if (recoveredOrderIds.length > 0) {
    // THIS IS REVENUE, AND IT USES THE REVENUE DEFINITION — a decision, recorded
    // here because the alternative is defensible and was rejected.
    //
    // It summed GROSS `amount_paid` with NO refund subtraction and NO status
    // filter, so a cart "recovered" by an order that never took a payment
    // contributed its full value, and a recovery that was later returned still
    // counted as money kept.
    //
    // The gross figure has an honest reading — ATTRIBUTION: the email did bring
    // the customer back, and a return weeks later is a different event. It is
    // rejected because of where this number is rendered. It is a tile labelled
    // "Revenue Recovered" beside "Potential Lost Revenue", read to decide
    // whether recovery emails pay for themselves, and that question is answered
    // by what the store KEPT. ledger.ts exists so "revenue" means one thing on
    // every surface; a second definition behind a money tile is what it forbids.
    //
    // Attribution is not lost: `totalRecovered` above counts every cart the
    // emails closed, refunded or not. The count says whether the campaign
    // worked; this says what it was worth.
    //
    // CHUNKED because the cart read above is no longer capped at one page:
    // `recoveredOrderIds` can now be arbitrarily long, and an unchunked `.in`
    // would either blow the URL length limit or come back one page short —
    // undercounting a money tile.
    const orders: Array<Record<string, unknown>> = [];
    for (let i = 0; i < recoveredOrderIds.length; i += IN_CHUNK) {
      const { data } = await supabaseAdmin
        .from("orders")
        .select("amount_paid, refund_amount, payment_status, order_type, marketing_source_kind")
        .in("order_id", recoveredOrderIds.slice(i, i + IN_CHUNK));
      orders.push(...((data ?? []) as Array<Record<string, unknown>>));
    }
    // ONE CHANNEL PER ORDER. An order whose primary marketing source is an
    // automation, a campaign, an ambassador or an ad is that channel's revenue
    // and is not "recovered" money as well — the cart count above still
    // records that the cart closed. A recovery-coupon order, an organic
    // order, and an order from before the source existed all count here.
    const creditedElsewhere = (kind: unknown) =>
      typeof kind === "string" && kind !== "" && kind !== "cart_recovery" && kind !== "organic";
    revenueRecoveredCents = orders
      .filter((row) => isRevenueOrderStatus(row.payment_status as string | null) && isSaleOrder(row.order_type as string | null))
      .filter((row) => !creditedElsewhere(row.marketing_source_kind))
      .reduce((sum, row) => sum + Math.round(netOrderRevenue(row as { amount_paid?: number | null; refund_amount?: number | null }) * 100), 0);
  }

  // Paged for the same reason as the cart read: the open and click rates are
  // ratios over the WHOLE of this table, and a capped read makes them the rates
  // of one arbitrary page.
  const { rows: sentEmails } = await readAllRowsBounded<{
    stage: string;
    sent_at: string | null;
    opened_at: string | null;
    clicked_at: string | null;
    coupon_id: string | null;
  }>(
    (from, to) => supabaseAdmin
      .from("abandoned_cart_emails")
      .select("stage, sent_at, opened_at, clicked_at, coupon_id")
      .order("id", { ascending: true })
      .range(from, to) as unknown as PromiseLike<{
        data: { stage: string; sent_at: string | null; opened_at: string | null; clicked_at: string | null; coupon_id: string | null }[] | null;
        error: unknown;
      }>,
    { maxRows: MAX_RECOVERY_ROWS, label: "cart recovery email read" },
  );

  // Per stage, in sequence order, so the funnel reads top to bottom.
  const stageOrder = ["t30m", "t12h", "t24h", "t72h"];
  const stageTallies = new Map<string, { sent: number; opened: number; clicked: number }>();
  for (const row of sentEmails) {
    const stage = String(row.stage ?? "");
    const tally = stageTallies.get(stage) ?? { sent: 0, opened: 0, clicked: 0 };
    tally.sent += 1;
    if (row.opened_at) tally.opened += 1;
    if (row.clicked_at) tally.clicked += 1;
    stageTallies.set(stage, tally);
  }
  const stages = stageOrder
    .filter((stage) => stageTallies.has(stage))
    .map((stage) => ({ stage, ...(stageTallies.get(stage) as { sent: number; opened: number; clicked: number }) }));

  const openRatePercent = sentEmails.length > 0 ? Math.round((sentEmails.filter((row) => row.opened_at).length / sentEmails.length) * 1000) / 10 : 0;
  const clickRatePercent = sentEmails.length > 0 ? Math.round((sentEmails.filter((row) => row.clicked_at).length / sentEmails.length) * 1000) / 10 : 0;

  const couponEmails = sentEmails.filter((row) => row.coupon_id);
  let couponRedemptionRatePercent = 0;
  if (couponEmails.length > 0) {
    const couponIds = couponEmails.map((row) => row.coupon_id).filter((id): id is string => Boolean(id));
    const coupons: Array<Record<string, unknown>> = [];
    for (let i = 0; i < couponIds.length; i += IN_CHUNK) {
      const { data } = await supabaseAdmin
        .from("coupons")
        .select("id, redemptions_count")
        .in("id", couponIds.slice(i, i + IN_CHUNK));
      coupons.push(...((data ?? []) as Array<Record<string, unknown>>));
    }
    const redeemedCount = coupons.filter((row) => Number(row.redemptions_count ?? 0) > 0).length;
    couponRedemptionRatePercent = Math.round((redeemedCount / couponEmails.length) * 1000) / 10;
  }

  let averageRecoveryTimeHours: number | null = null;
  if (recoveredOrderIds.length > 0) {
    const orderTimestamps: Array<{ order_id: string; created_at: string }> = [];
    for (let i = 0; i < recoveredOrderIds.length; i += IN_CHUNK) {
      const { data } = await supabaseAdmin
        .from("orders")
        .select("order_id, created_at")
        .in("order_id", recoveredOrderIds.slice(i, i + IN_CHUNK));
      orderTimestamps.push(...((data ?? []) as Array<{ order_id: string; created_at: string }>));
    }
    const orderCreatedAtByOrderId = new Map(orderTimestamps.map((row) => [row.order_id, row.created_at]));
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
    stages,
  };
}

export interface RecoveryTrendPoint {
  date: string;
  abandoned: number;
  recovered: number;
}

export async function getCartRecoveryTrend(days: number): Promise<RecoveryTrendPoint[]> {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  // Paged for the same reason as getCartRecoveryStats: a date range is not a row
  // cap, and a capped read here draws a chart that flattens out partway through
  // the window rather than failing.
  const { rows } = await readAllRowsBounded<{ first_seen_at: string; status: string }>(
    (from, to) => supabaseAdmin
      .from("abandoned_carts")
      .select("first_seen_at, status")
      .gte("first_seen_at", since.toISOString())
      .order("id", { ascending: true })
      .range(from, to) as unknown as PromiseLike<{ data: { first_seen_at: string; status: string }[] | null; error: unknown }>,
    { maxRows: MAX_RECOVERY_ROWS, label: "cart recovery trend read" },
  );

  const byDate = new Map<string, { abandoned: number; recovered: number }>();
  for (const row of rows) {
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

  // THE GUARD FIRST, before anything is minted or reset. A manual resend is
  // an explicit admin action and skips the sweep's per-stage and 30-day
  // cooldowns — but it is still one marketing email to one inbox, and the
  // one-a-day rule is the same rule for everyone. Asked here so a deferral
  // costs nothing: no coupon minted for a mail that did not go, no tracking
  // row saying "sent just now", no seven-day cooldown armed by a non-send.
  const campaignType = `cart_recovery_${stage}`;
  const guard = await claimMarketingSend({
    email: cart.email,
    campaignType,
    referenceId: cart.id,
    templateKey: campaignType,
  });
  if (guard.outcome === "deferred") {
    return {
      success: false,
      deferred: true,
      retryAt: guard.retryAt,
      error: `Held by the marketing frequency guard: this customer received a marketing email at ${new Date(guard.lastMarketingAt).toLocaleString("en-US", { timeZone: "UTC" })} UTC. The resend can go after ${new Date(guard.retryAt).toLocaleString("en-US", { timeZone: "UTC" })} UTC.`,
    };
  }
  if (guard.outcome === "duplicate" || guard.outcome === "refused") {
    return { success: false, error: "This message could not be claimed for sending." };
  }
  const claimedLogId = guard.outcome === "claimed" ? guard.logId : null;
  const guardUnavailable = guard.outcome === "unavailable";

  let couponId: string | null = null;
  let couponCode: string | null = null;
  let couponExpiresAt: string | null = null;
  let couponPercent = 0;
  // Only the final stage carries a code now; the 24-hour message answers
  // questions instead. A manual resend is an explicit admin action, so it
  // mints without the sweep's per-address cooldown.
  if (stage === "t72h") {
    const coupon = await mintCartRecoveryCoupon(cart.email, config.discountPercent, config.couponExpirationHours);
    if (coupon) {
      couponCode = coupon.code;
      couponExpiresAt = coupon.expiresAt;
      couponPercent = coupon.percent;
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
      claimedLogId,
      guardUnavailable,
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
      claimedLogId,
      guardUnavailable,
      ...cartRecoveryT12hTemplate({ name, items, cartValueCents: cart.cart_value_cents, restoreUrl: trackedRestoreUrl }),
    });
  }

  if (stage === "t24h") {
    return sendMarketingEmail({
      to: cart.email,
      campaignType: "cart_recovery_t24h",
      referenceId: cart.id,
      templateKey: "cartRecoveryT24hTemplate",
      openTrackingPixelUrl,
      claimedLogId,
      guardUnavailable,
      ...cartRecoveryT24hTemplate({ name, items, cartValueCents: cart.cart_value_cents, restoreUrl: trackedRestoreUrl }),
    });
  }

  return sendMarketingEmail({
    to: cart.email,
    campaignType: "cart_recovery_t72h",
    referenceId: cart.id,
    templateKey: "cartRecoveryT72hTemplate",
    openTrackingPixelUrl,
    claimedLogId,
    guardUnavailable,
    ...cartRecoveryT72hTemplate({
      name,
      items,
      cartValueCents: cart.cart_value_cents,
      restoreUrl: trackedRestoreUrl,
      couponCode: couponCode ?? "",
      discountPercent: couponCode ? couponPercent : 0,
      expiresAt: couponExpiresAt ? formatDisplayDate(couponExpiresAt, "datetime") ?? "" : "",
    }),
  });
}
