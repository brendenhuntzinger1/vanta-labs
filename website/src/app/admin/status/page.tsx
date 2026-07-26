import { redirect } from "next/navigation";
import { verifyAdminSessionFromCookie } from "@/lib/admin-auth";
import { getSystemStatus, type StatusLevel } from "@/lib/system-status";

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

  const statuses = await getSystemStatus();
  const blockers = statuses.filter((s) => s.blocksLaunch && (s.level === "not_configured" || s.level === "error"));
  const readyForOrders = blockers.length === 0;

  return (
    <div className="vl-page-shell min-h-screen bg-zinc-950 px-4 py-8 text-zinc-100 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-3xl">
        <h1 className="text-2xl font-semibold text-white">System Status</h1>
        <p className="mt-1 text-sm text-zinc-400">
          Live view of every integration. No secrets are shown. Refresh to re-check.
        </p>

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

        <p className="mt-4 text-xs text-zinc-500">
          Signed in as {session.username}. This page reads configuration only — it never displays API keys or secrets.
        </p>
      </div>
    </div>
  );
}
