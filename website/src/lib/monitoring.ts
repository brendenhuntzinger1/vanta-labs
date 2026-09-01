import { supabaseAdmin } from "@/lib/supabase-server";
import { sendEmail } from "@/lib/email/send";
import { getBusinessSettings, getControlSnapshot } from "@/lib/admin-control";

// Lightweight operational monitoring. Failure paths across the app call
// recordSystemAlert() to persist a durable alert row (viewable in admin) and,
// for CRITICAL severity, email the operator so real incidents surface without
// anyone having to watch logs. Best-effort and NEVER throws — an alert must
// never take down the flow it is reporting on.

export type AlertSeverity = "info" | "warning" | "critical";

function escapeHtml(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * IS AN UNRESOLVED ALERT OF THIS TYPE ALREADY ON FILE, RECENTLY ENOUGH?
 *
 * The dedup window exists because some callers report a STANDING CONDITION on a
 * path they do not control the rate of. `/api/webhooks/payment` is the extreme
 * case: it is a public endpoint, so anything on the internet that POSTs to it
 * can mint rows here at whatever rate it likes. Two sweeps had already grown
 * their own private version of this check (refund-effect-repair's
 * truncationAlreadyReported, shipping-cost-repair's state dedup); this is the
 * same idea offered once, so a caller does not have to hand-roll it.
 *
 * OPT-IN, deliberately. Most alerts are EVENTS — two fulfilment failures are
 * two facts, and collapsing them would lose one. Only a caller that knows its
 * alert is a repeating condition passes a window.
 *
 * Fails OPEN: if the check itself cannot be made, the alert is written. A
 * duplicate alert is a much smaller failure than a missing one.
 */
async function alreadyReportedWithin(type: string, windowMs: number): Promise<boolean> {
  try {
    const since = new Date(Date.now() - windowMs).toISOString();
    const { count, error } = await supabaseAdmin
      .from("system_alerts")
      .select("id", { count: "exact", head: true })
      .eq("type", type)
      .is("resolved_at", null)
      .gte("created_at", since);
    if (error) return false;
    return (count ?? 0) > 0;
  } catch {
    return false;
  }
}


/**
 * The operator address for critical alerts, from the Control Center.
 *
 * Best-effort by construction: a settings read that fails must never be what
 * stops an alert going out, so any error falls through to the env var and then
 * the support address.
 */
async function getAlertEmailSetting(): Promise<string> {
  try {
    const snapshot = await getControlSnapshot("alerts");
    const value = snapshot.alerts?.email;
    return typeof value === "string" ? value.trim() : "";
  } catch {
    return "";
  }
}

export async function recordSystemAlert(input: {
  type: string; // e.g. "fulfillment_failed", "webhook_error", "email_undeliverable"
  severity: AlertSeverity;
  message: string;
  context?: Record<string, unknown>;
  /**
   * Collapse repeats: skip this alert entirely when an UNRESOLVED alert of the
   * same type was already written within this many milliseconds. Suppresses the
   * Sentry event and the operator email too — a suppressed alert is not a
   * quieter alert, it is the same fact already on file. Resolving the row on
   * /admin/status re-opens the type immediately.
   */
  dedupeWindowMs?: number;
}): Promise<void> {
  if (input.dedupeWindowMs && input.dedupeWindowMs > 0) {
    if (await alreadyReportedWithin(input.type, input.dedupeWindowMs)) return;
  }

  try {
    await supabaseAdmin.from("system_alerts").insert({
      type: input.type,
      severity: input.severity,
      message: input.message.slice(0, 2000),
      context: input.context ?? {},
      created_at: new Date().toISOString(),
    });
  } catch {
    // Table not migrated / transient — still try to email on critical below.
  }

  // Forward to Sentry as well. This is the ONLY place webhook, cron and
  // fulfillment failures can reach it: those handlers catch their own errors
  // and return a JSON response so the sender retries rather than sees a 500,
  // which means Next.js never sees a throw and instrumentation.ts's
  // onRequestError never fires for them. They all call recordSystemAlert, so
  // hooking it once here covers them without touching a single handler.
  //
  // Best-effort and silent: an alerting path must never break the flow it is
  // reporting on. The context is scrubbed by beforeSend like any other event.
  try {
    const { sentryEnabled } = await import("@/lib/sentry-init");
    if (sentryEnabled()) {
      const Sentry = await import("@sentry/nextjs");
      Sentry.captureMessage(`${input.type}: ${input.message}`, {
        level: input.severity === "critical" ? "error" : input.severity,
        tags: { alert_type: input.type, source: "system_alert" },
        extra: input.context ?? {},
      });
    }
  } catch {
    // Never throw from the alerting path.
  }

  if (input.severity === "critical") {
    try {
      // WHERE A CRITICAL ALERT GOES, IN PRECEDENCE ORDER.
      //
      // The control setting wins over the environment variable ON PURPOSE. The
      // recipient of "your store just broke" is the one setting an operator
      // most needs to change in a hurry — a new phone-linked address, someone
      // covering while they are away — and an env var cannot be changed without
      // a redeploy. Settings > env is the wrong default for most config and the
      // right one for this.
      //
      // Falls back to the support address, which is where these went before
      // this key existed. That address is ALSO printed in customer-facing email
      // templates, which is exactly why alerts get their own key rather than
      // repurposing it: pointing alerts at a personal inbox must not put that
      // inbox in front of customers.
      const configuredAlertEmail = await getAlertEmailSetting();
      const recipient = configuredAlertEmail || process.env.ALERT_EMAIL?.trim() || (await getBusinessSettings()).supportEmail;
      if (recipient) {
        const contextJson = JSON.stringify(input.context ?? {}, null, 2);
        await sendEmail({
          to: recipient,
          subject: `⚠ Vanta Labs alert: ${input.type}`,
          html: `<p><strong>${escapeHtml(input.type)}</strong></p><p>${escapeHtml(input.message)}</p><pre style="font-size:12px;white-space:pre-wrap;">${escapeHtml(contextJson)}</pre>`,
          text: `${input.type}\n${input.message}\n\n${contextJson}`,
        });
      }
    } catch {
      // Never throw from the alerting path.
    }
  }
}

export interface SystemAlertRow {
  id: string;
  type: string;
  severity: string;
  message: string;
  context: Record<string, unknown> | null;
  created_at: string;
  resolved_at: string | null;
}

/**
 * How many CRITICAL alerts are still unresolved.
 *
 * For the nav and dashboard badges. Production currently carries two genuine
 * criticals — a 3PL transmit failure and an unattributed Shippo label — buried
 * under forty-four repetitions of one warning, with nothing on any screen
 * saying they exist. A count is what makes them findable.
 *
 * Counts rows rather than fetching them, and answers 0 rather than throwing:
 * this runs in the admin layout on every page, and a monitoring read must
 * never be what takes the console down.
 */
export async function getOpenCriticalAlertCount(): Promise<number> {
  try {
    const { count, error } = await supabaseAdmin
      .from("system_alerts")
      .select("id", { count: "exact", head: true })
      .eq("severity", "critical")
      .is("resolved_at", null);
    // Still 0, still never throws — but no longer SILENT. A failed read here is
    // indistinguishable on screen from "no criticals open", which is the exact
    // reading an operator acts on by doing nothing. The badge cannot say so
    // without widening this to `number | null` and changing both consumers, so
    // at minimum the failure reaches the logs.
    if (error) {
      console.error("Critical-alert count read failed; badge may understate", error);
      return 0;
    }
    return Math.max(0, count ?? 0);
  } catch (err) {
    console.error("Critical-alert count read threw; badge may understate", err);
    return 0;
  }
}

// For an admin monitoring surface. Returns [] if the table isn't migrated.
export async function getRecentSystemAlerts(limit = 100): Promise<SystemAlertRow[]> {
  try {
    const { data, error } = await supabaseAdmin
      .from("system_alerts")
      .select("id, type, severity, message, context, created_at, resolved_at")
      .order("created_at", { ascending: false })
      .limit(limit);
    if (error || !data) return [];
    return data as SystemAlertRow[];
  } catch {
    return [];
  }
}

/**
 * THE UNRESOLVED ALERTS, filtered in the DATABASE rather than in the page.
 *
 * /admin/status used to read the 100 (in practice 10) most recent alerts of ANY
 * state and drop the resolved ones afterwards. That is the whole of the
 * badge-vs-page disagreement: a warning that repeats every thirty minutes fills
 * the window, so the two genuine criticals the badge counts fall off the end of
 * the page and the operator is told "4 critical" above a list showing two.
 *
 * `severity` narrows the SAME query so the criticals can be fetched on their
 * own budget, which is what lets the page guarantee it shows every critical the
 * badge counted. Returns [] rather than throwing — this is a monitoring read.
 */
export async function getOpenSystemAlerts(options?: {
  severity?: AlertSeverity;
  limit?: number;
}): Promise<SystemAlertRow[]> {
  try {
    let query = supabaseAdmin
      .from("system_alerts")
      .select("id, type, severity, message, context, created_at, resolved_at")
      .is("resolved_at", null);
    if (options?.severity) query = query.eq("severity", options.severity);
    const { data, error } = await query
      .order("created_at", { ascending: false })
      .limit(options?.limit ?? 100);
    if (error || !data) return [];
    return data as SystemAlertRow[];
  } catch {
    return [];
  }
}

/**
 * Mark alerts resolved. THE ONLY WRITER of `resolved_at`.
 *
 * Three code paths read this column — the critical badge, /admin/status, and
 * the two sweeps that ask "is this standing condition already reported?" — and
 * until now nothing anywhere wrote it. Every alert ever raised was therefore
 * permanently open: 52 of them in production, the badge could only ever count
 * up, and the sweeps' "reported again the moment a human resolves the row"
 * comments described an action no human could take.
 *
 * Idempotent and guarded on `resolved_at is null`, so re-resolving an alert
 * cannot rewrite the timestamp of one someone else already cleared. Returns how
 * many rows this call actually cleared.
 */
export async function resolveSystemAlerts(input: {
  /** Resolve exactly these rows. Used only when no group is named. */
  ids?: string[];
  /**
   * Resolve a whole GROUP: every unresolved alert of this type, and — when
   * given — this severity. That is how a storm is dismissed, and it is a
   * deliberate superset of what the operator saw: repetitions that arrived
   * between the page rendering and the click are the same fact, so leaving
   * them behind would make the list look half-cleared.
   *
   * SEVERITY NARROWS IT, and must. /admin/status groups on severity as well as
   * type precisely so a type that has raised both a warning and a critical
   * shows two rows. Resolving by type alone would let a click on the warning
   * silently clear the critical hiding behind the same name — the badge would
   * drop by one with nothing on screen explaining why.
   */
  type?: string;
  severity?: string;
}): Promise<number> {
  const ids = (input.ids ?? []).filter((id) => typeof id === "string" && id.length > 0);
  const type = input.type?.trim();

  let query = supabaseAdmin
    .from("system_alerts")
    .update({ resolved_at: new Date().toISOString() })
    .is("resolved_at", null);

  if (type) {
    // A group, not an intersection: ANDing the ids in would pin the result to
    // the rows that happened to be on screen and defeat the point.
    query = query.eq("type", type);
    if (input.severity) query = query.eq("severity", input.severity);
  } else if (ids.length > 0) {
    query = query.in("id", ids);
  } else {
    return 0;
  }

  const { data, error } = await query.select("id");
  if (error) throw error;
  return (data ?? []).length;
}

/**
 * One line per KIND of alert, not one per row.
 *
 * Forty-four repetitions of `shipping_cost_manual_entry_required` are one fact
 * an operator needs to see once, with a count — not forty-four rows that push
 * everything else off the screen. Grouping is what lets a fixed-height list
 * still contain every distinct problem.
 *
 * Pure and exported so the ordering guarantee can be tested without a database:
 * criticals first, then warnings, then everything else, each newest-first.
 * Deduplicates by id, because the page deliberately fetches criticals and
 * recent alerts as two overlapping queries.
 */
export interface AlertGroup {
  /** The newest alert in the group — what the row renders. */
  latest: SystemAlertRow;
  /** How many unresolved alerts of this type are in hand. */
  occurrences: number;
  /** Every id in the group, so "resolve" can clear the whole storm. */
  ids: string[];
}

const SEVERITY_RANK: Record<string, number> = { critical: 0, warning: 1, info: 2 };

export function groupOpenAlerts(rows: SystemAlertRow[]): AlertGroup[] {
  const seen = new Set<string>();
  const byType = new Map<string, AlertGroup>();

  for (const row of rows) {
    if (!row || seen.has(row.id)) continue;
    seen.add(row.id);
    // Severity is part of the key: a type that has raised both a warning and a
    // critical must not have the critical hidden inside a warning row.
    const key = `${row.severity}::${row.type}`;
    const existing = byType.get(key);
    if (!existing) {
      byType.set(key, { latest: row, occurrences: 1, ids: [row.id] });
      continue;
    }
    existing.occurrences += 1;
    existing.ids.push(row.id);
    if (row.created_at > existing.latest.created_at) existing.latest = row;
  }

  return [...byType.values()].sort((a, b) => {
    const rank = (severity: string) => SEVERITY_RANK[severity] ?? 3;
    const bySeverity = rank(a.latest.severity) - rank(b.latest.severity);
    if (bySeverity !== 0) return bySeverity;
    return b.latest.created_at.localeCompare(a.latest.created_at);
  });
}

/**
 * How many order links one alert may render.
 *
 * The shipping sweeps cap their own backlogs at the scan ceiling, so this is a
 * backstop rather than the usual bound: a future alert that names a thousand
 * orders should not turn the status page into a wall of links.
 */
const MAX_ALERT_ORDER_LINKS = 50;

/**
 * THE ORDER IDS AN ALERT IS ABOUT, SO THE OPERATOR CAN GO AND ACT ON THEM.
 *
 * `shipping_cost_manual_entry_required` reads, in production: "2 order(s) have
 * a label whose postage cannot be read back from Shippo. Enter the cost by hand
 * in Admin -> Orders." Which two? The sweep is the only thing that knows, it
 * puts them in `context`, and the status page rendered `message` alone -- so
 * the operator was sent to fix orders they had no way to identify.
 *
 * Shape-tolerant on purpose. The sweeps do not agree on how they carry ids:
 * the shipping backlogs write BOTH a flat `orderIds` and an `orders[]` of
 * `{ orderId, error }`, while single-order alerts write a bare `orderId`. A
 * reader that understood only one of them would silently render nothing for
 * the rest, which is the failure it exists to fix.
 */
export function extractAlertOrderIds(context: Record<string, unknown> | null | undefined): string[] {
  if (!context) return [];

  const seen = new Set<string>();
  const out: string[] = [];

  const take = (candidate: unknown): void => {
    if (typeof candidate !== "string") return;
    const id = candidate.trim();
    // A blank string is not an id, and linking one produces /admin/orders/ —
    // the orders list, wearing the label of a specific order.
    if (id.length === 0 || seen.has(id)) return;
    seen.add(id);
    out.push(id);
  };

  take(context.orderId);
  if (Array.isArray(context.orderIds)) {
    for (const entry of context.orderIds) take(entry);
  }
  if (Array.isArray(context.orders)) {
    for (const entry of context.orders) {
      if (entry && typeof entry === "object") take((entry as { orderId?: unknown }).orderId);
    }
  }

  return out.slice(0, MAX_ALERT_ORDER_LINKS);
}
