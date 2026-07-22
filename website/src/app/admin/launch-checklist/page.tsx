import { redirect } from "next/navigation";
import { verifyAdminSessionFromCookie } from "@/lib/admin-auth";
import { getLaunchChecklist, type ChecklistStatus } from "@/lib/launch-checklist";

export const dynamic = "force-dynamic";

const STATUS_STYLES: Record<ChecklistStatus, { dot: string; badge: string; label: string }> = {
  ok: { dot: "bg-emerald-400", badge: "border-emerald-300/40 bg-emerald-300/10 text-emerald-200", label: "Ready" },
  warn: { dot: "bg-rose-500", badge: "border-rose-400/40 bg-rose-400/10 text-rose-200", label: "Action needed" },
  manual: { dot: "bg-amber-400", badge: "border-amber-300/40 bg-amber-300/10 text-amber-200", label: "Verify manually" },
};

export default async function LaunchChecklistPage() {
  const session = await verifyAdminSessionFromCookie();
  if (!session) {
    redirect("/vault");
  }

  const items = await getLaunchChecklist();
  const ready = items.filter((i) => i.status === "ok").length;
  const needsAction = items.filter((i) => i.status === "warn").length;

  return (
    <div className="vl-page-shell min-h-screen bg-[radial-gradient(circle_at_top_right,rgba(59,130,246,0.1),transparent_52%),linear-gradient(145deg,#04060f_0%,#0b1324_50%,#060911_100%)] px-4 py-8 text-zinc-100 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-4xl space-y-6">
        <section className="vl-panel rounded-[1.8rem] p-5 sm:p-7">
          <p className="text-xs uppercase tracking-[0.28em] text-cyan-300/80">Admin Portal</p>
          <h1 className="mt-2 text-3xl font-semibold text-white sm:text-4xl">Launch Checklist</h1>
          <p className="mt-3 max-w-3xl text-sm text-zinc-400 sm:text-base">
            Pre-launch readiness at a glance. Green is ready, red needs action, amber must be verified manually
            (things the server can&apos;t detect, like SSL and database backups).
          </p>
          <div className="mt-4 flex flex-wrap gap-3 text-sm">
            <span className="rounded-full border border-emerald-300/40 bg-emerald-300/10 px-3 py-1 text-emerald-200">{ready} ready</span>
            {needsAction > 0 ? <span className="rounded-full border border-rose-400/40 bg-rose-400/10 px-3 py-1 text-rose-200">{needsAction} need action</span> : null}
          </div>
        </section>

        <section className="space-y-3">
          {items.map((item) => {
            const style = STATUS_STYLES[item.status];
            return (
              <div key={item.key} className="vl-panel flex items-start gap-3 rounded-2xl p-4">
                <span className={`mt-1 h-2.5 w-2.5 shrink-0 rounded-full ${style.dot}`} aria-hidden />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-sm font-semibold text-white">{item.label}</h2>
                    <span className={`rounded-full border px-2 py-0.5 text-[11px] font-semibold ${style.badge}`}>{style.label}</span>
                  </div>
                  <p className="mt-1 text-sm text-zinc-400">{item.detail}</p>
                </div>
              </div>
            );
          })}
        </section>
      </div>
    </div>
  );
}
