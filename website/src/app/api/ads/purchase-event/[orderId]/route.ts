import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-server";
import { buildPurchase } from "@/lib/ads/tiktok-events";

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
export async function GET(_request: Request, context: { params: Promise<{ orderId: string }> }) {
  const { orderId } = await context.params;

  // A measurement endpoint must never fail loudly on a customer's confirmation
  // page. If the lookup cannot be made, the honest answer is "no event" — the
  // one thing it must never do is guess that a purchase happened.
  let order: Record<string, unknown> | null = null;
  try {
    const { data } = await supabaseAdmin
      .from("orders")
      .select("order_id, payment_status, amount_paid, order_items(product_id, product_name, quantity, unit_price)")
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

  return NextResponse.json(
    { found: true, isPaid, event },
    { headers: { "cache-control": "no-store" } },
  );
}
