import { supabaseAdmin } from "@/lib/supabase-server";
import { sendEmail } from "@/lib/email/send";
import { recordSystemAlert } from "@/lib/monitoring";
import type { EmailTemplate } from "@/lib/email/types";
import type { OrderEmailKind } from "@/lib/email/order-email-once";

// Durable retry for TRANSACTIONAL emails (receipts, shipping notices). A
// transactional send that fails (provider outage) is enqueued here and drained
// by the cron sweep with exponential backoff, so a receipt is never silently
// lost. Marketing email is NOT queued (it has its own suppression flow).

const MAX_ATTEMPTS = 5;

type QueuedEmail = { to: string; replyTo?: string } & EmailTemplate;

/**
 * Which send-once slot this queued email belongs to, when the caller knows.
 *
 * C-02. `order_email_log` releases a slot on a FAILED send so a retry can still
 * get the receipt out. That is only safe if whoever completes the retry closes
 * the slot again — and the sweep could not, because `pending_emails` held no
 * order id. It delivered the receipt, left the log row at 'failed', and the next
 * caller claimed the released slot and sent a second one.
 */
export interface QueuedEmailContext {
  orderId: string;
  kind: OrderEmailKind;
}

/** True for "this column/table is not in the schema", not for a real failure. */
function isMissingSchema(error: { code?: string; message?: string } | null | undefined): boolean {
  const message = String(error?.message ?? "").toLowerCase();
  return error?.code === "PGRST204"
    || error?.code === "42703"
    || message.includes("does not exist")
    || message.includes("schema cache");
}

// Best-effort enqueue: if the pending_emails table isn't migrated (or the insert
// fails) this no-ops — the caller has already logged the failure — never throws.
export async function enqueueFailedEmail(
  message: QueuedEmail,
  error?: string,
  context?: QueuedEmailContext,
): Promise<void> {
  const base = {
    to_email: message.to,
    subject: message.subject,
    html: message.html ?? null,
    text_body: message.text ?? null,
    reply_to: message.replyTo ?? null,
    attempts: 1,
    status: "pending",
    last_error: error ?? null,
    // First retry in 5 minutes.
    next_attempt_at: new Date(Date.now() + 5 * 60_000).toISOString(),
  };
  try {
    if (!context) {
      await supabaseAdmin.from("pending_emails").insert(base);
      return;
    }
    // Written to degrade: the order link is only useful once
    // sql/pending-emails-order-link.sql has run, and losing a customer's receipt
    // because the column is not there yet would be a far worse trade than losing
    // the write-back. So the code is safe to deploy in either order.
    const { error: linkError } = await supabaseAdmin
      .from("pending_emails")
      .insert({ ...base, order_id: context.orderId, email_kind: context.kind });
    if (linkError) {
      if (!isMissingSchema(linkError)) throw linkError;
      await supabaseAdmin.from("pending_emails").insert(base);
    }
  } catch {
    // Table not migrated or transient DB error — the original send was logged.
  }
}

/**
 * Mark the order_email_log row for (orderId, kind) as sent, re-taking the
 * send-once slot on behalf of the retry that just delivered it.
 *
 * Best-effort and never throws: the email has already reached the customer, so
 * only the record is at stake — the same trade sendOrderEmailOnce makes when it
 * cannot write its own outcome.
 */
async function closeSendOnceSlot(
  orderId: string,
  kind: OrderEmailKind,
  provider?: string,
  providerMessageId?: string,
): Promise<void> {
  try {
    await supabaseAdmin
      .from("order_email_log")
      .update({
        status: "sent",
        provider: provider ?? null,
        provider_message_id: providerMessageId ?? null,
        error: null,
        completed_at: new Date().toISOString(),
      })
      .eq("order_id", orderId)
      .eq("kind", kind)
      .eq("status", "failed");
  } catch (writeBackError) {
    console.error("[email-retry] delivered but could not close the send-once slot", orderId, kind, writeBackError);
  }
}

/**
 * Does the send-once log already say this (order, kind) email was DELIVERED?
 *
 * Used by the manual retry to refuse to re-send something the customer already
 * has (E-02). Reads as `false` when it cannot tell — an unreadable or
 * unmigrated log must not block an owner's only recovery tool, and the
 * idempotency key on the send remains as the second line.
 */
async function sendOnceSlotIsSent(orderId: string, kind: OrderEmailKind): Promise<boolean> {
  try {
    const { data, error } = await supabaseAdmin
      .from("order_email_log")
      .select("id")
      .eq("order_id", orderId)
      .eq("kind", kind)
      .eq("status", "sent")
      .limit(1);
    if (error || !data) return false;
    return (data as unknown[]).length > 0;
  } catch {
    return false;
  }
}

// Drain due pending emails (called by the scheduled sweep). Retries each, marks
// it sent on success, or backs off exponentially (5→10→20→40→60 min) and gives
// up after MAX_ATTEMPTS. Never throws.
export async function retryPendingEmails(maxPerRun = 50): Promise<{ sent: number; retried: number; gaveUp: number }> {
  let sent = 0;
  let retried = 0;
  let gaveUp = 0;
  try {
    // Typed explicitly because the column list is chosen at runtime, which
    // defeats supabase-js's inference from a literal select string.
    type PendingRow = {
      id: string;
      to_email: string | null;
      subject: string | null;
      html: string | null;
      text_body: string | null;
      reply_to: string | null;
      attempts: number | null;
      order_id?: string | null;
      email_kind?: string | null;
    };
    const due = (columns: string) => supabaseAdmin
      .from("pending_emails")
      .select(columns)
      .eq("status", "pending")
      .lte("next_attempt_at", new Date().toISOString())
      .order("next_attempt_at", { ascending: true })
      .limit(maxPerRun) as unknown as PromiseLike<{ data: PendingRow[] | null; error: { code?: string; message?: string } | null }>;

    const BASE_COLUMNS = "id, to_email, subject, html, text_body, reply_to, attempts";
    let { data, error } = await due(`${BASE_COLUMNS}, order_id, email_kind`);
    if (error && isMissingSchema(error)) {
      // sql/pending-emails-order-link.sql has not run yet. Drain the queue the
      // way it always did; the send-once write-back below simply does not fire.
      ({ data, error } = await due(BASE_COLUMNS));
    }
    if (error || !data) return { sent, retried, gaveUp };

    for (const row of data) {
      const orderId = row.order_id ? String(row.order_id) : null;
      const kind = row.email_kind ? (String(row.email_kind) as OrderEmailKind) : null;
      const result = await sendEmail({
        to: String(row.to_email),
        subject: String(row.subject),
        html: String(row.html ?? ""),
        text: String(row.text_body ?? ""),
        replyTo: row.reply_to ? String(row.reply_to) : undefined,
        // The same identity sendOrderEmailOnce uses, so this retry and the
        // original send look like ONE email to the provider too. Without it,
        // even a provider that would collapse the duplicate cannot.
        ...(orderId && kind ? { idempotencyKey: `${kind}:${orderId}` } : {}),
      });
      const now = new Date().toISOString();
      if (result.success) {
        await supabaseAdmin.from("pending_emails").update({ status: "sent", updated_at: now }).eq("id", row.id);
        // CLOSE THE SLOT THIS RETRY JUST SATISFIED (C-02). The customer now has
        // the email; leaving order_email_log at 'failed' leaves the slot free
        // for the next caller to send a second one, and leaves the record
        // saying a receipt was never delivered when it was.
        if (orderId && kind) await closeSendOnceSlot(orderId, kind, result.provider, result.providerMessageId);
        sent += 1;
      } else {
        const attempts = Number(row.attempts ?? 0) + 1;
        if (attempts >= MAX_ATTEMPTS) {
          await supabaseAdmin.from("pending_emails")
            .update({ status: "failed", attempts, last_error: result.error ?? null, updated_at: now })
            .eq("id", row.id);
          gaveUp += 1;
          await recordSystemAlert({
            type: "email_undeliverable",
            severity: "warning",
            message: `Gave up delivering "${String(row.subject)}" to ${String(row.to_email)} after ${attempts} attempts`,
            context: { to: row.to_email, subject: row.subject, error: result.error ?? null },
          });
        } else {
          const backoffMinutes = Math.min(60, 5 * 2 ** (attempts - 1));
          await supabaseAdmin.from("pending_emails")
            .update({ attempts, last_error: result.error ?? null, next_attempt_at: new Date(Date.now() + backoffMinutes * 60_000).toISOString(), updated_at: now })
            .eq("id", row.id);
          retried += 1;
        }
      }
    }
  } catch {
    // Table not migrated / transient — safe to skip this run.
  }
  return { sent, retried, gaveUp };
}

/**
 * Retry the queued emails for one order, now, on an owner's instruction.
 *
 * SAFE BY CONSTRUCTION, and the proof is the import list of this module: it
 * reaches Supabase, sendEmail and recordSystemAlert, and nothing else. There is
 * no path from here to payment, inventory, commissions, fulfilment or order
 * status — this re-sends a payload that was already rendered and stored when
 * the original send failed, and updates that row. Re-sending an email cannot
 * re-charge a card or move stock because it does not know how.
 *
 * Rows the sweep has given up on are eligible too — being able to revive them
 * is the point of a manual retry. A manual attempt deliberately does NOT
 * increment `attempts`: that budget belongs to the automatic sweep, and an
 * owner clicking twice should not exhaust it.
 *
 * IT OBEYS SEND-ONCE (E-02). The automatic sweep passes the queued email's
 * (order, kind) identity to the provider as an idempotency key and closes the
 * send-once slot it satisfies. This path did neither: it re-rendered a stored
 * payload and pushed it straight at the provider, so an owner clicking "retry"
 * on a receipt the sweep had ALREADY delivered sent the customer a second one —
 * the exact duplicate order_email_log exists to make impossible. Manual now:
 *
 *   * skips a row whose send-once slot already reads 'sent' — that email
 *     reached the customer, and the queue row is a leftover from the failed
 *     attempt before it — and marks the leftover 'sent' so the panel stops
 *     reporting a failure that was since made good;
 *   * sends with the same `kind:orderId` idempotency key the original used, so
 *     our guard and the provider's agree on what "the same email" is;
 *   * closes the slot on success, exactly as the sweep does.
 *
 * A row with no (order_id, email_kind) — queued before
 * sql/pending-emails-order-link.sql ran, or an email that is not about one
 * order — behaves as it always did. There is no identity to dedupe on, and
 * refusing to retry it would take away the only recovery this panel offers.
 *
 * Matched on the order number in the subject, the same join the admin display
 * uses; the order link, where present, is what the send-once checks use.
 */
export async function retryPendingEmailsForOrder(
  orderNumber: string,
): Promise<{ found: number; sent: number; stillFailing: number; skippedAlreadySent: number }> {
  let found = 0;
  let sent = 0;
  let stillFailing = 0;
  let skippedAlreadySent = 0;
  const needle = String(orderNumber ?? "").trim();
  if (!needle) return { found, sent, stillFailing, skippedAlreadySent };

  try {
    type ManualRow = {
      id: string;
      to_email: string | null;
      subject: string | null;
      html: string | null;
      text_body: string | null;
      reply_to: string | null;
      attempts: number | null;
      status: string | null;
      order_id?: string | null;
      email_kind?: string | null;
    };
    const BASE_COLUMNS = "id, to_email, subject, html, text_body, reply_to, attempts, status";
    const matching = (columns: string) => supabaseAdmin
      .from("pending_emails")
      .select(columns)
      .in("status", ["pending", "failed"])
      .ilike("subject", `%${needle}%`)
      .limit(20) as unknown as PromiseLike<{ data: ManualRow[] | null; error: { code?: string; message?: string } | null }>;

    let { data, error } = await matching(`${BASE_COLUMNS}, order_id, email_kind`);
    if (error && isMissingSchema(error)) {
      // The order link column is not migrated yet. Retry the way this always
      // did — there is simply no identity to dedupe against.
      ({ data, error } = await matching(BASE_COLUMNS));
    }
    if (error || !data) return { found, sent, stillFailing, skippedAlreadySent };

    found = data.length;
    for (const row of data) {
      const orderId = row.order_id ? String(row.order_id) : null;
      const kind = row.email_kind ? (String(row.email_kind) as OrderEmailKind) : null;

      // ALREADY DELIVERED? Then this queue row is history, not work. Sending it
      // is the duplicate receipt this whole mechanism exists to prevent.
      if (orderId && kind && await sendOnceSlotIsSent(orderId, kind)) {
        skippedAlreadySent += 1;
        await supabaseAdmin
          .from("pending_emails")
          .update({ status: "sent", updated_at: new Date().toISOString() })
          .eq("id", row.id);
        continue;
      }

      const result = await sendEmail({
        to: String(row.to_email),
        subject: String(row.subject),
        html: String(row.html ?? ""),
        text: String(row.text_body ?? ""),
        replyTo: row.reply_to ? String(row.reply_to) : undefined,
        ...(orderId && kind ? { idempotencyKey: `${kind}:${orderId}` } : {}),
      });
      const now = new Date().toISOString();
      if (result.success) {
        await supabaseAdmin.from("pending_emails").update({ status: "sent", updated_at: now }).eq("id", row.id);
        // Re-take the slot this manual retry just satisfied, so the next caller
        // — sweep, webhook or another click — sees a delivered receipt rather
        // than a released slot to send into.
        if (orderId && kind) await closeSendOnceSlot(orderId, kind, result.provider, result.providerMessageId);
        sent += 1;
      } else {
        // Attempts untouched on purpose; only the reason is refreshed.
        await supabaseAdmin
          .from("pending_emails")
          .update({ last_error: result.error ?? null, updated_at: now })
          .eq("id", row.id);
        stillFailing += 1;
      }
    }
  } catch {
    // Table not migrated / transient — the queue is unchanged and the sweep
    // will still pick these up on its own schedule.
  }

  return { found, sent, stillFailing, skippedAlreadySent };
}
