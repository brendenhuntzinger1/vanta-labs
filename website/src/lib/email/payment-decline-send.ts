import "server-only";

import { supabaseAdmin } from "@/lib/supabase-server";
import { getSiteUrl } from "@/lib/env";
import { sendOrderEmailOnce } from "@/lib/email/order-email-once";
import { paymentDeclinedTemplate } from "@/lib/email/templates";
import { shouldSendDeclineRecovery, declineRecoveryReason } from "@/lib/email/payment-decline-recovery";

/**
 * Tell a customer whose card was declined that they can still finish.
 *
 * THE LEAK (production, 2026-09-09): $2,444.00 of orders reached
 * payment_failed against $1,085.21 ever paid, $1,813.24 of it from customers
 * who never returned, and not one recovery email had ever been sent for a
 * failed payment. The abandoned-cart sweep meanwhile had sent 85 messages to
 * people who only added to a cart. This closes the gap at the deepest point of
 * the funnel anyone reaches without buying.
 *
 * IT RE-READS THE ORDER rather than trusting what the caller hands it. That is
 * what makes it safe to call from more than one place in the webhook, and it
 * removes any way for a caller to mail the wrong person by passing stale data.
 *
 * IT NEVER THROWS. It runs inside the payment webhook, whose real work —
 * recording the failed payment — has already succeeded by the time this is
 * reached. An exception here would fail that envelope and make the processor
 * redeliver the whole thing.
 *
 * ONE PER ORDER. sendOrderEmailOnce claims a slot in order_email_log behind a
 * unique index, so a replayed processor event, a retried webhook and a second
 * decline on the same order all collapse into the one message.
 */
export async function sendPaymentDeclineRecovery(orderId: string): Promise<void> {
  try {
    const id = String(orderId ?? "").trim();
    if (!id) return;

    const { data: order, error } = await supabaseAdmin
      .from("orders")
      .select("order_id, order_number, customer_email, customer_name, amount_paid, payment_status, payment_failure_kind, order_type")
      .eq("order_id", id)
      .maybeSingle();

    if (error || !order) return;

    const eligible = shouldSendDeclineRecovery({
      paymentStatus: order.payment_status as string | null,
      failureKind: order.payment_failure_kind as string | null,
      orderType: order.order_type as string | null,
      customerEmail: order.customer_email as string | null,
    });

    if (!eligible) {
      // Logged rather than silent: "why did nobody get an email" is a question
      // somebody asks eventually, and the rule states its own answer.
      console.info(
        "[payment-decline] no recovery email for order",
        id,
        declineRecoveryReason({
          paymentStatus: order.payment_status as string | null,
          failureKind: order.payment_failure_kind as string | null,
          orderType: order.order_type as string | null,
          customerEmail: order.customer_email as string | null,
        }),
      );
      return;
    }

    // The order's own retry page. The order UUID is the bearer token, which is
    // the pattern that page already documents for the hosted-checkout return.
    const retryUrl = `${getSiteUrl()}/pay/${encodeURIComponent(String(order.order_id))}`;

    const template = paymentDeclinedTemplate({
      name: String(order.customer_name ?? ""),
      orderNumber: String(order.order_number ?? order.order_id ?? ""),
      amountCents: Math.round((Number(order.amount_paid) || 0) * 100),
      retryUrl,
    });

    const outcome = await sendOrderEmailOnce({
      orderId: id,
      kind: "payment_declined",
      to: String(order.customer_email),
      template,
    });

    if (outcome.attempted && !outcome.sent) {
      console.error("[payment-decline] recovery email not sent for order", id, outcome.error);
    }
  } catch (error) {
    // Best-effort by design — see the note above about not failing the webhook.
    console.error("[payment-decline] unexpected failure for order", orderId, error);
  }
}
