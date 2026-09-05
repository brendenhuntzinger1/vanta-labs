import "server-only";

import { supabaseAdmin } from "@/lib/supabase-server";
import { sendRenderedMarketingEmail, type RenderedMarketingEmail } from "@/lib/email/marketing";
import { getEmailRuntimeConfig, marketingBlockedReason } from "@/lib/email/settings";
import { marketingMessageAlreadySent } from "@/lib/email/frequency";

/**
 * THE DEFERRED QUEUE for event-driven marketing mail.
 *
 * A restock alert fires when stock lands; a membership welcome fires when a
 * plan activates; a coupon announcement fires when an operator clicks Send.
 * None of them has a sweep that would try again tomorrow, so when the
 * frequency guard says "not today" the rendered message is parked here and
 * the cron sweep delivers it once the quiet window has passed — through the
 * same claim, so a queued message is never a way around the guard.
 *
 * Stored fully rendered: the unsubscribe link, the postal address and the
 * pixel were baked in when it was deferred, so draining is delivery and
 * nothing else. Suppression is re-checked at delivery time, because a person
 * may have unsubscribed in the meantime.
 */

export const MARKETING_QUEUE_MAX_ATTEMPTS = 8;
/** A provider failure waits this long times the attempt count before the next try. */
export const MARKETING_QUEUE_RETRY_MS = 30 * 60 * 1000;

export type MarketingQueueDrainResult = {
  sent: number;
  deferredAgain: number;
  cancelled: number;
  failed: number;
  errors: string[];
};

/**
 * Deliver every queued message whose not_before has passed.
 *
 * Runs as one job of the cron sweep. Each row is re-claimed through the guard:
 * a deferral simply pushes not_before out again and counts an attempt, so a
 * recipient who is mailed by something else every day does not accumulate a
 * backlog for ever — after MARKETING_QUEUE_MAX_ATTEMPTS the row is closed
 * 'failed' with a reason, which the log makes visible.
 */
export async function drainMarketingSendQueue(input?: { now?: number; limit?: number }): Promise<MarketingQueueDrainResult> {
  const now = input?.now ?? Date.now();
  const limit = input?.limit ?? 50;
  const result: MarketingQueueDrainResult = { sent: 0, deferredAgain: 0, cancelled: 0, failed: 0, errors: [] };

  // Email switched off in Settings holds the queue exactly as it holds the
  // campaign and automation sweeps: nothing is attempted, nothing is failed,
  // and the rows are still there when it is switched back on.
  try {
    const blocked = marketingBlockedReason(await getEmailRuntimeConfig());
    if (blocked) {
      result.errors.push(`queue held: ${blocked}`);
      return result;
    }
  } catch (error) {
    result.errors.push(`settings read: ${error instanceof Error ? error.message : String(error)}`);
    return result;
  }

  // Bookkeeping that is CHECKED. supabase-js resolves an error rather than
  // throwing it, and an unrecorded 'sent' is a message delivered again
  // tomorrow — so a failed update is retried once and then reported.
  const mark = async (id: string, patch: Record<string, unknown>) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const { error } = await supabaseAdmin.from("marketing_send_queue").update(patch).eq("id", id);
      if (!error) return;
      if (attempt === 1) result.errors.push(`${id}: bookkeeping failed: ${error.message}`);
    }
  };

  let rows: Array<Record<string, unknown>> = [];
  try {
    const { data, error } = await supabaseAdmin
      .from("marketing_send_queue")
      .select("id, recipient_email, campaign_type, reference_id, template_key, subject, html, text_body, attempts, created_at")
      .eq("status", "queued")
      .lte("not_before", new Date(now).toISOString())
      .order("not_before", { ascending: true })
      .limit(limit);
    if (error) throw error;
    rows = (data ?? []) as Array<Record<string, unknown>>;
  } catch (error) {
    // An un-migrated database has no queue, and that is not a failure of
    // anything else in the sweep.
    result.errors.push(`queue read: ${error instanceof Error ? error.message : String(error)}`);
    return result;
  }

  for (const row of rows) {
    const id = String(row.id);
    const attempts = Number(row.attempts ?? 0) + 1;
    const rendered: RenderedMarketingEmail = {
      to: String(row.recipient_email ?? ""),
      subject: String(row.subject ?? ""),
      html: String(row.html ?? ""),
      text: String(row.text_body ?? ""),
    };
    try {
      // ALREADY DELIVERED? A sent-log row for this very message — (campaign
      // type, reference, recipient) — means the address has it: a previous
      // drain sent it and could not record that, OR the send that deferred
      // this row in the first place WAS this message, from an overlapping
      // sweep or a replayed activation. This used to look only for a send made
      // after the row was queued, which is exactly the copy it missed, so a
      // membership welcome deferred by its own twin went out a day later.
      // Mark it and move on rather than mailing the same thing twice.
      if (await marketingMessageAlreadySent({
        email: rendered.to,
        campaignType: String(row.campaign_type ?? ""),
        referenceId: row.reference_id ? String(row.reference_id) : null,
        now,
      })) {
        result.sent++;
        await mark(id, { status: "sent", sent_at: new Date().toISOString(), attempts, last_error: "already delivered to this address" });
        continue;
      }

      const outcome = await sendRenderedMarketingEmail({
        rendered,
        campaignType: String(row.campaign_type ?? ""),
        referenceId: row.reference_id ? String(row.reference_id) : null,
        templateKey: String(row.template_key ?? row.campaign_type ?? ""),
        onDeferred: "report",
      });

      if (outcome.success) {
        result.sent++;
        await mark(id, { status: "sent", sent_at: new Date().toISOString(), attempts, last_error: null });
      } else if (outcome.deferred && attempts < MARKETING_QUEUE_MAX_ATTEMPTS) {
        result.deferredAgain++;
        await mark(id, { not_before: new Date(outcome.retryAt ?? now + 60 * 60 * 1000).toISOString(), attempts, last_error: "deferred by the frequency guard" });
      } else if (outcome.suppressed || outcome.duplicate) {
        // Unsubscribed since it was queued, or already delivered another way.
        result.cancelled++;
        await mark(id, { status: "cancelled", attempts, last_error: outcome.error ?? null });
      } else if (!outcome.deferred && attempts < MARKETING_QUEUE_MAX_ATTEMPTS) {
        // The wire refused (provider error, rate limit): a message the guard
        // has already let through is not thrown away on its first bad minute.
        result.failed++;
        await mark(id, { not_before: new Date(now + MARKETING_QUEUE_RETRY_MS * attempts).toISOString(), attempts, last_error: (outcome.error ?? "send failed").slice(0, 300) });
      } else {
        result.failed++;
        await mark(id, { status: "failed", attempts, last_error: (outcome.error ?? "send failed").slice(0, 300) });
      }
    } catch (error) {
      result.failed++;
      result.errors.push(`${id}: ${error instanceof Error ? error.message : String(error)}`);
      await supabaseAdmin.from("marketing_send_queue")
        .update({ attempts, last_error: (error instanceof Error ? error.message : String(error)).slice(0, 300), ...(attempts >= MARKETING_QUEUE_MAX_ATTEMPTS ? { status: "failed" } : {}) })
        .eq("id", id)
        .then(() => undefined, () => undefined);
    }
  }

  return result;
}
