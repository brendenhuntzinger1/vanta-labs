import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase-server";
import { isMockPaymentMode } from "@/lib/payment-provider";
import { processPaymentWebhook } from "@/lib/payment-webhook";
import {
  buildMockWebhookRequest,
  resolveMockWebhookSecret,
  type MockOrderSnapshot,
  type MockPaymentOutcome,
} from "@/lib/payment-mock";

export const dynamic = "force-dynamic";

// Internal endpoint behind the fake /pay/mock checkout page. Approving or
// declining a simulated card payment here signs a webhook event and runs it
// through the REAL payment-webhook handler — the exact pipeline a live
// processor callback uses — so a fake payment exercises every downstream
// side-effect (paid state, confirmation email, inventory decrement, ambassador
// commission, points). It is inert unless the store is explicitly running the
// mock gateway (PAYMENT_PROVIDER=mock), so it can never touch production orders.
export async function POST(request: Request) {
  if (!isMockPaymentMode()) {
    return NextResponse.json(
      { success: false, error: "Mock payments are not enabled." },
      { status: 404 },
    );
  }

  try {
    const body = (await request.json()) as { orderId?: string; outcome?: string };
    const orderId = String(body.orderId ?? "").trim();
    const outcome = String(body.outcome ?? "approve").trim() as MockPaymentOutcome;

    if (!orderId) {
      return NextResponse.json({ success: false, error: "Missing order reference." }, { status: 400 });
    }

    if (!["approve", "decline", "cancel", "refund"].includes(outcome)) {
      return NextResponse.json({ success: false, error: "Invalid payment outcome." }, { status: 400 });
    }

    const { data: order, error } = await supabaseAdmin
      .from("orders")
      .select(
        "order_id, payment_id, payment_method, payment_status, customer_email, customer_name, shipping_address, city, postal_code, currency, subtotal, shipping_amount, discount_amount, amount_paid, referral_code, ambassador_id, coupon_code, customer_user_id, points_redeemed, order_items(product_id, product_name, unit_price, quantity, line_total)",
      )
      .eq("order_id", orderId)
      .maybeSingle();

    if (error) {
      throw error;
    }

    if (!order) {
      return NextResponse.json({ success: false, error: "Order not found." }, { status: 404 });
    }

    // The mock gateway only ever stands in for the CARD path; manual methods
    // settle through their own submit-payment / admin-verify flow.
    if (order.payment_method && order.payment_method !== "card") {
      return NextResponse.json(
        { success: false, error: "This order does not use the card payment gateway." },
        { status: 400 },
      );
    }

    if ((outcome === "approve" || outcome === "decline") && order.payment_status === "paid") {
      return NextResponse.json({ success: false, error: "This order has already been paid." }, { status: 400 });
    }

    const items = (order.order_items ?? []) as Array<{
      product_id?: string | null;
      product_name?: string | null;
      unit_price?: number | null;
      quantity?: number | null;
      line_total?: number | null;
    }>;

    const snapshot: MockOrderSnapshot = {
      orderId: String(order.order_id),
      paymentId: order.payment_id ? String(order.payment_id) : `mock_pay_${order.order_id}`,
      customerEmail: order.customer_email ? String(order.customer_email) : null,
      customerName: order.customer_name ? String(order.customer_name) : null,
      shippingAddress: order.shipping_address ? String(order.shipping_address) : null,
      city: order.city ? String(order.city) : null,
      postalCode: order.postal_code ? String(order.postal_code) : null,
      currency: order.currency ? String(order.currency) : "USD",
      subtotal: Number(order.subtotal ?? 0),
      shippingAmount: Number(order.shipping_amount ?? 0),
      discountAmount: Number(order.discount_amount ?? 0),
      amountPaid: Number(order.amount_paid ?? 0),
      referralCode: order.referral_code ? String(order.referral_code) : null,
      ambassadorId: order.ambassador_id ? String(order.ambassador_id) : null,
      couponCode: order.coupon_code ? String(order.coupon_code) : null,
      customerUserId: order.customer_user_id ? String(order.customer_user_id) : null,
      pointsRedeemed: Number(order.points_redeemed ?? 0),
      items: items.map((item) => ({
        productId: item.product_id ?? null,
        productName: item.product_name ?? null,
        unitPrice: Number(item.unit_price ?? 0),
        quantity: Number(item.quantity ?? 0),
        lineTotal: Number(item.line_total ?? 0),
      })),
    };

    const secret = resolveMockWebhookSecret();
    const event = buildMockWebhookRequest(snapshot, outcome, { secret });
    const result = await processPaymentWebhook(event.body, event.signature, secret, event.eventId);

    return NextResponse.json({ success: true, outcome, eventType: event.eventType, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unable to process the simulated payment.";
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}
