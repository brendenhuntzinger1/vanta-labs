import "server-only";

import { supabaseAdmin } from "@/lib/supabase-server";
import { recordSystemAlert } from "@/lib/monitoring";
import { enqueueFailedEmail } from "@/lib/email/retry-queue";
import type { OrderEmailKind } from "@/lib/email/order-email-once";
import {
  loadOrderForEmail,
  renderOrderConfirmationFromRecord,
  renderRefundConfirmationFromRecord,
} from "@/lib/email/order-confirmation-render";

/**
 * Release send-once slots stranded at 'sending' (E-03) — AND RE-QUEUE THEM.
 *
 * THE HOLE. `sendOrderEmailOnce` claims the slot BEFORE it calls the provider,
 * which is what makes a duplicate receipt impossible. The claim is only ever
 * resolved by the same invocation writing 'sent' or 'failed' afterwards — so if
 * that invocation never gets there (the lambda is killed mid-send, the process
 * times out, the provider call hangs past the function's budget, the database
 * write after the send fails), the row stays at 'sending' for ever.
 *
 * A 'sending' row is inside the partial unique index, so it holds the slot. The
 * customer never got the email — the send never completed — and no later caller
 * can ever send it, because every one of them is answered with 23505 and returns
 * `already_sent`. The order's confirmation is blocked permanently, and the log
 * says an email is in flight that nothing is carrying.
 *
 * THE REAPER. A claim older than the stale window cannot still be in flight:
 * the whole request that made it is long dead (Vercel's ceiling here is 60s;
 * the window below is fifteen minutes). Moving it to 'failed' is truthful — the
 * attempt did not complete — and it drops the row out of the partial index.
 *
 * RELEASING THE SLOT IS NOT A RETRY. This used to stop at the release and tell
 * the operator "the sweep's email retry will now pick it up". It could not: a
 * strand means the process died between the claim and the enqueue, so
 * pending_emails held no row for it, and every caller of sendOrderEmailOnce
 * sits behind a once-only claim of its own (paid_side_effects_at, the manual
 * approval compare-and-set) that will never re-enter for that order. The slot
 * was free and nothing would ever send into it. So the reaper now re-renders
 * the email from the order row and queues it itself, with the (order, kind)
 * identity attached: the retry sweep sends it under the SAME idempotency key
 * the stranded attempt used — so if the provider did accept the original
 * before the process died, it collapses the second — and closes the slot it
 * satisfies. Bounded attempts and the give-up alert are the queue's.
 *
 * NEVER THROWS. It runs inside the scheduled sweep alongside jobs that matter
 * more; a reaper that takes the sweep down with it would be a worse bug than
 * the one it fixes.
 */

/** How long a claim may sit at 'sending' before it is presumed dead. */
export const STRANDED_AFTER_MINUTES = 15;

export interface ReapedOrderEmails {
  /** Claims released back to the retry paths. */
  released: number;
  /** Of those, re-rendered from the order and queued for the retry sweep. */
  requeued: number;
  /** Released but NOT re-queued — a human has to resend these by hand. */
  unrecoverable: number;
}

const REFUND_PREFIX = "refund_confirmation:";

/**
 * Re-render the stranded email from the order and queue it. True when a
 * pending_emails row now carries it; false when nothing could be built — the
 * order is unreadable, has no address, or the kind is not one this knows how
 * to reproduce. Never throws.
 */
async function requeueStrandedEmail(orderId: string, kind: string): Promise<boolean> {
  try {
    const order = await loadOrderForEmail(orderId);
    const to = String(order?.customer_email ?? "").trim();
    if (!order || !to) return false;

    let template: { subject: string; html: string; text: string } | null = null;
    if (kind === "order_confirmation") {
      template = renderOrderConfirmationFromRecord(order, orderId);
    } else if (kind.startsWith(REFUND_PREFIX)) {
      const cents = Number(kind.slice(REFUND_PREFIX.length));
      if (Number.isFinite(cents) && cents > 0) template = renderRefundConfirmationFromRecord(order, orderId, cents);
    }
    if (!template) return false;

    // One queue row per stranded slot. A row already waiting for this exact
    // (order, kind) — the original path enqueued after a refusal, say — will
    // deliver it; a second would be a second delivery on a provider that does
    // not honour the idempotency key.
    const { data: waiting, error: waitingError } = await supabaseAdmin
      .from("pending_emails")
      .select("id")
      .eq("order_id", orderId)
      .eq("email_kind", kind)
      .eq("status", "pending")
      .limit(1);
    if (!waitingError && (waiting ?? []).length > 0) return true;

    await enqueueFailedEmail(
      { to, subject: template.subject, html: template.html, text: template.text },
      `Send stranded at 'sending' for over ${STRANDED_AFTER_MINUTES} minutes; re-queued by the reaper`,
      { orderId, kind: kind as OrderEmailKind },
    );
    return true;
  } catch (error) {
    console.error("[order-email-reaper] could not re-queue a stranded send", orderId, kind, error);
    return false;
  }
}

export async function reapStrandedOrderEmails(
  staleAfterMinutes = STRANDED_AFTER_MINUTES,
): Promise<ReapedOrderEmails> {
  const cutoff = new Date(Date.now() - staleAfterMinutes * 60_000).toISOString();

  try {
    const { data, error } = await supabaseAdmin
      .from("order_email_log")
      .update({
        status: "failed",
        // Says what happened, so nobody reads this as a provider rejection.
        error: `Stranded at 'sending' for over ${staleAfterMinutes} minutes; slot released for retry`,
        completed_at: new Date().toISOString(),
      })
      .eq("status", "sending")
      .lt("attempted_at", cutoff)
      .select("order_id, kind");

    if (error || !data) return { released: 0, requeued: 0, unrecoverable: 0 };

    const rows = data as Array<{ order_id?: string | null; kind?: string | null }>;
    if (rows.length === 0) return { released: 0, requeued: 0, unrecoverable: 0 };

    const requeued: string[] = [];
    const unrecoverable: string[] = [];
    for (const row of rows) {
      const orderId = String(row.order_id ?? "");
      const kind = String(row.kind ?? "");
      const label = `${orderId || "?"}:${kind || "?"}`;
      const queued = orderId && kind ? await requeueStrandedEmail(orderId, kind) : false;
      (queued ? requeued : unrecoverable).push(label);
    }

    // Operator-visible: a stranded claim means a customer was, until this
    // moment, unable to receive their confirmation at all. Say precisely what
    // happens next — the retry sweep carries what was re-queued, and a human
    // has to resend what was not. Critical only when a human must act.
    await recordSystemAlert({
      type: "order_email_stranded",
      severity: unrecoverable.length > 0 ? "critical" : "warning",
      message:
        `Released ${rows.length} order email send-once slot(s) stranded at 'sending'; those emails were blocked until now. `
        + (requeued.length > 0
          ? `${requeued.length} re-rendered from the order and queued — the sweep's email retry will deliver them. `
          : "")
        + (unrecoverable.length > 0
          ? `${unrecoverable.length} could NOT be re-queued (order unreadable, no address, or an email this cannot rebuild) — `
            + "resend those by hand from the order page: " + unrecoverable.slice(0, 20).join(", ")
          : ""),
      context: {
        orders: rows.map((row) => `${String(row.order_id ?? "?")}:${String(row.kind ?? "?")}`).slice(0, 20),
        orderIds: [...new Set(rows.map((row) => String(row.order_id ?? "")).filter(Boolean))].slice(0, 20),
        requeued: requeued.slice(0, 20),
        unrecoverable: unrecoverable.slice(0, 20),
      },
    }).catch(() => {});

    return { released: rows.length, requeued: requeued.length, unrecoverable: unrecoverable.length };
  } catch {
    // Table not migrated / transient — nothing released this run.
    return { released: 0, requeued: 0, unrecoverable: 0 };
  }
}
