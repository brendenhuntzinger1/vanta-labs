import { supabaseAdmin } from "@/lib/supabase-server";
import { sendEmail } from "@/lib/email/send";
import { recordSystemAlert } from "@/lib/monitoring";
import type { EmailTemplate } from "@/lib/email/types";

// Durable retry for TRANSACTIONAL emails (receipts, shipping notices). A
// transactional send that fails (provider outage) is enqueued here and drained
// by the cron sweep with exponential backoff, so a receipt is never silently
// lost. Marketing email is NOT queued (it has its own suppression flow).

const MAX_ATTEMPTS = 5;

type QueuedEmail = { to: string; replyTo?: string } & EmailTemplate;

// Best-effort enqueue: if the pending_emails table isn't migrated (or the insert
// fails) this no-ops — the caller has already logged the failure — never throws.
export async function enqueueFailedEmail(message: QueuedEmail, error?: string): Promise<void> {
  try {
    await supabaseAdmin.from("pending_emails").insert({
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
    });
  } catch {
    // Table not migrated or transient DB error — the original send was logged.
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
    const { data, error } = await supabaseAdmin
      .from("pending_emails")
      .select("id, to_email, subject, html, text_body, reply_to, attempts")
      .eq("status", "pending")
      .lte("next_attempt_at", new Date().toISOString())
      .order("next_attempt_at", { ascending: true })
      .limit(maxPerRun);
    if (error || !data) return { sent, retried, gaveUp };

    for (const row of data) {
      const result = await sendEmail({
        to: String(row.to_email),
        subject: String(row.subject),
        html: String(row.html ?? ""),
        text: String(row.text_body ?? ""),
        replyTo: row.reply_to ? String(row.reply_to) : undefined,
      });
      const now = new Date().toISOString();
      if (result.success) {
        await supabaseAdmin.from("pending_emails").update({ status: "sent", updated_at: now }).eq("id", row.id);
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
 * Matched on the order number in the subject, the same join the admin display
 * uses. `pending_emails` carries no order id by design — it has to survive the
 * failure of everything around it.
 */
export async function retryPendingEmailsForOrder(
  orderNumber: string,
): Promise<{ found: number; sent: number; stillFailing: number }> {
  let found = 0;
  let sent = 0;
  let stillFailing = 0;
  const needle = String(orderNumber ?? "").trim();
  if (!needle) return { found, sent, stillFailing };

  try {
    const { data, error } = await supabaseAdmin
      .from("pending_emails")
      .select("id, to_email, subject, html, text_body, reply_to, attempts, status")
      .in("status", ["pending", "failed"])
      .ilike("subject", `%${needle}%`)
      .limit(20);
    if (error || !data) return { found, sent, stillFailing };

    found = data.length;
    for (const row of data) {
      const result = await sendEmail({
        to: String(row.to_email),
        subject: String(row.subject),
        html: String(row.html ?? ""),
        text: String(row.text_body ?? ""),
        replyTo: row.reply_to ? String(row.reply_to) : undefined,
      });
      const now = new Date().toISOString();
      if (result.success) {
        await supabaseAdmin.from("pending_emails").update({ status: "sent", updated_at: now }).eq("id", row.id);
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

  return { found, sent, stillFailing };
}
