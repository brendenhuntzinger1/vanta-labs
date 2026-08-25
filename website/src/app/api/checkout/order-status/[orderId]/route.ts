import { NextResponse } from "next/server";

import { getPaymentMethodsConfig } from "@/lib/admin-control";
import { getPaymentMethodById, isManualPaymentMethod } from "@/lib/payment-methods";
import { checkRateLimit } from "@/lib/rate-limit";
import { resolveShopperIdentity } from "@/lib/express-checkout-service";
import { supabaseAdmin } from "@/lib/supabase-server";

export const dynamic = "force-dynamic";

/**
 * "Has this order been paid yet?"
 *
 * TWO CALLERS, ONE ANSWER.
 *
 *   order-confirmation-status.tsx — already used this to flip "confirming your
 *   payment…" to "confirmed" while the webhook lands. It reads `isPaid` and
 *   `isManual`, and those keys are part of the contract.
 *
 *   the payment page — added after the first real production purchase, where
 *   the card iframe's success callback never fired. The charge succeeded, the
 *   webhook settled the order, and the shopper sat on "Processing…" until they
 *   refreshed by hand. The order was paid the whole time; the browser had no
 *   way to find out. A completion path that depends on someone else's event
 *   firing has no fallback, and this is the fallback.
 *
 * WHAT IT DELIBERATELY DOES NOT RETURN
 *
 * Coarse status and the order number a shopper already has on their receipt.
 * No email, no address, no amount, no line items — the confirmation page is
 * where an order is actually shown, and it masks what it shows there. This must
 * not become a second, weaker way to read an order.
 *
 * AUTHORIZATION
 *
 * The order id is an unguessable UUID acting as a bearer token — the same model
 * the confirmation page and /pay/[orderId] already use. Rate limited per IP so
 * the id space cannot be swept.
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ orderId: string }> },
) {
  const { orderId } = await context.params;

  const { ip } = resolveShopperIdentity(request);
  const rateLimit = await checkRateLimit(`order-status:${ip ?? "unknown"}`, 120, 60);
  if (!rateLimit.allowed) {
    const res = NextResponse.json({ found: false, isPaid: false, paid: false, pending: true }, { status: 429 });
    res.headers.set("Retry-After", String(rateLimit.retryAfterSeconds));
    return res;
  }

  const { data } = await supabaseAdmin
    .from("orders")
    .select("order_number, payment_status, payment_method")
    .eq("order_id", String(orderId ?? "").trim())
    .maybeSingle();

  if (!data) {
    // Unchanged: the confirmation page distinguishes "no such order" from
    // "not paid yet", and a 404 is what it expects.
    return NextResponse.json({ found: false }, { status: 404 });
  }

  const status = String(data.payment_status ?? "").toLowerCase();
  const isPaid = status === "paid" || status === "completed" || status === "succeeded";
  // A terminal failure is not "keep waiting" — the payment page needs to stop
  // polling and let the shopper act.
  const failed = status === "payment_failed" || status === "canceled" || status === "cancelled";

  let isManual = false;
  try {
    const methods = await getPaymentMethodsConfig();
    const method = getPaymentMethodById(methods, data.payment_method ? String(data.payment_method) : null);
    isManual = Boolean(method && isManualPaymentMethod(method));
  } catch {
    /* default to card treatment */
  }

  return NextResponse.json(
    {
      // The original contract, unchanged.
      found: true,
      isPaid,
      isManual,
      status,
      // Added for the payment page. `paid` mirrors `isPaid` rather than
      // replacing it, so neither caller can be broken by the other's needs.
      paid: isPaid,
      pending: !isPaid && !failed,
      orderNumber: isPaid ? (data.order_number ?? null) : null,
    },
    { headers: { "cache-control": "no-store" } },
  );
}
