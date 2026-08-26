import { supabaseAdmin } from "@/lib/supabase-server";
import { sendEmail } from "@/lib/email/send";
import { getBusinessSettings } from "@/lib/admin-control";

// Lightweight operational monitoring. Failure paths across the app call
// recordSystemAlert() to persist a durable alert row (viewable in admin) and,
// for CRITICAL severity, email the operator so real incidents surface without
// anyone having to watch logs. Best-effort and NEVER throws — an alert must
// never take down the flow it is reporting on.

export type AlertSeverity = "info" | "warning" | "critical";

function escapeHtml(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export async function recordSystemAlert(input: {
  type: string; // e.g. "fulfillment_failed", "webhook_error", "email_undeliverable"
  severity: AlertSeverity;
  message: string;
  context?: Record<string, unknown>;
}): Promise<void> {
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
      const recipient = process.env.ALERT_EMAIL?.trim() || (await getBusinessSettings()).supportEmail;
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
    if (error) return 0;
    return Math.max(0, count ?? 0);
  } catch {
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
