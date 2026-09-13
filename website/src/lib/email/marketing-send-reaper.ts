import "server-only";

import { supabaseAdmin } from "@/lib/supabase-server";
import { recordSystemAlert } from "@/lib/monitoring";

/**
 * RELEASE MARKETING SEND-ONCE SLOTS STRANDED AT 'sending'.
 *
 * THE HOLE, AND WHY IT IS PERMANENT. marketing_send_claim writes the
 * email_send_log row at 'sending' UNDER A LOCK, BEFORE the provider is called —
 * which is what makes a duplicate impossible. Only the same invocation ever
 * resolves it, by writing 'sent' or 'failed' afterwards. If that invocation
 * never gets there (the function is killed mid-send, the provider call hangs
 * past the 60-second ceiling, the write after the send fails) the row stays at
 * 'sending'.
 *
 * For the frequency guard that heals itself: its own query ignores a 'sending'
 * row older than fifteen minutes, so the address stops being under pressure.
 *
 * FOR AUTOMATIONS IT DOES NOT. email_send_log_automation_once is a partial
 * unique index over (campaign_type, reference_id) WHERE status <> 'failed', and
 * it carries NO time bound. A row stranded at 'sending' therefore holds that
 * automation's slot for that recipient FOR EVER: every later sweep is answered
 * `duplicate` and returns without sending. Proven against the harness database
 * on 2026-09-13 — a claim stranded thirty days earlier still answers
 * `duplicate`. The customer never receives that win-back, and nothing anywhere
 * says so: loadSendLedger excludes 'sending' from the report, so the blocked
 * send is invisible on the one screen built to answer "is this mail arriving".
 *
 * order-email-reaper.ts closes exactly this hole for order_email_log. This is
 * the same shape for the other log, and it is deliberately NOT the same
 * remedy — see below.
 *
 * WHAT THIS DOES NOT DO: IT DOES NOT RE-SEND. The order reaper re-renders and
 * queues, because a customer is OWED a receipt. Marketing mail is not owed, and
 * re-sending from here would be the expensive mistake: a gift-bearing
 * automation mints a NEW one-time token on every render, so a re-send is a
 * second gift, not a retry of the first. Releasing the slot is enough —
 * selectAutomationTargets excludes 'failed' rows, so the next ordinary sweep
 * reconsiders the recipient on the ordinary rules, at the ordinary time, with
 * the ordinary economics.
 *
 * A RELEASE IS ONLY SAFE IF THE MESSAGE NEVER REACHED THE WIRE, and this
 * module refuses to assume that. A crash AFTER the provider accepted looks
 * identical in email_send_log to a crash before it; releasing that slot would
 * turn a permanent block into a DUPLICATE SEND, which marketing.ts ranks as the
 * worse of the two ("a missed marketing email costs nothing next to a duplicate
 * one"). So each stranded row is judged against email_delivery_events for the
 * same address around its send time — the same evidence, and the same window,
 * loadSendLedger already uses for sends that carry no provider message id:
 *
 *   any delivery event  → it went out. Closed 'sent'. The slot STAYS held,
 *                         which is the truth: they received it.
 *   a `failed` event    → the provider refused it. Closed 'failed', which
 *                         releases the slot so the sequence resumes.
 *   no events at all    → presumed never sent. Closed 'failed'.
 *   the events table
 *   cannot be read      → NOTHING IS RELEASED THIS RUN. Fail closed: one more
 *                         tick of a blocked slot costs far less than a
 *                         duplicate, and the next tick asks again.
 *
 * The last of those is the point of the whole module. The cheap version of this
 * fix — release everything older than the window — would have been four lines
 * and would have introduced the failure it exists to prevent.
 *
 * NEVER THROWS. It runs in the lifecycle route beside the jobs that actually
 * put mail in front of customers.
 */

/**
 * How long a claim may sit at 'sending' before the request that made it is
 * presumed dead.
 *
 * FIFTEEN MINUTES IS NOT A FREE CHOICE: marketing_send_claim's own pressure
 * query hard-codes `interval '15 minutes'` for the same judgement
 * (sql/marketing-frequency-guard.sql). Two different answers to "is this claim
 * still alive" in one system is how a row becomes invisible to one and live to
 * the other, so they are the same number. The real ceiling is Vercel's
 * sixty-second function budget, so this is twelve times the longest a genuine
 * in-flight send can be.
 */
export const MARKETING_STRANDED_AFTER_MINUTES = 15;

/** One run's ceiling. This is housekeeping; it must not become the sweep. */
const MAX_PER_RUN = 200;

/** The window loadSendLedger uses to match a send to an address-keyed event. */
const EVENT_MATCH_BEFORE_MS = 2 * 60 * 1000;
const EVENT_MATCH_AFTER_MS = 30 * 60 * 1000;

export interface ReapedMarketingSends {
  /** Rows found stranded past the window. */
  stranded: number;
  /** Closed 'failed': no evidence they reached the wire. The slot is free. */
  released: number;
  /** Closed 'sent': the provider reported an event, so they did reach it. */
  confirmed: number;
  /** Left alone because the evidence could not be read. Retried next tick. */
  undecided: number;
}

type StrandedRow = {
  id: string;
  campaign_type: string | null;
  reference_id: string | null;
  recipient_email: string | null;
  sent_at: string | null;
};

const empty = (): ReapedMarketingSends => ({ stranded: 0, released: 0, confirmed: 0, undecided: 0 });

export async function reapStrandedMarketingSends(
  staleAfterMinutes = MARKETING_STRANDED_AFTER_MINUTES,
): Promise<ReapedMarketingSends> {
  const result = empty();
  const cutoff = new Date(Date.now() - staleAfterMinutes * 60_000).toISOString();

  let rows: StrandedRow[];
  try {
    const { data, error } = await supabaseAdmin
      .from("email_send_log")
      .select("id, campaign_type, reference_id, recipient_email, sent_at")
      .eq("status", "sending")
      .lt("sent_at", cutoff)
      .order("sent_at", { ascending: true })
      .limit(MAX_PER_RUN);
    if (error || !data) return result;
    rows = data as StrandedRow[];
  } catch {
    // Un-migrated or transient. Nothing is stranded as far as this run knows.
    return result;
  }
  if (rows.length === 0) return result;
  result.stranded = rows.length;

  // ONE READ FOR THE WHOLE BATCH, not one per row: a reaper that issues two
  // hundred queries inside a sixty-second budget shared with the sends
  // themselves is a worse citizen than the problem it is fixing.
  const addresses = [...new Set(rows.map((row) => (row.recipient_email ?? "").trim().toLowerCase()).filter(Boolean))];
  const oldestMs = rows.reduce((oldest, row) => {
    const at = row.sent_at ? Date.parse(row.sent_at) : NaN;
    return Number.isFinite(at) ? Math.min(oldest, at) : oldest;
  }, Number.POSITIVE_INFINITY);

  const events = new Map<string, Array<{ kind: string; at: number }>>();
  try {
    const floor = Number.isFinite(oldestMs)
      ? new Date(oldestMs - EVENT_MATCH_BEFORE_MS).toISOString()
      : new Date(Date.parse(cutoff) - EVENT_MATCH_BEFORE_MS).toISOString();
    const { data, error } = await supabaseAdmin
      .from("email_delivery_events")
      .select("recipient_email, kind, received_at")
      .in("recipient_email", addresses)
      .gte("received_at", floor);
    // FAIL CLOSED. Without the evidence there is no safe release, so this run
    // decides nothing and the next one asks again.
    if (error || !data) {
      result.undecided = rows.length;
      return result;
    }
    for (const row of data as Array<{ recipient_email?: string | null; kind?: string | null; received_at?: string | null }>) {
      const email = (row.recipient_email ?? "").trim().toLowerCase();
      const at = row.received_at ? Date.parse(row.received_at) : NaN;
      if (!email || !Number.isFinite(at)) continue;
      const list = events.get(email) ?? [];
      list.push({ kind: String(row.kind ?? ""), at });
      events.set(email, list);
    }
  } catch {
    result.undecided = rows.length;
    return result;
  }

  const releasedLabels: string[] = [];
  for (const row of rows) {
    const email = (row.recipient_email ?? "").trim().toLowerCase();
    const sentAtMs = row.sent_at ? Date.parse(row.sent_at) : NaN;
    const near = Number.isFinite(sentAtMs)
      ? (events.get(email) ?? []).filter(
        (event) => event.at >= sentAtMs - EVENT_MATCH_BEFORE_MS && event.at <= sentAtMs + EVENT_MATCH_AFTER_MS,
      )
      : [];
    // A `failed` event is the provider saying it did NOT send. Everything else
    // — delivered, opened, clicked, a bounce, a complaint — means the message
    // left here, and the slot is held on purpose.
    const reachedTheWire = near.some((event) => event.kind !== "failed");

    try {
      const { error } = await supabaseAdmin
        .from("email_send_log")
        .update({ status: reachedTheWire ? "sent" : "failed" })
        .eq("id", row.id)
        // Compare-and-set: if the original invocation finished between our read
        // and this write, it owns the outcome and we must not overwrite it.
        .eq("status", "sending");
      if (error) { result.undecided += 1; continue; }
    } catch {
      result.undecided += 1;
      continue;
    }

    if (reachedTheWire) {
      result.confirmed += 1;
    } else {
      result.released += 1;
      releasedLabels.push(`${String(row.campaign_type ?? "?")}:${String(row.reference_id ?? "-")}`);
    }
  }

  if (result.released > 0 || result.confirmed > 0) {
    await recordSystemAlert({
      type: "marketing_send_stranded",
      // Critical only when a slot was actually blocking a customer's mail. An
      // automation slot is the case that never heals on its own; the rest are
      // bookkeeping, and one standing problem must not be forty-eight pages.
      severity: releasedLabels.some((label) => label.startsWith("automation:")) ? "critical" : "warning",
      message:
        `${result.stranded} marketing send claim(s) were stranded at 'sending' past ${staleAfterMinutes} minutes. `
        + `${result.confirmed} had provider delivery evidence and were closed as sent; `
        + `${result.released} had none and were released, so the next sweep can reconsider them. `
        + (result.undecided > 0 ? `${result.undecided} could not be judged this run and will be retried. ` : "")
        + "An automation slot stranded this way blocks that recipient's message permanently until released.",
      context: {
        stranded: result.stranded,
        released: result.released,
        confirmed: result.confirmed,
        undecided: result.undecided,
        slots: releasedLabels.slice(0, 20),
      },
      dedupeWindowMs: 6 * 60 * 60 * 1000,
    }).catch(() => {});
  }

  return result;
}
