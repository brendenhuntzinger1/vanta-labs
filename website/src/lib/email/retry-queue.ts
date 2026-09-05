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

/**
 * How long a queue row is held once a drain has picked it up.
 *
 * THE CLAIM COMES BEFORE THE SEND, here as everywhere else in this system. Both
 * drains used to select a row and send it with nothing marking it as taken, so
 * the scheduled sweep and an owner's manual retry landing on the same row in
 * the same moment each sent it — and a shipping notice carries no idempotency
 * key for the provider to collapse. Pushing `next_attempt_at` out by this much
 * under a compare-and-set on the value just read is the claim: whichever
 * caller's update matches the row owns it, the other's matches nothing and
 * moves on. A process that dies mid-send leaves the row pending with this
 * hold on it, so the next sweep after the hold simply tries again — no
 * separate reaper, and no row stranded at a status nothing clears.
 */
export const IN_FLIGHT_HOLD_MS = 10 * 60_000;

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

/**
 * Take a queue row for THIS caller, by compare-and-set on what it just read.
 *
 * Returns the attempts figure the row now carries, or null when another drain
 * got there first (or the row changed underneath us), in which case the caller
 * must not send it. `countAttempt` is what separates the sweep, whose budget
 * this is, from the manual retry, which deliberately spends none of it.
 */
async function claimQueuedRow(
  row: { id: string; status?: string | null; attempts?: number | null; next_attempt_at?: string | null },
  countAttempt: boolean,
): Promise<number | null> {
  const attempts = Number(row.attempts ?? 0) + (countAttempt ? 1 : 0);
  const now = new Date().toISOString();
  try {
    let query = supabaseAdmin
      .from("pending_emails")
      .update({
        ...(countAttempt ? { attempts } : {}),
        next_attempt_at: new Date(Date.now() + IN_FLIGHT_HOLD_MS).toISOString(),
        updated_at: now,
      })
      .eq("id", row.id)
      .eq("status", String(row.status ?? "pending"));
    // The value read is the fence. A row written before the column had a value
    // (it is NOT NULL in the schema, so only a fake) is fenced on status alone.
    if (row.next_attempt_at) query = query.eq("next_attempt_at", row.next_attempt_at);
    const { data, error } = await query.select("id");
    if (error || !data || (data as unknown[]).length === 0) return null;
    return attempts;
  } catch {
    return null;
  }
}

/** `j***@domain` — enough for an operator to recognise, never the address. */
function maskAddress(email: string): string {
  const [local, domain] = String(email ?? "").split("@");
  if (!domain) return "***";
  return `${local.slice(0, 1)}${"*".repeat(Math.max(3, local.length - 1))}@${domain}`;
}

// Drain due pending emails (called by the scheduled sweep). Claims each row,
// retries it, marks it sent on success, or backs off exponentially
// (5→10→20→40→60 min) and gives up after MAX_ATTEMPTS. Never throws.
export async function retryPendingEmails(maxPerRun = 50): Promise<{ sent: number; retried: number; gaveUp: number }> {
  let sent = 0;
  let retried = 0;
  let gaveUp = 0;
  const gaveUpRows: Array<{ to: string; subject: string; error: string | null }> = [];
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
      next_attempt_at?: string | null;
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

    const BASE_COLUMNS = "id, to_email, subject, html, text_body, reply_to, attempts, next_attempt_at";
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

      // OURS, OR SOMEBODY ELSE'S. See IN_FLIGHT_HOLD_MS.
      const attempts = await claimQueuedRow({ ...row, status: "pending" }, true);
      if (attempts === null) continue;
      const now = new Date().toISOString();

      // ALREADY DELIVERED BY ANOTHER PATH? The send-once log is the record: a
      // 'sent' slot means the customer has this email (the webhook re-entered,
      // or an owner resent it), and the queue row is history, not work. The
      // manual retry has refused these since E-02; the sweep now does too.
      if (orderId && kind && await sendOnceSlotIsSent(orderId, kind)) {
        await supabaseAdmin.from("pending_emails").update({ status: "sent", updated_at: now }).eq("id", row.id);
        continue;
      }

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
      if (result.success) {
        await supabaseAdmin.from("pending_emails").update({ status: "sent", updated_at: now }).eq("id", row.id);
        // CLOSE THE SLOT THIS RETRY JUST SATISFIED (C-02). The customer now has
        // the email; leaving order_email_log at 'failed' leaves the slot free
        // for the next caller to send a second one, and leaves the record
        // saying a receipt was never delivered when it was.
        if (orderId && kind) await closeSendOnceSlot(orderId, kind, result.provider, result.providerMessageId);
        sent += 1;
      } else if (attempts >= MAX_ATTEMPTS) {
        await supabaseAdmin.from("pending_emails")
          .update({ status: "failed", attempts, last_error: result.error ?? null, updated_at: now })
          .eq("id", row.id);
        gaveUp += 1;
        gaveUpRows.push({ to: String(row.to_email), subject: String(row.subject), error: result.error ?? null });
      } else {
        const backoffMinutes = Math.min(60, 5 * 2 ** (attempts - 1));
        await supabaseAdmin.from("pending_emails")
          .update({ attempts, last_error: result.error ?? null, next_attempt_at: new Date(Date.now() + backoffMinutes * 60_000).toISOString(), updated_at: now })
          .eq("id", row.id);
        retried += 1;
      }
    }
  } catch {
    // Table not migrated / transient — safe to skip this run.
  }

  if (gaveUpRows.length > 0) await reportUndeliverable(gaveUpRows);
  return { sent, retried, gaveUp };
}

/**
 * The retry budget is spent: these customers did NOT get a transactional
 * email — a receipt, a shipping notice, a refund confirmation — and nothing
 * will try again on its own.
 *
 * ONE ALERT PER DRAIN, AT CRITICAL, ON A CHANNEL THE OUTAGE CANNOT TAKE DOWN.
 * This used to raise one WARNING per row. A warning is a status-page entry;
 * nothing notifies anybody. And the only notifying channel this system had —
 * the critical-alert email — is carried by the very provider whose failure is
 * being reported, so during the outage that matters the operator heard
 * nothing at all. The give-ups are collected into a single critical (the
 * status badge counts it, Sentry gets it at error level, and the operator
 * email goes out once the provider is back), and the same fact is pushed to
 * the phone through the order-notification channel, which does not depend on
 * email. Best-effort throughout; an alerting failure never touches the queue.
 */
async function reportUndeliverable(rows: Array<{ to: string; subject: string; error: string | null }>): Promise<void> {
  const summary = rows
    .slice(0, 10)
    .map((row) => `"${row.subject}" to ${maskAddress(row.to)}`)
    .join("; ");
  const message =
    `Gave up delivering ${rows.length} transactional email(s) after ${MAX_ATTEMPTS} attempts each: ${summary}`
    + (rows.length > 10 ? `; and ${rows.length - 10} more` : "")
    + ". Those customers did not receive them and nothing retries automatically — "
    + "check the email provider, then retry from each order's communications panel.";
  try {
    await recordSystemAlert({
      type: "email_undeliverable",
      severity: "critical",
      message,
      context: {
        count: rows.length,
        emails: rows.slice(0, 50).map((row) => ({ to: row.to, subject: row.subject, error: row.error })),
      },
    });
  } catch {
    // Never throw from the alerting path.
  }
  try {
    // Loaded on demand: the order-push module reaches the Control Center and
    // is only wanted on the give-up path, not on every quiet drain.
    const { sendOperatorPushNotification } = await import("@/lib/order-push-notification");
    await sendOperatorPushNotification({ title: "Email undeliverable", message });
  } catch {
    // No push destination, or it refused — the alert row and Sentry stand.
  }
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
      next_attempt_at?: string | null;
      order_id?: string | null;
      email_kind?: string | null;
    };
    const BASE_COLUMNS = "id, to_email, subject, html, text_body, reply_to, attempts, status, next_attempt_at";
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

      // The same claim the sweep takes (IN_FLIGHT_HOLD_MS), so a click that
      // lands while the sweep is sending this very row does not send it twice.
      // Attempts untouched: that budget belongs to the automatic sweep.
      if (await claimQueuedRow(row, false) === null) {
        stillFailing += 1;
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
