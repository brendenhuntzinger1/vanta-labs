import { NextResponse, after } from "next/server";
import { setOrderFulfillmentStatus } from "@/lib/shippo/service";
import { getRequestIpAddress, getRequestUserAgent, verifyAdminSessionFromRequest } from "@/lib/admin-auth";
import { canManageRefunds, canViewProfit } from "@/lib/admin-roles";
import { recordActualShippingCost } from "@/lib/admin-profit";
import { buildCarrierTrackingUrl } from "@/lib/tracking-url";
import { getSiteUrl } from "@/lib/env";
import { supabaseAdmin } from "@/lib/supabase-server";
import { sendEmail } from "@/lib/email/send";
import { deliveryConfirmationTemplate, orderConfirmationTemplate, refundConfirmationTemplate, replacementOrderTemplate, shippingUpdateTemplate } from "@/lib/email/templates";
import { createReplacementOrder } from "@/lib/admin-replacements";
import { syncOrderToShippo } from "@/lib/shippo/order-sync";
import { providerSettlesRefunds, getPaymentProvider } from "@/lib/payment-provider";
import { updateCommissionOnRefund } from "@/lib/payment-webhook";
import { restockInventoryForOrder, claimInventoryRestock } from "@/lib/inventory-fulfillment";
import { restoreRedeemedPoints, reverseOrderPoints } from "@/lib/membership";
import { revokeMembershipForRefund } from "@/lib/membership-billing";
import { refundStoreCreditForOrder } from "@/lib/store-credit";

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
      reason?: string;
      items?: Array<{ itemId?: string | number; quantity?: number }>;
      shippingCostAmount?: number;
      /** Idempotency key for send_replacement — one per confirmation dialog. */
      requestId?: string;
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
        .select("fulfillment_status, tracking_number, payment_status")
        .eq("order_id", orderId)
        .maybeSingle();
      const priorStatus = String(priorOrder?.fulfillment_status ?? "");
      const priorTracking = priorOrder?.tracking_number ? String(priorOrder.tracking_number) : "";

      // Never advance fulfillment (ship/deliver/etc.) on an order that hasn't
      // been paid — otherwise a pending or canceled order would send the
      // customer a shipping email + tracking and goods would leave for an order
      // with no captured payment. Only paid / partially_refunded orders ship.
      const FULFILLMENT_ADVANCE_STATES = new Set(["processing", "shipped", "delivered", "fulfilled", "partially_fulfilled"]);
      const orderPaymentStatus = String(priorOrder?.payment_status ?? "").toLowerCase();
      if (
        body.fulfillmentStatus
        && FULFILLMENT_ADVANCE_STATES.has(String(body.fulfillmentStatus).toLowerCase())
        && orderPaymentStatus !== "paid"
        && orderPaymentStatus !== "partially_refunded"
      ) {
        return NextResponse.json(
          { success: false, error: "This order can't be marked for fulfillment until its payment is verified." },
          { status: 400 },
        );
      }

      // fulfillment_status is DELIBERATELY not in this payload any more.
      //
      // It used to be written here by a raw UPDATE that never consulted
      // order-pipeline.ts, so this route could set any status from any state —
      // including `delivered`, which the pipeline reserves for the carrier —
      // and it wrote no order_status_history row, leaving operator changes
      // invisible in the customer-facing timeline. The payment guard above is
      // kept as defence in depth: the pipeline validates transitions, not
      // whether the money arrived.
      const updatePayload: Record<string, unknown> = { updated_at: now };
      if (body.paymentStatus) {
        updatePayload.payment_status = String(body.paymentStatus);
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

      // The status change goes through the same writer the bulk action and the
      // Shippo webhook use. Tracking is saved FIRST so that if this transition
      // triggers a shipping email, the tracking number is already on the row.
      if (body.fulfillmentStatus) {
        const transition = await setOrderFulfillmentStatus({
          orderId,
          to: String(body.fulfillmentStatus),
          source: "admin",
          actor: session.username,
        });
        if (!transition.ok) {
          // A refusal is the pipeline doing its job — report its sentence
          // verbatim rather than a generic failure, so the operator learns why.
          return NextResponse.json({ success: false, error: transition.message }, { status: 400 });
        }
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
            // Quote the reference the CUSTOMER holds, not the internal key.
            // `orderId` here is the route parameter — a raw `order-<uuid>` that
            // appears nowhere in their receipt and cannot be quoted to support.
            // The Shippo-driven emails and the order confirmation both use the
            // order number already; this is the path that did not.
            const orderReference = String(order.order_number ?? "") || orderId;
            // A transition to "delivered" gets the dedicated delivery
            // confirmation; every other shipping transition (and tracking
            // changes) uses the generic shipping-update email.
            const template = newStatus.toLowerCase() === "delivered"
              ? deliveryConfirmationTemplate({
                  customerName: String(order.customer_name ?? ""),
                  orderId: orderReference,
                })
              : shippingUpdateTemplate({
                  customerName: String(order.customer_name ?? ""),
                  orderId: orderReference,
                  status: String(updatePayload.fulfillment_status ?? order.fulfillment_status ?? "updated"),
                  carrier,
                  trackingNumber,
                  // Carrier link, or the customer's own Vanta Labs order list.
                  // Previously fell back to a Google search for the tracking
                  // number, which is not a link to put in a customer email.
                  trackingUrl:
                    buildCarrierTrackingUrl(carrier, trackingNumber)
                    ?? `${getSiteUrl()}/account/orders`,
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

      // Idempotency with the processor webhook: a refund/chargeback that already
      // arrived via webhook sets payment_status to "refunded" and ran the
      // reversal side-effects (restock, points/credit clawback) WITHOUT
      // necessarily writing refund_amount. Guard on the status too, so an admin
      // clicking "refund" after a webhook refund can't double-restock stock and
      // double-reverse points/credit.
      if (String(order.payment_status) === "refunded") {
        return NextResponse.json({ success: false, error: "This order has already been fully refunded." }, { status: 400 });
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

      // NO MONEY MOVES HERE. LivePaymentProvider.refundPayment() is a no-op
      // stub -- the processor has no refund integration. This call is kept so
      // the seam exists for when one is added, but it must never be mistaken
      // for a settlement: everything below records the refund in Vanta's own
      // books, and the money itself has to be sent from the processor by hand.
      let providerRefunded = false;
      try {
        const provider = getPaymentProvider();
        if (order.payment_id) {
          await provider.refundPayment(String(order.payment_id));
          providerRefunded = providerSettlesRefunds();
        }
      } catch {
        // Best-effort. A failure changes nothing today, because success does
        // not move money either.
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

      // Reduce the ambassador commission in proportion to how much of the
      // MERCHANDISE (commissionable) value was refunded — NOT gross amount_paid.
      // Commission is earned only on discounted merchandise, so measuring the
      // refund against the gross total (which includes shipping/handling/tax/
      // card fee) under-reverses when a customer returns all their goods but not
      // shipping. Treat a refund as merchandise-first: a full merchandise return
      // fully voids the commission; a shipping/fee-only refund can't exceed it.
      const commissionableBase = roundMoney(
        Math.max(0, Number(order.subtotal ?? 0) - Number(order.discount_amount ?? 0)),
      );
      const merchandiseRefunded = Math.min(newRefundTotal, commissionableBase);
      const refundedFraction = commissionableBase > 0
        ? Math.min(1, merchandiseRefunded / commissionableBase)
        : 1;
      await updateCommissionOnRefund(orderId, { refundedFraction });

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
        // A fully-refunded MEMBERSHIP order ends the membership immediately so
        // its benefits stop (member pricing, free shipping, points, etc.).
        try {
          if (String(order.order_type ?? "product") === "membership" && order.customer_user_id) {
            await revokeMembershipForRefund(String(order.customer_user_id));
          }
        } catch {
          // Best-effort; never block the refund.
        }
        // Return the committed stock to the catalog on a full refund of a
        // physical order (membership orders hold no inventory).
        try {
          // Share the SAME atomic restock claim as the webhook path so an admin
          // refund racing the processor's refund webhook (or a double-click)
          // restocks exactly once — never twice.
          if (String(order.order_type ?? "product") !== "membership" && await claimInventoryRestock(orderId)) {
            await restockInventoryForOrder(
              (order.order_items ?? []) as Array<{ product_id?: string | null; quantity?: number | null }>,
            );
          }
        } catch {
          // Best-effort; never block the refund.
        }
      }

      // The customer is told only when money has ACTUALLY been sent.
      //
      // This email says "Your refund has been processed". Sending it while the
      // processor integration is a stub tells a customer to expect money that
      // is not coming: they wait, nothing arrives, and the next thing that
      // happens is a chargeback -- which costs more than the refund and is
      // reported against the merchant account.
      //
      // Vanta's own records are still updated above, because the owner needs
      // them; announcing it is a separate act, and it waits for the money.
      if (order.customer_email && providerRefunded) {
        const refundEmail = refundConfirmationTemplate({
          customerName: String(order.customer_name ?? ""),
          orderId: String(order.order_number ?? orderId),
          refundAmount: requestedAmount,
          isFullRefund,
        });
        void sendEmail({ to: String(order.customer_email), ...refundEmail });
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
            // Whether money actually left. False today for every refund.
            providerRefunded,
            performedAt: now,
            performedBy: session.username,
            ipAddress,
            userAgent,
          },
        });

      if (auditError) {
        throw auditError;
      }

      // The admin is told, in the response, exactly what did and did not happen.
      // "Refunded" on a screen with no money moved is how a customer ends up
      // waiting for a payment nobody sent.
      return NextResponse.json({
        success: true,
        refundAmount: newRefundTotal,
        isFullRefund,
        providerRefunded,
        customerNotified: providerRefunded,
        message: providerRefunded
          ? "Refund issued and the customer has been emailed."
          : "Recorded in Vanta only — NO money has been sent. Issue this refund in your payment processor, then tell the customer.",
      });
    }

    // One-click replacement shipment (damaged / lost / stolen — the Shipping
    // Protection promise). Creates a linked $0 order, queues it for shipping,
    // audits who sent it and why, and emails the customer.
    if (action === "send_replacement") {
      if (!canManageRefunds(session.role)) {
        return NextResponse.json({ success: false, error: "Your role cannot send replacements." }, { status: 403 });
      }

      const reasonRaw = String(body.reason ?? "").toLowerCase();
      const reason = (["damaged", "lost", "stolen", "other"] as const).find((r) => r === reasonRaw);
      if (!reason) {
        return NextResponse.json({ success: false, error: "Pick a replacement reason." }, { status: 400 });
      }

      const replacement = await createReplacementOrder({
        originalOrderId: orderId,
        reason,
        // The duplicate guard. One id per confirmation dialog, so a double-click
        // or a retried fetch resolves to the SAME replacement instead of a
        // second parcel with a second label and stock deducted twice.
        requestId: typeof body.requestId === "string" ? body.requestId : null,
        note: typeof body.note === "string" ? body.note : null,
        selections: Array.isArray(body.items)
          ? body.items
              .map((item) => ({ itemId: String(item?.itemId ?? ""), quantity: Number(item?.quantity ?? 1) }))
              .filter((item) => item.itemId)
          : null,
      });

      // Push the replacement to Shippo now rather than leaving it to the
      // half-hourly sweep. A replacement is already a late parcel -- it exists
      // because the first one failed -- and the sweep would collect it
      // eventually, which is the wrong speed for the one order the customer is
      // actively waiting on. Same after() pattern as the payment webhook, so a
      // slow Shippo cannot delay this response.
      try {
        after(async () => {
          try {
            await syncOrderToShippo(replacement.orderId);
          } catch (syncError) {
            console.error("Unable to sync replacement to Shippo", replacement.orderId, syncError);
          }
        });
      } catch {
        // No request scope. The sweep still picks it up.
      }

      const { error: auditError } = await supabaseAdmin
        .from("admin_audit_logs")
        .insert({
          action: "order_replacement",
          target_table: "orders",
          target_id: orderId,
          metadata: {
            reason,
            note: typeof body.note === "string" ? body.note.slice(0, 300) : null,
            replacementOrderId: replacement.orderId,
            replacementOrderNumber: replacement.orderNumber,
            items: replacement.items,
            performedAt: now,
            performedBy: session.username,
            ipAddress,
            userAgent,
          },
        });
      if (auditError) {
        console.error("Unable to audit replacement", auditError);
      }

      // Best-effort customer email — a mail hiccup never blocks the reship.
      if (replacement.customerEmail) {
        try {
          const original = await getOrderWithItems(orderId);
          const template = replacementOrderTemplate({
            customerName: replacement.customerName ?? "",
            originalOrderNumber: original?.order_number ? String(original.order_number) : orderId,
            replacementOrderNumber: replacement.orderNumber,
            items: replacement.items,
          });
          await sendEmail({ to: replacement.customerEmail, ...template });
        } catch (emailError) {
          console.error("Unable to send replacement email", emailError);
        }
      }

      return NextResponse.json({
        success: true,
        replacementOrderId: replacement.orderId,
        replacementOrderNumber: replacement.orderNumber,
      });
    }

    if (action === "cancel" || action === "resend_confirmation") {
      if (action === "cancel") {
        // CANCELLATION IS A TRANSITION, NOT A FIELD WRITE.
        //
        // This used to be a raw UPDATE, which meant an admin could cancel an
        // order the carrier had already delivered — reproduced before this
        // change: delivered, in_transit, shipped and refunded all accepted a
        // cancel, each leaving zero history rows. FULFILLMENT_TRANSITIONS
        // reaches `cancelled` only from awaiting_payment, paid,
        // ready_to_fulfill and packed, and says why: "No cancel after shipping:
        // the goods are gone, so the honest outcomes are a refund or a return."
        //
        // Routing through the canonical writer applies that rule, records the
        // change in order_status_history, and returns the pipeline's own
        // sentence when it refuses.
        const cancelled = await setOrderFulfillmentStatus({
          orderId,
          to: "cancelled",
          source: "admin",
          actor: session.username,
        });
        if (!cancelled.ok) {
          return NextResponse.json({ success: false, error: cancelled.message }, { status: 400 });
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
          orderId: order.order_number ? String(order.order_number) : orderId,
          items: orderItems.map((item) => ({
            name: item.product_name ?? item.product_id ?? "Item",
            quantity: Number(item.quantity ?? 0),
            lineTotal: roundMoney(Number(item.line_total ?? 0)),
          })),
          subtotal: roundMoney(Number(order.subtotal ?? 0)),
          shipping: roundMoney(Number(order.shipping_amount ?? 0)),
          discount: roundMoney(Number(order.discount_amount ?? 0)),
          tax: roundMoney(Number(order.tax_amount ?? 0)),
          cardProcessingFee: roundMoney(Number(order.card_processing_fee ?? 0)),
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

    // Enter or correct the EXACT shipping-label cost for an order. This replaces
    // the estimate, flips the order's profit to Finalized, and records an audit
    // row (estimate, exact cost, profit before/after). Gated to profit-viewers
    // since it directly changes reported net profit.
    if (action === "set_shipping_cost") {
      if (!canViewProfit(session.role)) {
        return NextResponse.json({ success: false, error: "Your role cannot edit profit figures." }, { status: 403 });
      }
      const amount = Number(body.shippingCostAmount);
      if (!Number.isFinite(amount) || amount < 0 || amount > 10000) {
        return NextResponse.json({ success: false, error: "Enter a shipping cost between $0 and $10,000." }, { status: 400 });
      }

      const result = await recordActualShippingCost({
        orderId,
        amountCents: Math.round(amount * 100),
        source: "manual",
        changedBy: session.username,
      });
      if (!result.ok) {
        return NextResponse.json({ success: false, error: result.error ?? "Unable to record shipping cost." }, { status: 400 });
      }

      const { error: auditError } = await supabaseAdmin
        .from("admin_audit_logs")
        .insert({
          action: "order_set_shipping_cost",
          target_table: "orders",
          target_id: orderId,
          metadata: {
            shippingCost: roundMoney(amount),
            performedAt: now,
            performedBy: session.username,
            ipAddress,
            userAgent,
          },
        });
      if (auditError) {
        // The cost + its own audit row already persisted; the admin_audit_logs
        // entry is secondary, so don't fail the request over it.
        console.error("Unable to audit shipping cost update", auditError);
      }

      return NextResponse.json({ success: true });
    }

    return NextResponse.json({ success: false, error: "Unknown action" }, { status: 400 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to update order";
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}