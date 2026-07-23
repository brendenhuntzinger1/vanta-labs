import { NextResponse } from "next/server";
import { getRequestIpAddress, getRequestUserAgent, verifyAdminSessionFromRequest } from "@/lib/admin-auth";
import { canManageRefunds } from "@/lib/admin-roles";
import { supabaseAdmin } from "@/lib/supabase-server";
import { sendEmail } from "@/lib/email/send";
import { orderConfirmationTemplate, shippingUpdateTemplate } from "@/lib/email/templates";
import { getPaymentProvider } from "@/lib/payment-provider";
import { updateCommissionOnRefund } from "@/lib/payment-webhook";
import { restoreRedeemedPoints, reverseOrderPoints } from "@/lib/membership";
import { refundStoreCreditForOrder } from "@/lib/store-credit";

function roundMoney(value: number) {
  return Math.round(value * 100) / 100;
}

// Build a clickable carrier tracking URL from the carrier name + tracking
// number so shipping emails can render a working "Track Package" button.
// Unknown carriers fall back to a Google-based lookup rather than no link.
function buildTrackingUrl(carrier: string | null | undefined, trackingNumber: string | null | undefined): string | undefined {
  const tn = (trackingNumber ?? "").trim();
  if (!tn) return undefined;
  const key = (carrier ?? "").trim().toLowerCase();
  const encoded = encodeURIComponent(tn);
  if (key.includes("usps")) return `https://tools.usps.com/go/TrackConfirmAction?tLabels=${encoded}`;
  if (key.includes("ups")) return `https://www.ups.com/track?tracknum=${encoded}`;
  if (key.includes("fedex")) return `https://www.fedex.com/fedextrack/?trknbr=${encoded}`;
  if (key.includes("dhl")) return `https://www.dhl.com/us-en/home/tracking.html?tracking-id=${encoded}`;
  return `https://www.google.com/search?q=${encoded}`;
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

      // Money-state transitions must go through their dedicated flows so the
      // side-effects run: marking an order paid awards commissions/points and
      // sends the confirmation email (payment verification action), and refunds
      // reverse commissions, claw back points, and issue store credit (the
      // "refund" action below). Setting these here would only change the column
      // and silently skip all of that, so they are rejected.
      const MONEY_STATE_STATUSES = new Set(["paid", "refunded", "partially_refunded"]);
      if (body.paymentStatus && MONEY_STATE_STATUSES.has(String(body.paymentStatus).toLowerCase())) {
        return NextResponse.json(
          {
            success: false,
            error: "To mark an order paid or refunded, use the payment verification or refund action so commissions, points, and store credit are handled correctly.",
          },
          { status: 400 },
        );
      }

      // Snapshot the pre-update state so the shipping email below only fires on
      // an actual transition, not on every save of the admin form.
      const { data: priorOrder } = await supabaseAdmin
        .from("orders")
        .select("fulfillment_status, tracking_number")
        .eq("order_id", orderId)
        .maybeSingle();
      const priorStatus = String(priorOrder?.fulfillment_status ?? "");
      const priorTracking = priorOrder?.tracking_number ? String(priorOrder.tracking_number) : "";

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

      // Only notify the customer when something they'd care about actually
      // changed: the fulfillment status moved to a new customer-facing shipping
      // state (shipped / out for delivery / delivered), or a tracking number
      // was newly added or changed. Re-saving the same values sends nothing, so
      // there are no duplicate "your order shipped" emails.
      const NOTIFY_STATUSES = new Set(["shipped", "out_for_delivery", "delivered"]);
      const newStatus = String(updatePayload.fulfillment_status ?? priorStatus);
      const newTracking = updatePayload.tracking_number !== undefined
        ? (updatePayload.tracking_number ? String(updatePayload.tracking_number) : "")
        : priorTracking;
      const statusTransitioned = newStatus !== priorStatus && NOTIFY_STATUSES.has(newStatus.toLowerCase());
      const trackingAddedOrChanged = newTracking !== "" && newTracking !== priorTracking;

      if (statusTransitioned || trackingAddedOrChanged) {
        try {
          const order = await getOrderWithItems(orderId);
          if (order?.customer_email) {
            const trackingNumber = newTracking || undefined;
            const carrier = body.carrier?.trim() || undefined;
            const template = shippingUpdateTemplate({
              customerName: String(order.customer_name ?? ""),
              orderId,
              status: String(updatePayload.fulfillment_status ?? order.fulfillment_status ?? "updated"),
              carrier,
              trackingNumber,
              trackingUrl: buildTrackingUrl(carrier, trackingNumber),
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

      // Reduce the ambassador commission in proportion to how much of the order
      // value was refunded (cumulative). A full refund voids it; a partial
      // refund keeps commission on the retained portion.
      await updateCommissionOnRefund(orderId, {
        refundedFraction: amountPaid > 0 ? newRefundTotal / amountPaid : 1,
      });

      // Only reverse membership points and re-credit spent store credit on a
      // full refund - a partial refund leaves earned points untouched rather
      // than pro-rating them.
      if (isFullRefund) {
        try {
          await reverseOrderPoints(orderId);
        } catch {
          // Points reversal must not block the refund itself from completing.
        }
        try {
          // Give back the points the customer spent on this order, since the
          // discount those points bought is being fully undone.
          await restoreRedeemedPoints(orderId);
        } catch {
          // Best-effort; never block the refund.
        }
        try {
          await refundStoreCreditForOrder(orderId);
        } catch {
          // Store-credit re-credit is best-effort; never block the refund.
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