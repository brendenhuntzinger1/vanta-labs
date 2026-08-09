import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-server";
import { buildPurchase } from "@/lib/ads/tiktok-events";
import { getOrderAttribution } from "@/lib/order-attribution";
import { credentialStatus, describeResult, sendServerEvents } from "@/lib/ads/tiktok-events-api";
import { getRequestIpAddress } from "@/lib/admin-auth";

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

  const event = buildPurchase({
    orderId: String(order.order_id),
    isPaid,
    amountPaid: Number(order.amount_paid ?? 0),
    items: items.map((item) => ({
      productId: item.product_id ?? null,
      productName: item.product_name ?? null,
      quantity: item.quantity ?? null,
      unitPrice: item.unit_price ?? null,
    })),
  });

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
  let serverDelivery: string | null = null;
  if (event && credentialStatus().configured) {
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
    // Diagnostics only. No token, no customer data — describeResult is built
    // from a fixed field set precisely so this line cannot leak either.
    console.info(`[ads] order ${String(order.order_id)} — ${serverDelivery}`);
  }

  return NextResponse.json(
    { found: true, isPaid, event },
    { headers: { "cache-control": "no-store" } },
  );
}
