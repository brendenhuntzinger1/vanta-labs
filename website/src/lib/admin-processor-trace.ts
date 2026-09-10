import { supabaseAdmin } from "@/lib/supabase-server";

/**
 * WHAT THE PROCESSOR WAS ASKED, AND WHAT IT EVER SAID BACK.
 *
 * This is the panel whose absence cost days. On 2026-09-08 five high-value
 * orders died on a 3-D Secure challenge the shopper could not complete, and
 * answering the only two questions that mattered — "which session was this?" and
 * "did we ever hear anything from the processor about it?" — required a SQL
 * client. No admin screen showed either one. So the conversation with the
 * processor ran on screenshots and guesses, and the first thing that actually
 * settled it was a hand-written query against payment_events showing two orders
 * with ZERO rows: the charge had never reached the issuer at all.
 *
 * Both facts already exist in the database. Neither was readable.
 *
 *   sessionId  — orders.payment_id, the string you paste into the processor's
 *                dashboard to find the attempt. Without it an operator can only
 *                describe an order by time and amount.
 *   events     — payment_events rows for this order. NONE is the single most
 *                diagnostic state in the system: it means nothing was ever
 *                delivered, so whatever happened, happened before the processor
 *                had anything to tell us.
 *
 * READ-ONLY and best-effort in every part. It is a diagnostic view on an admin
 * page; a failure here must degrade the panel, never the page.
 */
export interface ProcessorTraceEvent {
  eventId: string;
  status: string | null;
  claimedAt: string | null;
  processedAt: string | null;
}

export interface ProcessorTrace {
  /** orders.payment_id — the processor's own session handle. */
  sessionId: string | null;
  /** The delivery that performed the paid flip, when one did. */
  settlingEventId: string | null;
  /** Newest first. Empty means nothing was ever delivered for this order. */
  events: ProcessorTraceEvent[];
  /** True when the events read itself failed, so "none" is not asserted wrongly. */
  eventsUnavailable: boolean;
}

/** How many deliveries to list. A retried event can produce a long tail. */
const MAX_TRACE_EVENTS = 20;

export async function getProcessorTrace(order: {
  order_id?: unknown;
  payment_id?: unknown;
  provider_event_id?: unknown;
}): Promise<ProcessorTrace> {
  const orderId = String(order.order_id ?? "").trim();
  const trace: ProcessorTrace = {
    sessionId: order.payment_id ? String(order.payment_id) : null,
    settlingEventId: order.provider_event_id ? String(order.provider_event_id) : null,
    events: [],
    eventsUnavailable: false,
  };
  if (!orderId) {
    trace.eventsUnavailable = true;
    return trace;
  }

  try {
    const { data, error } = await supabaseAdmin
      .from("payment_events")
      .select("event_id, status, claimed_at, processed_at")
      .eq("order_id", orderId)
      .order("claimed_at", { ascending: false })
      .limit(MAX_TRACE_EVENTS);
    // AN ERROR IS NOT AN EMPTY LIST, and conflating the two here would be worse
    // than showing nothing: "no webhook was ever received" is a claim an
    // operator will take to the processor, and it must never be made by a read
    // that failed.
    if (error) {
      trace.eventsUnavailable = true;
      return trace;
    }
    trace.events = ((data ?? []) as Array<Record<string, unknown>>).map((row) => ({
      eventId: String(row.event_id ?? ""),
      status: row.status ? String(row.status) : null,
      claimedAt: row.claimed_at ? String(row.claimed_at) : null,
      processedAt: row.processed_at ? String(row.processed_at) : null,
    }));
  } catch {
    trace.eventsUnavailable = true;
  }
  return trace;
}

/**
 * The one-line verdict an operator reads first.
 *
 * Deliberately plain about the difference between "the processor told us
 * nothing" and "we do not know what the processor told us" — the first is
 * evidence about the payment, the second is evidence about our database.
 */
export function describeProcessorTrace(trace: ProcessorTrace, paymentStatus: string): string {
  if (trace.eventsUnavailable) {
    return "The webhook history could not be read, so this is not evidence either way.";
  }
  if (trace.events.length === 0) {
    return trace.sessionId
      ? "No webhook has ever been received for this order. A payment session was opened, so the attempt "
        + "exists on the processor's side — look it up by the session id above."
      : "No webhook has ever been received for this order, and no payment session was ever opened, so the "
        + "card was never submitted.";
  }
  const unfinished = trace.events.filter((event) => !event.processedAt).length;
  const settled = String(paymentStatus ?? "").toLowerCase() === "paid";
  const count = trace.events.length === 1 ? "1 webhook" : `${trace.events.length} webhooks`;
  if (unfinished > 0) {
    return `${count} received; ${unfinished} never finished processing. An unfinished delivery is retried by `
      + "the sweep, so check this order again before acting on it.";
  }
  return settled
    ? `${count} received and processed. This order settled from a real processor event.`
    : `${count} received and processed, and the order is not paid — so the processor reported something `
      + "other than a successful charge.";
}
