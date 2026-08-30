import { NextResponse, after } from "next/server";
import { setOrderFulfillmentStatus } from "@/lib/shippo/service";
import { getRequestIpAddress, getRequestUserAgent, verifyAdminSessionFromRequest } from "@/lib/admin-auth";
import { canManageRefunds, canViewProfit } from "@/lib/admin-roles";
import { recordActualShippingCost } from "@/lib/admin-profit";
import { buildCarrierTrackingUrl } from "@/lib/tracking-url";
import { getSiteUrl } from "@/lib/env";
import { supabaseAdmin } from "@/lib/supabase-server";
import { sendEmail } from "@/lib/email/send";
import { enqueueFailedEmail } from "@/lib/email/retry-queue";
import { getBusinessSettings } from "@/lib/admin-control";
import { deliveryConfirmationTemplate, orderConfirmationTemplate, reimbursementRecordedTemplate, replacementOrderTemplate, shippingUpdateTemplate } from "@/lib/email/templates";
import { createReplacementOrder } from "@/lib/admin-replacements";
import { syncOrderToShippo } from "@/lib/shippo/order-sync";
import { refundedMerchandiseFraction, updateCommissionOnRefund } from "@/lib/payment-webhook";
import { restoreRedeemedPoints, reverseOrderPoints } from "@/lib/membership";
import { revokeMembershipForRefund } from "@/lib/membership-billing";
import { refundStoreCreditForOrder } from "@/lib/store-credit";
import { pointsToDollars } from "@/lib/points-math";
import { recordSystemAlert } from "@/lib/monitoring";

function roundMoney(value: number) {
  return Math.round(value * 100) / 100;
}

/**
 * Run one refund side-effect on the ADMIN MANUAL-REIMBURSEMENT lane, and make a
 * failure reach a person.
 *
 * `NOT_SWEPT` names the effects nothing else will ever retry, so the alert can
 * say whether a human has to act now or whether the sweep will pick it up.
 */
const NOT_SWEPT = new Set(["membership_revocation"]);

async function runRefundEffect(
  effect: string,
  orderId: string,
  run: () => Promise<unknown>,
): Promise<void> {
  try {
    await run();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error("Admin refund side-effect failed", effect, orderId, detail);
    const swept = !NOT_SWEPT.has(effect);
    await recordSystemAlert({
      type: "admin_refund_effect_failed",
      severity: "critical",
      message:
        `A reimbursement was recorded for order ${orderId} but its ${effect} did not complete. `
        + (swept
          ? "The refund repair sweep will retry it; check that it clears."
          : "NOTHING retries this one — the customer keeps member pricing, free shipping and their "
            + "points multiplier until it is revoked by hand."),
      context: { orderId, effect, detail, retriedAutomatically: swept },
    }).catch((alertError) => {
      console.error("Unable to record an admin refund effect alert", alertError);
    });
  }
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
      /**
       * Record postage on an order whose label was voided. Only ever set by a
       * human who knows the carrier DECLINED the void refund — see the refusal
       * in recordActualShippingCost.
       */
      overrideVoidedLabel?: boolean;
      /** Idempotency key for send_replacement — one per confirmation dialog. */
      requestId?: string;
    /** How the owner already sent the money: zelle | cashapp | other. */
    reimbursementMethod?: string;
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
      // What the status ACTUALLY became, straight from the writer.
      //
      // The notification block below used to read it off `updatePayload`, which
      // stopped carrying fulfillment_status when the write moved here — so
      // `newStatus` was always the PRIOR status, `statusTransitioned` was always
      // false, and the "delivered" branch was unreachable. Marking an order
      // shipped from the order page could not send a shipping email at all; the
      // only surviving trigger was a tracking number changing, and
      // setOrderFulfillmentStatus sends nothing itself.
      let transitionedTo: string | null = null;
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
        // `from`/`to` come from the pipeline, so re-saving the same status is a
        // no-op here exactly as it is there — no duplicate "your order shipped".
        transitionedTo = transition.data.from === transition.data.to ? null : transition.data.to;
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
      const newStatus = transitionedTo ?? priorStatus;
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
                  status: String(transitionedTo ?? order.fulfillment_status ?? "updated"),
                  carrier,
                  trackingNumber,
                  // Carrier link, or the customer's own Vanta Labs order list.
                  // Previously fell back to a Google search for the tracking
                  // number, which is not a link to put in a customer email.
                  trackingUrl:
                    buildCarrierTrackingUrl(carrier, trackingNumber)
                    ?? `${getSiteUrl()}/account/orders`,
                });
            // QUEUED ON FAILURE, NOT DROPPED.
            //
            // sendEmail is documented never to throw — it returns
            // { success: false }. So the catch below was unreachable, the result
            // was discarded, and a provider refusal left no trace: nothing
            // queued, nothing logged, no alert. And because the status has
            // already advanced by now, notificationFor() returns null for every
            // later carrier scan, so no subsequent event regenerates this
            // message. One transient outage cost the customer their tracking
            // email for good.
            //
            // The Shippo-webhook sibling queues these same two templates for
            // exactly that reason; this path is now the same.
            const result = await sendEmail({ to: String(order.customer_email), ...template });
            if (!result.success) {
              console.error(
                `[admin/orders] ${newStatus} notification failed for ${orderId}: ${result.error ?? "unknown error"}`,
              );
              // No order context: `email_kind` is the send-once vocabulary for
              // confirmations and refunds, and a shipping update is neither.
              // The Shippo-webhook sibling queues these same two templates the
              // same way.
              await enqueueFailedEmail({ to: String(order.customer_email), ...template }, result.error);
            }
          }
        } catch (notifyError) {
          // The status update itself already succeeded, so this must not fail
          // the request — but it must not be silent either, which is the whole
          // point of the block above.
          console.error("[admin/orders] status notification failed", notifyError);
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

      // STORE CREDIT AND POINTS ARE TENDER, AND THEY ARE REFUNDABLE.
      //
      // This gate used to be `remaining <= 0 -> "already fully refunded"`, which
      // is a statement about CASH. An order the customer settled entirely with
      // store credit has `amount_paid` 0, so it hit that branch on the very
      // first attempt: the admin was told an order had already been refunded
      // when nothing had been, and the customer's credit could never be
      // returned. Both redemptions come off the same columns the profit engine
      // reads as contra-revenue, through the one exported points rate rather
      // than a local copy of it.
      const nonCashTender = roundMoney(
        Math.max(0, Number(order.store_credit_redeemed_cents ?? 0)) / 100
        + Math.max(0, pointsToDollars(Number(order.points_redeemed ?? 0))),
      );
      const cashAvailable = remaining > 0;

      if (!cashAvailable && nonCashTender <= 0) {
        return NextResponse.json({ success: false, error: "This order has already been fully refunded." }, { status: 400 });
      }

      const requestedAmount = typeof body.refundAmount === "number" && Number.isFinite(body.refundAmount)
        ? roundMoney(body.refundAmount)
        : (cashAvailable ? remaining : 0);

      if (cashAvailable) {
        if (requestedAmount <= 0 || requestedAmount > remaining) {
          return NextResponse.json({ success: false, error: `Refund amount must be between $0.01 and $${remaining.toFixed(2)}.` }, { status: 400 });
        }
      } else if (requestedAmount !== 0) {
        // Recording cash returned on an order that collected none would
        // overstate refunds and drive reported revenue below zero on an order
        // that never took a payment.
        return NextResponse.json({
          success: false,
          error: `This order collected no cash — only the $${nonCashTender.toFixed(2)} of store credit and points can be returned. `
            + "Send the refund with no amount to return them.",
        }, { status: 400 });
      }

      const newRefundTotal = roundMoney(alreadyRefunded + requestedAmount);
      // A CREDIT-SETTLED ORDER IS FULLY REFUNDED AT ZERO CASH: `amount_paid` is
      // 0, so 0 >= 0. That is what runs the non-cash reversals below.
      const isFullRefund = newRefundTotal >= amountPaid;
      /** Non-cash tender this refund actually hands back. Only a full refund does. */
      const nonCashReturned = isFullRefund ? nonCashTender : 0;
      /** Whether any MONEY moved. Nothing may tell the customer it did if not. */
      const cashSent = requestedAmount > 0;

      // HOW the owner sent it, from a fixed list. Free text is not accepted so
      // nobody can paste an account number or a handle into the audit trail.
      const REIMBURSEMENT_METHODS = ["zelle", "cashapp", "other"] as const;
      const rawMethod = String(body.reimbursementMethod ?? "other").toLowerCase();
      const reimbursementMethod = REIMBURSEMENT_METHODS.find((m) => m === rawMethod) ?? "other";

      // THE PAYMENT PROCESSOR IS NOT CONTACTED. AT ALL.
      //
      // This used to call provider.refundPayment() "so the seam exists". The
      // seam is a liability on this path: the money for a manual return has
      // ALREADY been sent by the owner, by hand, outside the processor. Asking
      // the processor to refund the same order would, the moment a real refund
      // integration is wired up behind that method, pay the customer a second
      // time — and the code doing it would look deliberate.
      //
      // A future card-refund flow is a DIFFERENT action, not this one. Recording
      // a manual reimbursement never touches an external payment API, and the
      // test that proves it watches a live provider object rather than deleting
      // it, so "we never call it" cannot be confused with "it isn't there".
      const providerRefunded = false;

      // COMPARE-AND-SET: the write only lands while refund_amount is still the
      // value this request read. A double-click, a second tab, a retried fetch
      // and two admins clicking at once all read the SAME `alreadyRefunded`, so
      // exactly one of them matches and the rest update ZERO rows and stop.
      //
      // Recording a reimbursement twice would double-deduct revenue, double-
      // reverse the ambassador's commission and email the customer twice for
      // one payment — and unlike a card refund there is no processor-side
      // record to reconcile it against afterwards.
      //
      // `alreadyRefunded` is compared as the raw stored value rather than the
      // rounded one so the filter matches what is actually in the column.
      const priorRefundValue = order.refund_amount ?? null;
      const claimBuilder = supabaseAdmin
        .from("orders")
        .update({
          payment_status: isFullRefund ? "refunded" : "partially_refunded",
          refund_amount: newRefundTotal,
          refunded_at: now,
          updated_at: now,
        })
        .eq("order_id", orderId)
        // PAYMENT_STATUS IS PART OF THE CLAIM, and it carries the whole claim on
        // a credit-settled order: there `newRefundTotal` equals `alreadyRefunded`
        // (both 0), so the refund_amount filter below matches on a second
        // request too and would return the credit twice. The status moved to
        // "refunded" on the first, so exactly one request can win.
        .eq("payment_status", String(order.payment_status ?? ""));
      // NULL and 0 are different filters in SQL, and getting it wrong here does
      // not fail loudly — it silently matches nothing, so NO reimbursement
      // could ever be recorded. The column is `not null default 0` in the
      // migration, but an order row written before that migration (or by any
      // path that never set it) can still hold NULL, so both are handled.
      const { data: claimed, error } = await (priorRefundValue === null
        ? claimBuilder.is("refund_amount", null)
        : claimBuilder.eq("refund_amount", priorRefundValue)
      ).select("id");
      if (error) {
        throw error;
      }
      if (!claimed || claimed.length === 0) {
        return NextResponse.json({
          success: false,
          error: "This reimbursement was already recorded. Reload the order to see the current total.",
        }, { status: 409 });
      }

      // Reduce the ambassador commission in proportion to how much of the
      // MERCHANDISE (commissionable) value was refunded — NOT gross amount_paid.
      // Commission is earned only on discounted merchandise, so measuring the
      // refund against the gross total (which includes shipping/handling/tax/
      // card fee) under-reverses when a customer returns all their goods but not
      // shipping. Treat a refund as merchandise-first: a full merchandise return
      // fully voids the commission; a shipping/fee-only refund can't exceed it.
      //
      // AND AGAINST EVERYTHING RETURNED, NOT JUST THE CASH. `newRefundTotal` is
      // capped at the cash `amount_paid`, so a credit-settled order that came
      // back in its entirety measured a refunded fraction of 0 and left the
      // ambassador the whole commission on merchandise the store got back.
      const commissionableBase = roundMoney(
        Math.max(0, Number(order.subtotal ?? 0) - Number(order.discount_amount ?? 0)),
      );
      const refundedFraction = refundedMerchandiseFraction({
        commissionableBase,
        cashRefunded: newRefundTotal,
        nonCashReturned,
      });
      await updateCommissionOnRefund(orderId, { refundedFraction });

      // Only reverse membership points and re-credit spent store credit on a
      // full refund - a partial refund leaves earned points untouched rather
      // than pro-rating them.
      if (isFullRefund) {
        // BEST-EFFORT IS NOT THE SAME AS UNRECORDED.
        //
        // These four were bare `catch {}` — no log, no alert, nobody told. The
        // reimbursement claim above is single-use, so a swallowed failure here
        // is PERMANENT on this lane: the money went back and the effect never
        // ran. It is the identical defect class this branch exists to close,
        // on the one lane nothing else covers. Two of the four are swept
        // (reverseOrderPoints and restoreRedeemedPoints by the refund sweep,
        // which selects on ledger absence) — but only because the claim above
        // sets payment_status and refunded_at, so the sweep can see the order.
        // refundStoreCreditForOrder is swept too. revokeMembershipForRefund is
        // NOT swept by anything, so a refunded member silently keeps member
        // pricing, free shipping and their points multiplier until a human
        // notices.
        //
        // Still non-blocking: the reimbursement is already recorded and
        // throwing here would report a completed refund as a failure. The
        // change is that every one of them now reaches an operator.
        await runRefundEffect("points_reversal", orderId, () => reverseOrderPoints(orderId));
        // Give back the points the customer spent on this order, since the
        // discount those points bought is being fully undone.
        await runRefundEffect("points_restore", orderId, () => restoreRedeemedPoints(orderId));
        await runRefundEffect("store_credit_refund", orderId, () => refundStoreCreditForOrder(orderId));
        // A fully-refunded MEMBERSHIP order ends the membership immediately so
        // its benefits stop (member pricing, free shipping, points, etc.).
        if (String(order.order_type ?? "product") === "membership" && order.customer_user_id) {
          await runRefundEffect(
            "membership_revocation",
            orderId,
            () => revokeMembershipForRefund(String(order.customer_user_id)),
          );
        }
        // INVENTORY IS NOT RESTOCKED HERE, DELIBERATELY.
        //
        // This action records a reimbursement the owner has ALREADY sent by
        // hand, at the end of a manual return: the customer emailed, the return
        // was authorised, a vial came back, and it was inspected. Whether that
        // vial is sellable again is a physical judgement about a physical
        // object — seal intact, stored correctly, still in date — and nothing
        // in this request knows the answer.
        //
        // Restocking on the strength of a money record would put a vial that
        // may have spent a week in a mailbox back on the shelf automatically,
        // and the next customer would buy it. Phantom stock also oversells:
        // the unit is countable but not shippable.
        //
        // So the safe direction is to leave stock alone. The owner adjusts the
        // count in admin → Inventory if, and only if, the returned unit is
        // genuinely resaleable — an explicit, audited act.
        //
        // The processor-driven refund/chargeback path in payment-webhook.ts is
        // UNCHANGED and still restocks behind claimInventoryRestock(): that one
        // covers an order the customer never received (a failed or cancelled
        // order whose goods never left), which is a different situation.
      }

      // The customer is told because the owner has ALREADY sent the money.
      //
      // This is the one path where announcing it is safe: the workflow is
      // "reimburse the customer externally, THEN record it here", so by the
      // time this runs the payment has happened. The wording says the
      // reimbursement was processed — never that it went back to their card,
      // which would be false and is how a customer ends up waiting for money
      // that is not coming and filing a chargeback instead.
      //
      // Sent exactly once because it is inside the branch that WON the
      // compare-and-set above: a duplicate request never reaches this line.
      let customerNotified = false;
      // ONLY WHEN MONEY ACTUALLY MOVED. The template says a reimbursement was
      // processed; on a credit-settled order none was, and "$0.00 reimbursement
      // processed" is a false statement to a customer whose credit has instead
      // gone back onto their balance where they can see it.
      if (cashSent && order.customer_email) {
        const reimbursementEmail = reimbursementRecordedTemplate({
          customerName: String(order.customer_name ?? ""),
          orderId: String(order.order_number ?? orderId),
          amount: requestedAmount,
          supportEmail: (await getBusinessSettings().catch(() => null))?.supportEmail,
        });
        const sent = await sendEmail({ to: String(order.customer_email), ...reimbursementEmail });
        customerNotified = sent.success;
        if (!sent.success) {
          await enqueueFailedEmail(
            { to: String(order.customer_email), subject: reimbursementEmail.subject, html: reimbursementEmail.html, text: reimbursementEmail.text },
            sent.error,
          );
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
            // What came back that was never cash, so the audit row explains a
            // $0.00 reimbursement rather than looking like a no-op.
            nonCashReturned,
            note: body.note ?? null,
            // How the owner actually sent the money, for the audit trail. The
            // METHOD is recorded; no handle, account or credential is.
            reimbursementMethod: reimbursementMethod,
            customerNotified,
            // Vanta never moves money on this path. Kept as an explicit false
            // so the audit row says so rather than leaving it to be inferred.
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
        customerNotified,
        nonCashReturned,
        message: !cashSent
          ? `No cash reimbursement was recorded — this order collected none. The $${nonCashReturned.toFixed(2)} of store credit and points has been returned to the customer's balance.`
          : customerNotified
            ? "Reimbursement recorded. Vanta did not send any money — the customer has been emailed to confirm the payment you already made."
            : "Reimbursement recorded. Vanta did not send any money. The confirmation email could not be sent and has been queued for retry.",
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
      //
      // But the OUTCOME is reported, because the admin panel used to state
      // flatly that "the customer has been emailed" on every replacement. The
      // await here discarded its EmailSendResult, and the catch below is dead
      // for send failures: email/send.ts returns { success: false } rather than
      // throwing. So a bounced or unconfigured send left the operator told the
      // customer knew about their reship when nothing had gone out and nothing
      // was queued. Same shape as the reimbursement path above.
      let customerNotified = false;
      let customerEmailQueued = false;
      if (replacement.customerEmail) {
        try {
          const original = await getOrderWithItems(orderId);
          const template = replacementOrderTemplate({
            customerName: replacement.customerName ?? "",
            originalOrderNumber: original?.order_number ? String(original.order_number) : orderId,
            replacementOrderNumber: replacement.orderNumber,
            items: replacement.items,
          });
          const sent = await sendEmail({ to: replacement.customerEmail, ...template });
          customerNotified = sent.success;
          if (!sent.success) {
            console.error("Replacement email not sent for order", orderId, sent.error);
            await enqueueFailedEmail(
              { to: replacement.customerEmail, subject: template.subject, html: template.html, text: template.text },
              sent.error,
            );
            customerEmailQueued = true;
          }
        } catch (emailError) {
          console.error("Unable to send replacement email", emailError);
        }
      }

      return NextResponse.json({
        success: true,
        replacementOrderId: replacement.orderId,
        replacementOrderNumber: replacement.orderNumber,
        customerNotified,
        // Distinguished from a plain failure so the panel does not promise a
        // retry for an order that has no address to retry to.
        customerEmailQueued,
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

        // The stock comes back inside setOrderFulfillmentStatus, which is the
        // sole writer of this transition and therefore the only place the
        // restock cannot be forgotten. It used to be called here, and here
        // ONLY — so the bulk action and the status dropdown one row over
        // cancelled orders and wrote off their units in silence.
        //
        // The pre-carrier reasoning that used to sit here was also wrong:
        // FULFILLMENT_TRANSITIONS allows label_purchased -> cancelled, and the
        // chokepoint handles that case by alerting rather than inventing stock.
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

      // A voided label's postage is refused by default, because the automated
      // paths must never re-charge a refund. A human who knows the carrier
      // declined that refund can say so explicitly, and only explicitly.
      const overrideVoidedLabel = body.overrideVoidedLabel === true;
      const result = await recordActualShippingCost({
        orderId,
        amountCents: Math.round(amount * 100),
        source: "manual",
        changedBy: session.username,
        overrideVoidedLabel,
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
            // An override charges profit for a label the system believes was
            // refunded. It is a deliberate human act and the audit says so.
            ...(overrideVoidedLabel ? { overrodeVoidedLabel: true } : {}),
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