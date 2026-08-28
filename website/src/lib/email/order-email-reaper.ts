import "server-only";

import { supabaseAdmin } from "@/lib/supabase-server";
import { recordSystemAlert } from "@/lib/monitoring";

/**
 * Release send-once slots stranded at 'sending' (E-03).
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
 * attempt did not complete — and it drops the row out of the partial index, so
 * the next caller, or the pending_emails sweep, can get the receipt out.
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

    if (error || !data) return { released: 0 };

    const rows = data as Array<{ order_id?: string | null; kind?: string | null }>;
    if (rows.length > 0) {
      // Operator-visible: a stranded claim means a customer was, until this
      // moment, unable to receive their confirmation at all. The sweep's email
      // retry will now pick it up, but somebody should know it happened.
      await recordSystemAlert({
        type: "order_email_stranded",
        severity: "warning",
        message: `Released ${rows.length} order email send-once slot(s) stranded at 'sending'. Those confirmations were blocked until now.`,
        context: {
          orders: rows.map((row) => `${String(row.order_id ?? "?")}:${String(row.kind ?? "?")}`).slice(0, 20),
        },
      }).catch(() => {});
    }

    return { released: rows.length };
  } catch {
    // Table not migrated / transient — nothing released this run.
    return { released: 0 };
  }
}
