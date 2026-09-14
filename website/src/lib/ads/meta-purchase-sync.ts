import "server-only";

import { supabaseAdmin } from "@/lib/supabase-server";
import { buildMetaPurchase, type MetaEvent } from "@/lib/ads/meta-events";
import { describeMetaResult, metaCredentialStatus, sendMetaConversion } from "@/lib/ads/meta-conversions";
import { getOrderAttribution } from "@/lib/order-attribution";
import { siteUrl } from "@/lib/site-identity";

/**
 * Meta Purchase, reported from the server for EVERY paid order.
 *
 * WHY THIS EXISTS. Every other server-side purchase report here fires only
 * when the customer opens the confirmation page: the page asks
 * /api/ads/purchase-event, and being asked is what sends. Measured on
 * 2026-09-14, nine of eighteen paid orders had no ledger row at all — closed
 * tab, email link, declined cookies — and were never reported anywhere. The
 * owner's requirement for Meta is "know who buys", so Purchase cannot depend
 * on a page load.
 *
 * Two callers, one send:
 *
 *   1. The confirmation-page route, at the moment the order is paid, which
 *      can attach the browser's IP, user agent and the pixel's own cookies —
 *      the strongest match signals after hashed identity.
 *   2. The cron sweep, which walks paid orders from the last seven days with
 *      no delivered Meta row and reports each one from the order alone.
 *
 * Both take the same ledger claim, so an order is reported once whichever
 * arrives first. The claim is the INSERT on (order_id, platform); the loser
 * gets a unique violation and sends nothing — the same guard the TikTok and
 * Reddit legs use, for the same race.
 *
 * IDENTITY. Hashed on the server by meta-conversions.ts from the order's own
 * email, phone, name and postal fields — never handed to the browser. The
 * event_id is the order id, identical to what the browser pixel sends, so the
 * two legs are one purchase to Meta.
 */

type Ledger = {
  claimSend: (platform: string, eventId: string) => Promise<boolean>;
  recordSend: (platform: string, eventId: string, delivered: boolean, tiktokCode: number | null) => Promise<void>;
  releaseSend: (platform: string) => Promise<void>;
};

type OrderRow = {
  order_id: string;
  payment_status?: string | null;
  amount_paid?: number | string | null;
  customer_email?: string | null;
  customer_name?: string | null;
  customer_user_id?: string | null;
  phone?: string | null;
  city?: string | null;
  state?: string | null;
  postal_code?: string | null;
  country?: string | null;
  paid_at?: string | null;
  created_at?: string | null;
  order_items?: { product_id?: string | null; product_name?: string | null; quantity?: number | null; unit_price?: number | null }[];
};

const ORDER_COLUMNS =
  "order_id, payment_status, amount_paid, customer_email, customer_name, customer_user_id, phone, city, state, postal_code, country, paid_at, created_at, order_items(product_id, product_name, quantity, unit_price)";

/** Meta rejects anything older than seven days. */
const LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
const SWEEP_BATCH = 25;

/**
 * Send one order's Purchase to Meta behind the ledger claim.
 *
 * Returns the one-line description for logs, or null when nothing was sent.
 * Never throws: the caller is either a customer-facing route or a cron job,
 * and neither may fail over telemetry.
 */
export async function sendMetaPurchaseForOrder(input: {
  orderId: string;
  event: MetaEvent;
  ledger: Ledger;
  order?: OrderRow | null;
  browser?: { ipAddress?: string | null; userAgent?: string | null; fbp?: string | null; fbc?: string | null };
  occurredAt?: Date;
}): Promise<string | null> {
  if (!metaCredentialStatus().configured) return null;
  if (!(await input.ledger.claimSend("meta", input.event.eventId))) return null;

  try {
    const order = input.order ?? (await loadOrder(input.orderId));
    const attribution = await getOrderAttribution(input.orderId).catch(() => null);
    const touch = attribution?.last?.fbclid ? attribution.last : attribution?.first?.fbclid ? attribution.first : null;

    const outcome = await sendMetaConversion({
      event: input.event,
      occurredAt: input.occurredAt ?? new Date(),
      eventSourceUrl: `${siteUrl()}/order-confirmation/${encodeURIComponent(input.orderId)}`,
      clickedAt: touch?.at ? new Date(touch.at) : null,
      user: {
        email: order?.customer_email ?? null,
        phone: order?.phone ?? null,
        externalId: order?.customer_user_id ?? null,
        fullName: order?.customer_name ?? null,
        city: order?.city ?? null,
        state: order?.state ?? null,
        postalCode: order?.postal_code ?? null,
        country: order?.country ?? null,
        ipAddress: input.browser?.ipAddress ?? null,
        userAgent: input.browser?.userAgent ?? null,
        fbp: input.browser?.fbp ?? null,
        fbc: input.browser?.fbc ?? null,
        fbclid: touch?.fbclid ?? null,
      },
    });
    const described = describeMetaResult(outcome);
    await input.ledger.recordSend("meta", input.event.eventId, outcome.delivered, null);
    if (!outcome.delivered) console.error("[ads/meta-conversions]", input.orderId, described);
    return described;
  } catch (error) {
    // The send never happened, so the claim must not outlive it.
    await input.ledger.releaseSend("meta");
    console.error("[ads/meta-conversions] send threw", error);
    return null;
  }
}

async function loadOrder(orderId: string): Promise<OrderRow | null> {
  const { data } = await supabaseAdmin.from("orders").select(ORDER_COLUMNS).eq("order_id", orderId).maybeSingle();
  return (data as OrderRow | null) ?? null;
}

/** The ledger operations, bound to the shared table, for callers without their own. */
export function metaLedger(orderId: string): Ledger {
  return {
    claimSend: async (platform, eventId) => {
      try {
        const { error } = await supabaseAdmin
          .from("ad_purchase_events_sent")
          .insert({ order_id: orderId, event_id: eventId, platform, delivered: false, tiktok_code: null });
        if (!error) return true;
        if ((error as { code?: string }).code === "23505") return false;
        return true;
      } catch {
        return true;
      }
    },
    recordSend: async (platform, eventId, delivered) => {
      try {
        await supabaseAdmin
          .from("ad_purchase_events_sent")
          .upsert({ order_id: orderId, event_id: eventId, platform, delivered, tiktok_code: null }, { onConflict: "order_id,platform" });
      } catch {
        /* ledger unavailable; Meta's own dedup window still applies */
      }
    },
    releaseSend: async (platform) => {
      try {
        await supabaseAdmin
          .from("ad_purchase_events_sent")
          .delete()
          .eq("order_id", orderId)
          .eq("platform", platform)
          .eq("delivered", false);
      } catch {
        /* the next ask is refused, which is the safe direction */
      }
    },
  };
}

/** Pure: which of these orders still need a Meta Purchase. Exported for tests. */
export function ordersNeedingMetaPurchase(
  orders: OrderRow[],
  ledgerRows: { order_id: string; platform: string; delivered: boolean }[],
  now: Date = new Date(),
): OrderRow[] {
  const done = new Set(ledgerRows.filter((row) => row.platform === "meta").map((row) => row.order_id));
  return orders.filter((order) => {
    if (String(order.payment_status ?? "").toLowerCase() !== "paid") return false;
    if (done.has(order.order_id)) return false;
    const paidAt = new Date(order.paid_at ?? order.created_at ?? 0).getTime();
    return Number.isFinite(paidAt) && now.getTime() - paidAt <= LOOKBACK_MS;
  });
}

export type MetaPurchaseSweepResult = {
  candidates: number;
  sent: number;
  skipped: string | null;
};

/**
 * The cron job. Idempotent: it looks for ABSENCE of a Meta ledger row, and the
 * claim inside sendMetaPurchaseForOrder makes a concurrent run harmless.
 */
export async function sweepUnsentMetaPurchases(): Promise<MetaPurchaseSweepResult> {
  if (!metaCredentialStatus().configured) return { candidates: 0, sent: 0, skipped: "META_CONVERSIONS_ACCESS_TOKEN not set" };

  const since = new Date(Date.now() - LOOKBACK_MS).toISOString();
  const { data: orders } = await supabaseAdmin
    .from("orders")
    .select(ORDER_COLUMNS)
    .eq("payment_status", "paid")
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(200);
  const rows = (orders ?? []) as OrderRow[];
  if (rows.length === 0) return { candidates: 0, sent: 0, skipped: null };

  const { data: ledger } = await supabaseAdmin
    .from("ad_purchase_events_sent")
    .select("order_id, platform, delivered")
    .eq("platform", "meta")
    .in("order_id", rows.map((row) => row.order_id));

  const pending = ordersNeedingMetaPurchase(rows, (ledger ?? []) as { order_id: string; platform: string; delivered: boolean }[]);

  // Slugs and categories for the content ids, resolved once for the batch.
  const productIds = [...new Set(pending.flatMap((order) => (order.order_items ?? []).map((item) => item.product_id)).filter((id): id is string => Boolean(id)))];
  const slugByProductId = new Map<string, string>();
  const categoryByProductId = new Map<string, string>();
  if (productIds.length > 0) {
    const { data: products } = await supabaseAdmin.from("products").select("id, slug, category").in("id", productIds);
    for (const row of (products ?? []) as { id?: string; slug?: string; category?: string }[]) {
      if (row.id && row.slug) slugByProductId.set(row.id, row.slug);
      if (row.id && row.category) categoryByProductId.set(row.id, row.category);
    }
  }

  let sent = 0;
  for (const order of pending.slice(0, SWEEP_BATCH)) {
    const items = order.order_items ?? [];
    const event = buildMetaPurchase(
      {
        orderId: order.order_id,
        isPaid: true,
        amountPaid: Number(order.amount_paid ?? 0),
        items: items.map((item) => ({
          slug: item.product_id ? slugByProductId.get(item.product_id) ?? null : null,
          productId: item.product_id ?? null,
          productName: item.product_name ?? null,
          quantity: item.quantity ?? null,
          unitPrice: item.unit_price ?? null,
        })),
      },
      { categories: items.map((item) => (item.product_id ? categoryByProductId.get(item.product_id) ?? null : null)) },
    );
    if (!event) continue;
    const paidAt = new Date(order.paid_at ?? order.created_at ?? Date.now());
    const described = await sendMetaPurchaseForOrder({
      orderId: order.order_id,
      event,
      order,
      ledger: metaLedger(order.order_id),
      occurredAt: Number.isFinite(paidAt.getTime()) ? paidAt : new Date(),
    });
    if (described?.includes("delivered")) sent += 1;
  }

  return { candidates: pending.length, sent, skipped: null };
}
