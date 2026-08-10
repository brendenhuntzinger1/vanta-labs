import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-server";
import { buildPurchase } from "@/lib/ads/tiktok-events";
import { buildSnapPurchase } from "@/lib/ads/snap-events";
import { getOrderAttribution } from "@/lib/order-attribution";
import { credentialStatus, describeResult, sendServerEvents } from "@/lib/ads/tiktok-events-api";
import { getRequestIpAddress, verifyAdminSessionFromCookie } from "@/lib/admin-auth";

/**
 * The authoritative source for a Purchase event.
 *
 * The browser never decides whether an order was paid. It asks here, and this
 * reads the order's own `payment_status` and `amount_paid` — the same settled
 * figures the confirmation page and the card statement use — and returns a
 * fully-built event or nothing at all. A pending, failed, abandoned, cancelled
 * or manual-but-unpaid order yields `null`, so there is no path by which
 * reaching a thank-you URL can produce a conversion.
 *
 * Read-only. It writes nothing, touches no commerce logic, and is separate from
 * `/api/checkout/order-status` on purpose: that endpoint deliberately returns
 * coarse status and no customer data, and widening it for advertising would be
 * the wrong trade.
 *
 * Auth follows the existing pattern for this order id — it is an unguessable
 * bearer token, and the confirmation page already renders this same total to
 * anyone holding the link.
 */
export async function GET(request: Request, context: { params: Promise<{ orderId: string }> }) {
  const { orderId } = await context.params;

  // `?inspect=1` answers "what would this order report?" without reporting it.
  //
  // It exists because the honest way to test a Purchase is to place a real
  // paid order, and after paying for that test you should be able to read the
  // resulting event — its value, its content ids, its event id — rather than
  // infer it. Sending on inspection would defeat the point twice over: a
  // duplicate conversion, and a check that changes what it measures.
  const inspect = new URL(request.url).searchParams.get("inspect") === "1";

  // A measurement endpoint must never fail loudly on a customer's confirmation
  // page. If the lookup cannot be made, the honest answer is "no event" — the
  // one thing it must never do is guess that a purchase happened.
  let order: Record<string, unknown> | null = null;
  try {
    const { data } = await supabaseAdmin
      .from("orders")
      .select("order_id, payment_status, amount_paid, customer_email, order_items(product_id, product_name, quantity, unit_price)")
      .eq("order_id", orderId)
      .maybeSingle();
    order = data as Record<string, unknown> | null;
  } catch {
    return NextResponse.json({ found: false, event: null }, { status: 200, headers: { "cache-control": "no-store" } });
  }

  if (!order) {
    return NextResponse.json({ found: false, event: null }, { status: 404, headers: { "cache-control": "no-store" } });
  }

  const isPaid = String(order.payment_status ?? "").toLowerCase() === "paid";
  const items = (order.order_items ?? []) as Array<{
    product_id?: string | null;
    product_name?: string | null;
    quantity?: number | null;
    unit_price?: number | null;
  }>;

  // Orders store the product's database id; every other event in the funnel
  // identifies a product by its catalogue slug. Sending the id here would give
  // the purchase a content id that matches nothing that preceded it, so TikTok
  // would see products that are viewed and never bought alongside products that
  // are bought and never viewed.
  //
  // Looked up separately rather than joined into the order query above: that
  // query is the one that decides whether a conversion is reported at all, and
  // it is working. A failure here degrades to the product id, which is still a
  // real, non-empty identifier — never to a product name, which is not an id.
  const slugByProductId = new Map<string, string>();
  const productIds = [...new Set(items.map((item) => item.product_id).filter((id): id is string => Boolean(id)))];
  if (productIds.length > 0) {
    try {
      const { data: products } = await supabaseAdmin.from("products").select("id, slug").in("id", productIds);
      for (const row of (products ?? []) as { id?: string; slug?: string }[]) {
        if (row.id && row.slug) slugByProductId.set(row.id, row.slug);
      }
    } catch {
      /* fall through to the product id */
    }
  }

  // Both platforms are built from ONE paid order, read once. There is exactly
  // one place on this page that decides a purchase happened, and adding a
  // second ad network must not add a second opinion about it.
  const paidOrder = {
    orderId: String(order.order_id),
    isPaid,
    amountPaid: Number(order.amount_paid ?? 0),
    items: items.map((item) => ({
      slug: item.product_id ? slugByProductId.get(item.product_id) ?? null : null,
      productId: item.product_id ?? null,
      productName: item.product_name ?? null,
      quantity: item.quantity ?? null,
      unitPrice: item.unit_price ?? null,
    })),
  };
  const event = buildPurchase(paidOrder);
  const snapPurchase = buildSnapPurchase(paidOrder);

  // Server-side Purchase, sent with the SAME event_id the browser uses so
  // TikTok collapses the pair into one conversion. It is gated on exactly the
  // same condition as the browser event — `event` is non-null only when the
  // order's own payment_status is 'paid' and a positive amount settled — so
  // there is no path where a confirmation-page visit, a pending order or a
  // failed payment produces one.
  //
  // Worth being clear about what this does and does not fix: it survives an ad
  // blocker or a browser that closes before the pixel flushes, because the
  // request originates here. It does NOT fire for a customer who never opens
  // the confirmation page — closing that gap needs a reconciliation job over
  // paid orders, which needs the ads schema applied.
  //
  // Idempotency beyond TikTok's own window: TikTok collapses identical
  // (event_source_id, event, event_id) for 48 hours, but a confirmation link
  // re-opened on day three would land as a brand-new conversion. A one-row
  // ledger keyed on the order makes the send permanent.
  //
  // If the ledger table does not exist yet the send still proceeds — an
  // occasional duplicate that TikTok itself collapses is a far better failure
  // than silently never reporting real revenue.
  let alreadySent = false;
  try {
    const { data: sent } = await supabaseAdmin
      .from("ad_purchase_events_sent")
      .select("order_id")
      .eq("order_id", String(order.order_id))
      .maybeSingle();
    alreadySent = Boolean(sent);
  } catch {
    /* table not applied yet — fall through and send */
  }

  if (inspect) {
    // Admin-gated: it returns the customer's order value and line items, which
    // the anonymous bearer-token path above deliberately keeps to the single
    // order in the URL. Checked here rather than at the top so an unauthorised
    // caller with a valid order id gets the normal behaviour, not a 401.
    const session = await verifyAdminSessionFromCookie();
    if (!session) return NextResponse.json({ error: "admin session required" }, { status: 401 });
    return NextResponse.json(
      {
        orderId: String(order.order_id),
        paymentStatus: order.payment_status ?? null,
        isPaid,
        amountPaid: Number(order.amount_paid ?? 0),
        wouldReport: Boolean(event),
        alreadySent,
        eventsApiConfigured: credentialStatus().configured,
        event: event ? { name: event.name, eventId: event.eventId, properties: event.properties } : null,
        snapPurchase,
        // The reason an unpaid order reports nothing, stated rather than implied.
        reason: event
          ? null
          : isPaid
            ? "Paid, but no positive amount settled — a zero-value purchase is not reported."
            : `payment_status is "${String(order.payment_status ?? "unknown")}", so this is not a conversion.`,
      },
      { status: 200, headers: { "cache-control": "no-store" } },
    );
  }

  let serverDelivery: string | null = null;
  if (event && !alreadySent && credentialStatus().configured) {
    const attribution = await getOrderAttribution(String(order.order_id)).catch(() => null);
    const outcome = await sendServerEvents([
      {
        event: "Purchase",
        eventId: event.eventId,
        occurredAt: new Date(),
        user: {
          email: order.customer_email ? String(order.customer_email) : null,
          // Click id carried from the ad click through to the order by the
          // Step 1 attribution layer. Null for an organic order, and null is
          // correct — never substitute anything.
          ttclid: attribution?.last?.ttclid ?? attribution?.first?.ttclid ?? null,
          ip: getRequestIpAddress(request) ?? null,
          userAgent: request.headers.get("user-agent"),
        },
        properties: {
          contents: event.properties.contents,
          currency: event.properties.currency,
          value: event.properties.value,
          order_id: String(order.order_id),
        },
      },
    ]);
    serverDelivery = describeResult(outcome);

    // Recorded whatever the outcome, so a hard TikTok rejection is not retried
    // on every page refresh. `delivered` distinguishes the two for later repair.
    try {
      await supabaseAdmin.from("ad_purchase_events_sent").upsert(
        {
          order_id: String(order.order_id),
          event_id: event.eventId,
          platform: "tiktok",
          delivered: outcome.delivered,
          tiktok_code: outcome.tiktokCode,
        },
        { onConflict: "order_id" },
      );
    } catch {
      /* ledger unavailable; TikTok's own 48h dedup still applies */
    }
    // Diagnostics only. No token, no customer data — describeResult is built
    // from a fixed field set precisely so this line cannot leak either.
    console.info(`[ads] order ${String(order.order_id)} — ${serverDelivery}`);
  }

  return NextResponse.json(
    { found: true, isPaid, event, snapPurchase },
    { headers: { "cache-control": "no-store" } },
  );
}
