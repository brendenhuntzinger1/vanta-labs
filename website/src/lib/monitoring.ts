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
