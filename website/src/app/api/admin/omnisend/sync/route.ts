import { NextResponse } from "next/server";
import { getRequestIpAddress, getRequestUserAgent, verifyAdminSessionFromRequest } from "@/lib/admin-auth";
import { canManageEmailCampaigns } from "@/lib/admin-roles";
import { syncOmnisendCatalog } from "@/lib/marketing/omnisend/catalog-sync";
import { snapshotOmnisendConsent } from "@/lib/marketing/omnisend/migration-snapshot";
import { reconcileOmnisendContacts } from "@/lib/marketing/omnisend/reconcile";
import { defaultSnapshotLabel, isValidSnapshotLabel } from "@/lib/marketing/omnisend/reconcile-plan";
import { supabaseAdmin } from "@/lib/supabase-server";

/**
 * "Run the Omnisend sync now" (design spec §4): the contacts reconcile or the
 * catalogue push, on demand, with a dry-run report so the owner can see what
 * WOULD be pushed before anything is; and the consent snapshot, taken before
 * the first live push so the migration can be checked afterwards
 * (docs/omnisend/MIGRATION.md). Body: `{ what: "contacts" | "catalog" |
 * "snapshot", dryRun?: boolean, label?: string }`. The contacts result
 * carries the reconciliation report; nothing returned names an address.
 *
 * Gated exactly as the email automations route is — an admin session AND a
 * role that may manage email campaigns — because a contacts push hands every
 * consented address to a third party, which is a marketing decision, not a
 * support one. None of the jobs throws; the try below is defence in depth,
 * and what it returns is a fixed sentence, never the error.
 */

export const dynamic = "force-dynamic";
// The reconcile pages the audience and posts it in batches; a cron-sized
// window rather than the default ten seconds.
export const maxDuration = 60;

export async function POST(request: Request) {
  const session = await verifyAdminSessionFromRequest(request);
  if (!session) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }
  if (!canManageEmailCampaigns(session.role)) {
    return NextResponse.json({ success: false, error: "Your role does not have permission to run the Omnisend sync." }, { status: 403 });
  }

  const body = await request.json().catch(() => null) as Record<string, unknown> | null;
  const what = body?.what;
  const dryRun = body?.dryRun === true;
  const label = typeof body?.label === "string" && body.label.trim() ? body.label.trim() : defaultSnapshotLabel();
  if (what !== "contacts" && what !== "catalog" && what !== "snapshot") {
    return NextResponse.json({ success: false, error: 'Unknown sync. Use "contacts", "catalog" or "snapshot".' }, { status: 400 });
  }
  if (what === "snapshot" && !isValidSnapshotLabel(label)) {
    return NextResponse.json({ success: false, error: "A snapshot label is 1 to 64 letters, digits or hyphens." }, { status: 400 });
  }

  try {
    const result = what === "contacts"
      ? await reconcileOmnisendContacts({ dryRun })
      : what === "catalog"
        ? await syncOmnisendCatalog()
        : await snapshotOmnisendConsent({ label });

    // A manual push to a third party is worth a line in the audit log: "who
    // sent the list to Omnisend, and when" should have an answer.
    try {
      await supabaseAdmin.from("admin_audit_logs").insert({
        action: "omnisend_sync_run",
        target_table: "omnisend_sync_state",
        target_id: what,
        metadata: {
          what,
          dryRun,
          ...(what === "snapshot" ? { label } : {}),
          result,
          performedAt: new Date().toISOString(),
          performedBy: session.username,
          ipAddress: getRequestIpAddress(request),
          userAgent: getRequestUserAgent(request),
        },
      });
    } catch {
      // Best-effort: the sync already ran and its result is what matters here.
    }

    return NextResponse.json({ success: true, result });
  } catch (error) {
    console.error("[admin/omnisend/sync] run failed", { what, dryRun, error });
    return NextResponse.json({ success: false, error: "The Omnisend sync could not be run." }, { status: 500 });
  }
}
