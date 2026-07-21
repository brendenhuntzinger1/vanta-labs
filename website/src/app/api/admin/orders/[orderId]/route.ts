import { NextResponse } from "next/server";
import { getRequestIpAddress, getRequestUserAgent, verifyAdminSessionFromRequest } from "@/lib/admin-auth";
import { canManageRefunds } from "@/lib/admin-roles";
import { supabaseAdmin } from "@/lib/supabase-server";
import { sendEmail } from "@/lib/email/send";
import { orderConfirmationTemplate, shippingUpdateTemplate } from "@/lib/email/templates";
import { getPaymentProvider } from "@/lib/payment-provider";
import { updateCommissionOnRefund } from "@/lib/payment-webhook";
import { reverseOrderPoints } from "@/lib/membership";

function roundMoney(value: number) {
  return Math.round(value * 100) / 100;
}

async function getOrderWithItems(orderId: string) {
  const { data, error } = await supabaseAdmin
    .from("orders")
    .select("*, order_items(*)")
    .eq("order_id", orderId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data;
}

function unauthorizedResponse() {
  return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
}

export async function PATCH(request: Request, context: { params: Promise<{ orderId: string }> }) {
  const session = await verifyAdminSessionFromRequest(request);
  if (!session) {
    return unauthorizedResponse();
  }

  const ipAddress = getRequestIpAddress(request);
  const userAgent = getRequestUserAgent(request);

  const { orderId } = await context.params;

  try {
    const body = await request.json() as {
      action?: string;
      paymentStatus?: string;
      fulfillmentStatus?: string;
      trackingNumber?: string;
      note?: string;
      refundAmount?: number;
      carrier?: string;
      estimatedDelivery?: string;
    };

    const action = String(body.action ?? "");
    const now = new Date().toISOString();

    if (action === "update_status") {
      // Changing payment_status directly is a money-integrity action (it can
      // fake revenue or mark an order refunded without reversing commissions
      // and loyalty points), so it is gated to manager+. Fulfillment/tracking
      // fields below remain available to all admins for day-to-day shipping.
      if (body.paymentStatus && !canManageRefunds(session.role)) {
        return NextResponse.json(
          { success: false, error: "Your role does not have permission to change payment status." },
          { status: 403 },
        );
      }

      const updatePayload: Record<string, unknown> = { updated_at: now };
      if (body.paymentStatus) {
        updatePayload.payment_status = String(body.paymentStatus);
      }
      if (body.fulfillmentStatus) {
        updatePayload.fulfillment_status = String(body.fulfillmentStatus);
      }
      if (typeof body.trackingNumber === "string") {
        updatePayload.tracking_number = body.trackingNumber.trim() || null;
      }

      const { error } = await supabaseAdmin
        .from("orders")
        .update(updatePayload)
        .eq("order_id", orderId);

      if (error) {
        throw error;
      }

      const { error: auditError } = await supabaseAdmin
        .from("admin_audit_logs")
        .insert({
          action: "order_update_status",
          target_table: "orders",
          target_id: orderId,
          metadata: {
            paymentStatus: body.paymentStatus ?? null,
            fulfillmentStatus: body.fulfillmentStatus ?? null,
            trackingNumber: typeof body.trackingNumber === "string" ? body.trackingNumber.trim() || null : null,
            performedAt: now,
            performedBy: session.username,
            ipAddress,
            userAgent,
          },
        });

      if (auditError) {
        throw auditError;
      }

      if (body.fulfillmentStatus || typeof body.trackingNumber === "string" || body.carrier || body.estimatedDelivery) {
        const { error: shipmentError } = await supabaseAdmin
          .from("order_shipments")
          .upsert(
            {
              order_id: orderId,
              carrier: body.carrier?.trim() || null,
              tracking_number: typeof body.trackingNumber === "string" ? body.trackingNumber.trim() || null : null,
              shipping_status: body.fulfillmentStatus || "pending",
              estimated_delivery: body.estimatedDelivery || null,
              updated_at: now,
            },
            { onConflict: "order_id" },
          );

        if (shipmentError) {
          throw shipmentError;
        }
      }

      if (body.fulfillmentStatus || typeof body.trackingNumber === "string") {
        try {
          const order = await getOrderWithItems(orderId);
          if (order?.customer_email) {
            const template = shippingUpdateTemplate({
              customerName: String(order.customer_name ?? ""),
              orderId,
              status: String(updatePayload.fulfillment_status ?? order.fulfillment_status ?? "updated"),
              trackingNumber: updatePayload.tracking_number ? String(updatePayload.tracking_number) : undefined,
            });
            await sendEmail({ to: String(order.customer_email), ...template });
          }
        } catch {
          // Non-critical notification; the status update itself already succeeded above.
        }
      }

      return NextResponse.json({ success: true });
    }

    if (action === "refund") {
      if (!canManageRefunds(session.role)) {
        return NextResponse.json({ success: false, error: "Your role does not have permission to issue refunds." }, { status: 403 });
      }

      const order = await getOrderWithItems(orderId);
      if (!order) {
        return NextResponse.json({ success: false, error: "Order not found." }, { status: 404 });
      }

      const amountPaid = roundMoney(Number(order.amount_paid ?? 0));
      const alreadyRefunded = roundMoney(Number(order.refund_amount ?? 0));
      const remaining = roundMoney(Math.max(0, amountPaid - alreadyRefunded));

      if (remaining <= 0) {
        return NextResponse.json({ success: false, error: "This order has already been fully refunded." }, { status: 400 });
      }

      const requestedAmount = typeof body.refundAmount === "number" && Number.isFinite(body.refundAmount)
        ? roundMoney(body.refundAmount)
        : remaining;

      if (requestedAmount <= 0 || requestedAmount > remaining) {
        return NextResponse.json({ success: false, error: `Refund amount must be between $0.01 and $${remaining.toFixed(2)}.` }, { status: 400 });
      }

      const newRefundTotal = roundMoney(alreadyRefunded + requestedAmount);
      const isFullRefund = newRefundTotal >= amountPaid;

      // PaymentProvider.refundPayment() is a stub until a real payment
      // processor is connected - it does not move real money. The database
      // is updated regardless so the store's own records stay accurate; the
      // actual refund must currently be issued through the processor
      // directly until that integration exists.
      try {
        const provider = getPaymentProvider();
        if (order.payment_id) {
          await provider.refundPayment(String(order.payment_id));
        }
      } catch {
        // Provider refund is best-effort until a real processor is wired up.
      }

      const { error } = await supabaseAdmin
        .from("orders")
        .update({
          payment_status: isFullRefund ? "refunded" : "partially_refunded",
          refund_amount: newRefundTotal,
          refunded_at: now,
          updated_at: now,
        })
        .eq("order_id", orderId);
      if (error) {
        throw error;
      }

      await updateCommissionOnRefund(orderId);

      // Only reverses membership points on a full refund - a partial refund
      // leaves earned points untouched rather than pro-rating them.
      if (isFullRefund) {
        try {
          await reverseOrderPoints(orderId);
        } catch {
          // Points reversal must not block the refund itself from completing.
        }
      }

      const { error: auditError } = await supabaseAdmin
        .from("admin_audit_logs")
        .insert({
          action: "order_refund",
          target_table: "orders",
          target_id: orderId,
          metadata: {
            amount: requestedAmount,
            newRefundTotal,
            isFullRefund,
            note: body.note ?? null,
            performedAt: now,
            performedBy: session.username,
            ipAddress,
            userAgent,
          },
        });

      if (auditError) {
        throw auditError;
      }

      return NextResponse.json({ success: true, refundAmount: newRefundTotal, isFullRefund });
    }

    if (action === "cancel" || action === "resend_confirmation" || action === "print_packing_slip") {
      if (action === "cancel") {
        const { error } = await supabaseAdmin
          .from("orders")
          .update({ fulfillment_status: "cancelled", updated_at: now })
          .eq("order_id", orderId);
        if (error) {
          throw error;
        }
      }

      if (action === "resend_confirmation") {
        const order = await getOrderWithItems(orderId);
        if (!order?.customer_email) {
          return NextResponse.json({ success: false, error: "Order has no customer email on file." }, { status: 400 });
        }

        const orderItems = (order.order_items ?? []) as Array<{ product_name?: string; product_id?: string; quantity?: number; line_total?: number }>;
        const template = orderConfirmationTemplate({
          customerName: String(order.customer_name ?? ""),
          orderId,
          items: orderItems.map((item) => ({
            name: item.product_name ?? item.product_id ?? "Item",
            quantity: Number(item.quantity ?? 0),
            lineTotal: roundMoney(Number(item.line_total ?? 0)),
          })),
          subtotal: roundMoney(Number(order.subtotal ?? 0)),
          shipping: roundMoney(Number(order.shipping_amount ?? 0)),
          discount: roundMoney(Number(order.discount_amount ?? 0)),
          total: roundMoney(Number(order.amount_paid ?? 0)),
        });

        const result = await sendEmail({ to: String(order.customer_email), ...template });
        if (!result.success) {
          return NextResponse.json({ success: false, error: result.error ?? "Unable to send confirmation email." }, { status: 500 });
        }
      }

      const { error: auditError } = await supabaseAdmin
        .from("admin_audit_logs")
        .insert({
          action: `order_${action}`,
          target_table: "orders",
          target_id: orderId,
          metadata: {
            note: body.note ?? null,
            performedAt: now,
            performedBy: session.username,
            ipAddress,
            userAgent,
          },
        });

      if (auditError) {
        throw auditError;
      }

      return NextResponse.json({ success: true });
    }

    return NextResponse.json({ success: false, error: "Unknown action" }, { status: 400 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to update order";
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}