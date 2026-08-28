import { redirect } from "next/navigation";
import { verifyAdminSessionFromCookie } from "@/lib/admin-auth";
import { getSystemStatus, type StatusLevel } from "@/lib/system-status";
import { getOpenSystemAlerts, groupOpenAlerts } from "@/lib/monitoring";
import { AdminSystemAlertRow } from "@/components/admin-system-alert-row";
import { CheckoutPreflight } from "@/components/checkout-preflight";
import { InventoryReservationCheck } from "@/components/inventory-reservation-check";

export const dynamic = "force-dynamic";

const LEVEL_STYLES: Record<StatusLevel, { dot: string; label: string; text: string }> = {
  ok: { dot: "bg-emerald-400", label: "Live", text: "text-emerald-300" },
  warn: { dot: "bg-amber-400", label: "Check", text: "text-amber-300" },
  not_configured: { dot: "bg-zinc-500", label: "Not set up", text: "text-zinc-400" },
  error: { dot: "bg-rose-500", label: "Problem", text: "text-rose-300" },
};

export default async function AdminStatusPage() {
  const session = await verifyAdminSessionFromCookie();
  if (!session) {
    redirect("/vault");
  }

  // TWO QUERIES, ON PURPOSE.
  //
  // This page used to read the ten most recent alerts of any severity and drop
  // the resolved ones afterwards — which is the whole of the badge-vs-page
  // disagreement. Production carried 44 repetitions of one warning against 4
  // criticals: the warnings owned the ten-row window, so the badge said "4
  // critical" above a list showing two, and an operator had no way to reach the
  // other two from any screen.
  //
  // Fetching the criticals on their own budget is what makes the two agree. The
  // badge counts unresolved criticals; this query returns unresolved criticals;
  // the grouping below cannot drop one, because it only ever folds rows of the
  // same type together and reports the count.
  const [statuses, criticalAlerts, recentAlerts] = await Promise.all([
    getSystemStatus(),
    getOpenSystemAlerts({ severity: "critical", limit: 200 }).catch(() => []),
    getOpenSystemAlerts({ limit: 100 }).catch(() => []),
  ]);
  const blockers = statuses.filter((s) => s.blocksLaunch && (s.level === "not_configured" || s.level === "error"));
  const readyForOrders = blockers.length === 0;
  // Criticals first so a storm in the second query cannot displace one; the
  // grouping deduplicates the overlap between the two.
  const alertGroups = groupOpenAlerts([...criticalAlerts, ...recentAlerts]);
  const openCriticals = criticalAlerts.length;

  return (
    <div className="vl-page-shell min-h-screen bg-zinc-950 px-4 py-8 text-zinc-100 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-3xl">
        <h1 className="text-2xl font-semibold text-white">System Status</h1>
        <p className="mt-1 text-sm text-zinc-400">
          Live view of every integration. No secrets are shown. Refresh to re-check.
        </p>

        <div className="mt-6 space-y-6">
          <InventoryReservationCheck />
          <CheckoutPreflight />
        </div>

        <div className={`mt-6 rounded-2xl border p-5 ${readyForOrders ? "border-emerald-400/30 bg-emerald-400/[0.06]" : "border-amber-400/30 bg-amber-400/[0.06]"}`}>
          <p className="text-sm font-semibold text-white">
            {readyForOrders ? "✅ Ready to take real orders" : "⏳ Not ready for live orders yet"}
          </p>
          <p className="mt-1 text-sm text-zinc-300">
            {readyForOrders
              ? "Every launch-critical integration is configured. You can open checkout (CHECKOUT_ENABLED=true)."
              : `Waiting on: ${blockers.map((b) => b.label).join(", ")}.`}
          </p>
        </div>

        <div className="mt-6 divide-y divide-white/5 overflow-hidden rounded-2xl border border-white/10">
          {statuses.map((s) => {
            const style = LEVEL_STYLES[s.level];
            return (
              <div key={s.key} className="flex items-start justify-between gap-4 bg-white/[0.02] p-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className={`inline-block h-2.5 w-2.5 flex-shrink-0 rounded-full ${style.dot}`} aria-hidden />
                    <span className="text-sm font-medium text-white">{s.label}</span>
                    {s.blocksLaunch ? (
                      <span className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-zinc-400">Launch-critical</span>
                    ) : null}
                  </div>
                  <p className="mt-1 pl-[18px] text-xs text-zinc-400">{s.detail}</p>
                </div>
                <span className={`flex-shrink-0 text-xs font-semibold ${style.text}`}>{style.label}</span>
              </div>
            );
          })}
        </div>

        <div className="mt-8">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-400">Open alerts</h2>
            {/* The same number the nav badge shows, stated next to the list it
                describes. When they disagree, that is now visible here rather
                than only to someone counting rows. */}
            <span className={`text-xs ${openCriticals > 0 ? "text-rose-300" : "text-zinc-500"}`}>
              {openCriticals} unresolved critical{openCriticals === 1 ? "" : "s"}
            </span>
          </div>
          {alertGroups.length === 0 ? (
            <p className="mt-2 rounded-xl border border-white/10 bg-white/[0.02] p-4 text-sm text-zinc-400">
              No unresolved system alerts. 🎉 Failures (payment, email, cron, fulfillment) will appear here.
            </p>
          ) : (
            <div className="mt-2 divide-y divide-white/5 overflow-hidden rounded-xl border border-white/10">
              {alertGroups.map((group) => (
                <AdminSystemAlertRow
                  key={`${group.latest.severity}::${group.latest.type}`}
                  alert={group.latest}
                  occurrences={group.occurrences}
                  alertIds={group.ids}
                />
              ))}
            </div>
          )}
        </div>

        <p className="mt-4 text-xs text-zinc-500">
          Signed in as {session.username}. This page reads configuration only — it never displays API keys or secrets.
        </p>
      </div>
    </div>
  );
}
