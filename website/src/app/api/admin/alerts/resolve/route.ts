import { NextResponse } from "next/server";
import { getRequestIpAddress, getRequestUserAgent, verifyAdminSessionFromRequest } from "@/lib/admin-auth";
import { supabaseAdmin } from "@/lib/supabase-server";
import { resolveSystemAlerts } from "@/lib/monitoring";

export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// CLEAR A SYSTEM ALERT.
//
// `system_alerts.resolved_at` was read by four things and written by nothing:
// the critical badge in the admin layout, /admin/status, and the two sweeps
// that ask "is this standing condition already on file?" before deciding
// whether to raise it again. With no writer, every alert ever raised stayed
// open for ever — the badge could only count up, the status list only grew, and
// the sweeps' own comments ("reported again the moment a human resolves the
// row") described an action there was no way to perform.
//
// This is that action. It writes a timestamp and nothing else: no alert is
// deleted, so the history stays intact and an operator who clears something by
// mistake loses only the open flag.
// ---------------------------------------------------------------------------

/**
 * A storm is dismissed as one thing.
 *
 * Resolving by `type` + `severity` covers every unresolved row of that group,
 * which is the only humane way to clear the forty-four repetitions of one
 * warning that made this page unreadable. Both are required together for a
 * group resolve: /admin/status groups on the pair, so a click on a warning row
 * must never reach a critical that happens to share the type name.
 */
export async function POST(request: Request) {
  const session = await verifyAdminSessionFromRequest(request);
  if (!session) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  let body: { alertIds?: unknown; type?: unknown; severity?: unknown };
  try {
    body = (await request.json()) as { alertIds?: unknown; type?: unknown; severity?: unknown };
  } catch {
    return NextResponse.json({ success: false, error: "Expected a JSON body." }, { status: 400 });
  }

  const alertIds = Array.isArray(body.alertIds)
    ? body.alertIds.filter((id): id is string => typeof id === "string" && id.trim().length > 0)
    : [];
  const type = typeof body.type === "string" && body.type.trim().length > 0 ? body.type.trim() : undefined;
  const severity = typeof body.severity === "string" && body.severity.trim().length > 0
    ? body.severity.trim()
    : undefined;

  if (alertIds.length === 0 && !type) {
    return NextResponse.json(
      { success: false, error: "Name the alerts to resolve, by id or by type." },
      { status: 400 },
    );
  }

  let resolved: number;
  try {
    resolved = await resolveSystemAlerts({ ids: alertIds, type, severity });
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Could not resolve the alert." },
      { status: 502 },
    );
  }

  // Audited like every other admin write. Clearing an alert is a statement that
  // the underlying problem was dealt with, so who said it and when is worth as
  // much as the timestamp on the row itself.
  await supabaseAdmin.from("admin_audit_logs").insert({
    action: "system_alert_resolved",
    target_table: "system_alerts",
    target_id: type ?? alertIds[0] ?? null,
    metadata: {
      type: type ?? null,
      severity: severity ?? null,
      alertIds,
      resolved,
      performedBy: session.username,
      performedAt: new Date().toISOString(),
      ipAddress: getRequestIpAddress(request),
      userAgent: getRequestUserAgent(request),
    },
  });

  return NextResponse.json({ success: true, resolved });
}
