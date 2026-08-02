import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-server";
import { getPaymentMethodsConfig } from "@/lib/admin-control";
import { getPaymentMethodById, isManualPaymentMethod } from "@/lib/payment-methods";

// Lightweight status poll for the order-confirmation page. The order id is an
// unguessable bearer token (same pattern as the confirmation/pay pages), so no
// auth is required — it only ever returns coarse status, never customer data.
// Used to flip "confirming your payment…" to "confirmed" once the processor's
// webhook lands, without the customer refreshing.
export async function GET(_request: Request, context: { params: Promise<{ orderId: string }> }) {
  const { orderId } = await context.params;

  const { data } = await supabaseAdmin
    .from("orders")
    .select("payment_status, payment_method")
    .eq("order_id", orderId)
    .maybeSingle();

  if (!data) {
    return NextResponse.json({ found: false }, { status: 404 });
  }

  const status = String(data.payment_status ?? "").toLowerCase();
  const isPaid = status === "paid";

  let isManual = false;
  try {
    const methods = await getPaymentMethodsConfig();
    const method = getPaymentMethodById(methods, data.payment_method ? String(data.payment_method) : null);
    isManual = Boolean(method && isManualPaymentMethod(method));
  } catch {
    /* default to card treatment */
  }

  return NextResponse.json(
    { found: true, isPaid, isManual, status },
    { headers: { "cache-control": "no-store" } },
  );
}
