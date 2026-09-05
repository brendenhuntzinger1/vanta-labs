import "server-only";

import { sendEmail } from "@/lib/email/send";
import type { EmailTemplate } from "@/lib/email/types";
import { supabaseAdmin } from "@/lib/supabase-server";

/**
 * Send a transactional email about an order EXACTLY ONCE, and leave a record.
 *
 * TWO PROBLEMS, ONE PLACE.
 *
 * 1. NOTHING RECORDED THAT A RECEIPT WAS SENT. Cart recovery and membership
 *    welcome write to email_send_log; order confirmations wrote nowhere. After
 *    the second real production purchase the question "did the customer get
 *    their confirmation?" could only be answered from ABSENCE of evidence — no
 *    error in the platform log, no row in pending_emails, email enabled with a
 *    provider configured. That reasoning is sound and it is not a record. It
 *    cannot be shown to a customer, it cannot settle a chargeback, and it
 *    expires with log retention.
 *
 * 2. NOTHING BUT CONVENTION STOPPED A SECOND SEND. The webhook already gates
 *    the confirmation behind the atomic paid_side_effects_at claim, and that
 *    guard demonstrably works — the conditional update is visible in
 *    production. But it is one caller's discipline, not a property of the
 *    system: a second code path, or two callers racing through the claim in
 *    the same instant, would each send. The unique index behind this function
 *    makes a duplicate impossible regardless of who asks.
 *
 * ORDER OF OPERATIONS. The slot is claimed BEFORE the provider is called, not
 * after. Recording afterwards leaves a window in which two callers both send
 * and only then discover each other, which is precisely the failure being
 * prevented — by then the customer has two receipts.
 *
 * A FAILED SEND RELEASES THE SLOT. 'failed' rows fall outside the partial
 * unique index, so a genuine retry (the pending_emails sweep, or a later
 * webhook) can still get the receipt out. Every attempt stays on the record
 * rather than the last one overwriting the rest.
 *
 * IT NEVER THROWS, AND IT NEVER BLOCKS A RECEIPT ON ITS OWN BOOKKEEPING. If the
 * table is missing (migration not applied) the email is sent anyway, unlogged.
 * A customer not receiving their receipt because an audit table was absent
 * would be a far worse bug than the one this fixes.
 */

/**
 * Which email about an order this is — and therefore which send-once slot it
 * claims, since the unique index is on (order_id, kind).
 *
 * REFUNDS CARRY THE AMOUNT IN THE KIND, receipts do not. An order has exactly
 * one confirmation, so 'order_confirmation' is a complete identity. It has as
 * many refund notices as there are refunds: two-step refunds (goods, then
 * shipping) are ordinary practice here — see the cumulative-refund handling in
 * payment-webhook — and each states a different amount, so each is a DIFFERENT
 * email the customer must receive. Keyed on the bare kind, the second one would
 * be swallowed as a duplicate and the customer would be refunded in silence.
 * Keyed on the cumulative amount, a re-delivered event for the same refund still
 * collapses (same total, same slot) while a genuinely new refund total sends.
 */
export type OrderEmailKind =
  | "order_confirmation"
  | `order_confirmation_resend:${number}`
  | "refund_confirmation"
  | `refund_confirmation:${number}`
  // Membership money emails ride the same once-per-order slot, keyed on the
  // membership order the charge booked (membership-billing.ts).
  | "membership_signup_receipt"
  | "membership_renewal_receipt";

/**
 * The send-once identity of a DELIBERATE admin resend of the receipt.
 *
 * An admin clicking "resend confirmation" wants a second copy sent, so it
 * cannot share the original's slot or the original's provider idempotency key
 * — both would swallow it as the duplicate they exist to prevent. It cannot be
 * unlogged either, which is what it was: the one path that reached the
 * provider with no order_email_log row, no idempotency key and no queue on
 * failure. So each intentional resend gets its own numbered slot: the first
 * click takes `order_confirmation_resend:1`, the next `:2`, and so on.
 *
 * Two clicks landing in the same instant both compute the same number and one
 * of them is refused by the unique index — which is exactly the double-click
 * debounce the customer wants. A click a moment later, after the first has
 * settled, finds a higher number and goes out.
 *
 * If the log cannot be read the number is the current minute, so the send is
 * still attempted and a double-click still collapses at the provider.
 */
export async function nextOrderConfirmationResendKind(orderId: string): Promise<OrderEmailKind> {
  const prefix = "order_confirmation_resend:";
  try {
    const { data, error } = await supabaseAdmin
      .from("order_email_log")
      .select("kind")
      .eq("order_id", orderId)
      .in("status", ["sending", "sent"]);
    if (error || !data) throw error ?? new Error("unreadable");
    let highest = 0;
    for (const row of data as Array<{ kind?: string | null }>) {
      const kind = String(row.kind ?? "");
      if (!kind.startsWith(prefix)) continue;
      const n = Number(kind.slice(prefix.length));
      if (Number.isFinite(n) && n > highest) highest = n;
    }
    return `${prefix}${highest + 1}` as OrderEmailKind;
  } catch {
    return `${prefix}${Math.floor(Date.now() / 60_000)}` as OrderEmailKind;
  }
}

/**
 * The send-once identity of a refund confirmation: the kind plus the CUMULATIVE
 * amount refunded, in cents, which is the figure the email itself states.
 *
 * Cents because the slot is a string equality test and dollars are a float —
 * 20.1 + 0.2 must not produce a different slot than 20.3.
 */
export function refundEmailKind(cumulativeRefundAmount: number): OrderEmailKind {
  return `refund_confirmation:${Math.round(Number(cumulativeRefundAmount) * 100)}`;
}

export interface OrderEmailOutcome {
  /** True when this call actually handed a message to the provider. */
  attempted: boolean;
  /** True when the provider accepted it. */
  sent: boolean;
  /** Set when another caller already holds or completed this slot. */
  skippedReason?: "already_sent";
  error?: string;
  providerMessageId?: string;
}

/** `j***@domain.com` — enough to confirm the right person, never the address. */
export function maskRecipient(email: string): string {
  const [local, domain] = String(email).split("@");
  if (!domain) return "***";
  return `${local.slice(0, 1)}${"*".repeat(Math.max(3, local.length - 1))}@${domain}`;
}

function isMissingTable(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  const message = String(error.message ?? "").toLowerCase();
  return (
    error.code === "PGRST205" ||
    error.code === "42P01" ||
    message.includes("order_email_log") ||
    message.includes("does not exist") ||
    message.includes("schema cache")
  );
}

export async function sendOrderEmailOnce(input: {
  orderId: string;
  kind: OrderEmailKind;
  to: string;
  template: EmailTemplate;
}): Promise<OrderEmailOutcome> {
  const { orderId, kind, to, template } = input;

  // ---- Claim the slot -------------------------------------------------------
  let claimId: number | null = null;
  let logging = true;
  try {
    const { data, error } = await supabaseAdmin
      .from("order_email_log")
      .insert({
        order_id: orderId,
        kind,
        status: "sending",
        recipient_masked: maskRecipient(to),
      })
      .select("id")
      .maybeSingle();

    if (error) {
      // 23505 — the partial unique index rejected us. Someone else is sending
      // this exact email, or already has. Not an error: the desired end state
      // (the customer has one receipt) is being reached by someone else.
      if (error.code === "23505") {
        return { attempted: false, sent: false, skippedReason: "already_sent" };
      }
      if (!isMissingTable(error)) {
        // Any other database problem must not cost the customer their receipt.
        console.error("[order-email] could not claim a send slot", orderId, kind, error.message);
      }
      logging = false;
    } else {
      claimId = (data as { id?: number } | null)?.id ?? null;
      if (claimId === null) logging = false;
    }
  } catch (claimError) {
    // The doc above promises this function never blocks a receipt on its own
    // bookkeeping, and that promise has to hold for a THROW as well as for a
    // returned error — an unexpected client shape, a transport failure, a table
    // that vanished. Anything unhandled here would propagate into the paid
    // side-effects block, whose catch would swallow it, and the customer would
    // silently lose their receipt to an audit-table problem.
    console.error("[order-email] send-once bookkeeping unavailable; sending unlogged", orderId, kind, claimError);
    logging = false;
  }

  // ---- Send -----------------------------------------------------------------
  // Keyed on the order and the kind — the same identity the claim row uses, so
  // our guard and the provider's agree on what "the same email" means.
  const result = await sendEmail({ to, ...template, idempotencyKey: `${kind}:${orderId}` });

  // ---- Record the outcome ---------------------------------------------------
  if (logging && claimId !== null) {
    try {
      await supabaseAdmin
        .from("order_email_log")
        .update({
          status: result.success ? "sent" : "failed",
          provider: result.provider ?? null,
          provider_message_id: result.providerMessageId ?? null,
          // Truncated: a provider's rejection text is useful, unbounded text in
          // a log table is not.
          error: result.success ? null : String(result.error ?? "").slice(0, 500),
          completed_at: new Date().toISOString(),
        })
        .eq("id", claimId);
    } catch (updateError) {
      // The email's fate is already decided; only the record is at risk.
      console.error("[order-email] sent but could not record the outcome", orderId, kind, updateError);
    }
  }

  return {
    attempted: true,
    sent: result.success,
    error: result.success ? undefined : result.error,
    providerMessageId: result.providerMessageId,
  };
}
