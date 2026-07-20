import { NextResponse } from "next/server";
import { getRequestIpAddress, getRequestUserAgent, verifyAdminSessionFromRequest } from "@/lib/admin-auth";
import { canManageRefunds } from "@/lib/admin-roles";
import { supabaseAdmin } from "@/lib/supabase-server";
import { finalizeManualPayment } from "@/lib/payment-webhook";
import { sendEmail } from "@/lib/email/send";
import { manualPaymentReceivedTemplate, manualPaymentRejectedTemplate, orderConfirmationTemplate } from "@/lib/email/templates";
import { getSiteUrl } from "@/lib/env";

function roundMoney(value: number) {
  return Math.round(value * 100) / 100;
}

function unauthorizedResponse() {
  return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
}

async function getOrder(orderId: string) {
  const { data, error } = await supabaseAdmin
    .from("orders")
    .select("*, order_items(*)")
    .eq("order_id", orderId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function writeAudit(input: {
  action: string;
  orderId: string;
  metadata: Record<string, unknown>;
}) {
  await supabaseAdmin.from("admin_audit_logs").insert({
    action: input.action,
    target_table: "orders",
    target_id: input.orderId,
    metadata: input.metadata,
  });
}

// Admin payment verification: approve / mark paid / reject / resend email for
// a manual payment order. Gated to roles that can manage refunds (money-ish
// actions). Approving reuses the exact card-webhook paid side effects via
// finalizeManualPayment and moves the order to awaiting_fulfillment.
export async function PATCH(request: Request, context: { params: Promise<{ orderId: string }> }) {
  const session = await verifyAdminSessionFromRequest(request);
  if (!session) {
    return unauthorizedResponse();
  }

  if (!canManageRefunds(session.role)) {
    return NextResponse.json({ success: false, error: "Your role does not have permission to verify payments." }, { status: 403 });
  }

  const { orderId } = await context.params;
  const ipAddress = getRequestIpAddress(request);
  const userAgent = getRequestUserAgent(request);
  const now = new Date().toISOString();

  try {
    const body = (await request.json()) as { action?: string; reason?: string };
    const action = String(body.action ?? "");

    if (action === "approve" || action === "mark_paid") {
      const result = await finalizeManualPayment(orderId, { verifiedBy: session.username });
      await writeAudit({
        action: `payment_${action}`,
        orderId,
        metadata: { alreadyPaid: result.alreadyPaid, performedBy: session.username, performedAt: now, ipAddress, userAgent },
      });
      return NextResponse.json({ success: true, alreadyPaid: result.alreadyPaid });
    }

    if (action === "reject") {
      const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 500) : "";
      const order = await getOrder(orderId);
      if (!order) {
        return NextResponse.json({ success: false, error: "Order not found." }, { status: 404 });
      }
      if (order.payment_status === "paid") {
        return NextResponse.json({ success: false, error: "A paid order can't be rejected. Issue a refund instead." }, { status: 400 });
      }

      const { error } = await supabaseAdmin
        .from("orders")
        .update({
          payment_status: "payment_rejected",
          rejection_reason: reason || null,
          payment_rejected_at: now,
          updated_at: now,
        })
        .eq("order_id", orderId);
      if (error) throw error;

      if (order.customer_email) {
        const orderNumber = String(order.order_number ?? order.order_id);
        const template = manualPaymentRejectedTemplate({
          customerName: String(order.customer_name ?? ""),
          orderNumber,
          reason: reason || undefined,
          resubmitUrl: `${getSiteUrl()}/pay/${orderId}`,
        });
        await sendEmail({ to: String(order.customer_email), ...template });
      }

      await writeAudit({
        action: "payment_reject",
        orderId,
        metadata: { reason: reason || null, performedBy: session.username, performedAt: now, ipAddress, userAgent },
      });
      return NextResponse.json({ success: true });
    }

    if (action === "resend_email") {
      const order = await getOrder(orderId);
      if (!order?.customer_email) {
        return NextResponse.json({ success: false, error: "Order has no customer email on file." }, { status: 400 });
      }
      const orderNumber = String(order.order_number ?? order.order_id);

      // Paid → resend the order confirmation; otherwise resend the
      // "payment received / verifying" notice.
      const template =
        order.payment_status === "paid"
          ? orderConfirmationTemplate({
              customerName: String(order.customer_name ?? ""),
              orderId: orderNumber,
              items: ((order.order_items ?? []) as Array<{ product_name?: string; product_id?: string; quantity?: number; line_total?: number }>).map((item) => ({
                name: item.product_name ?? item.product_id ?? "Item",
                quantity: Number(item.quantity ?? 0),
                lineTotal: roundMoney(Number(item.line_total ?? 0)),
              })),
              subtotal: roundMoney(Number(order.subtotal ?? 0)),
              shipping: roundMoney(Number(order.shipping_amount ?? 0)),
              discount: roundMoney(Number(order.discount_amount ?? 0)),
              total: roundMoney(Number(order.amount_paid ?? 0)),
            })
          : manualPaymentReceivedTemplate({
              customerName: String(order.customer_name ?? ""),
              orderNumber,
              amount: Number(order.amount_paid ?? 0),
              paymentMethod: String(order.payment_method ?? ""),
            });

      const result = await sendEmail({ to: String(order.customer_email), ...template });
      if (!result.success) {
        return NextResponse.json({ success: false, error: result.error ?? "Unable to send email." }, { status: 500 });
      }

      await writeAudit({
        action: "payment_resend_email",
        orderId,
        metadata: { performedBy: session.username, performedAt: now, ipAddress, userAgent },
      });
      return NextResponse.json({ success: true });
    }

    return NextResponse.json({ success: false, error: "Unknown action" }, { status: 400 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to update payment.";
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}
