import { redirect } from "next/navigation";
import Link from "next/link";
import { verifyAdminSessionFromCookie } from "@/lib/admin-auth";
import { canManageRefunds } from "@/lib/admin-roles";
import { getReconciliationFlags, RECONCILIATION_FLAG_LABELS, type ReconciliationFlagType } from "@/lib/admin-reconciliation";

export const dynamic = "force-dynamic";

export default async function AdminReconciliationPage() {
  const session = await verifyAdminSessionFromCookie();
  if (!session) {
    redirect("/vault");
  }

  const canView = canManageRefunds(session.role);
  const flags = canView ? await getReconciliationFlags() : [];

  const countsByType = flags.reduce((acc, flag) => {
    acc[flag.type] = (acc[flag.type] ?? 0) + 1;
    return acc;
  }, {} as Record<ReconciliationFlagType, number>);

  return (
    <div className="vl-page-shell min-h-screen bg-zinc-950 px-4 py-8 text-zinc-100 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-6xl">
        <h1 className="text-2xl font-semibold sm:text-3xl">Reconciliation</h1>
        <p className="mt-2 max-w-3xl text-sm text-zinc-400">
          Internal ledger consistency checks over the most recent 2,000 orders - not a reconciliation against a real
          payment processor, since none is connected yet. Once a live processor is wired up, cross-check its own
          reports too; this view only catches inconsistencies inside this store&apos;s own records.
        </p>

        {!canView ? (
          <p className="vl-panel mt-6 rounded-2xl p-6 text-sm text-zinc-300">
            Your role ({session.role.replace("_", " ")}) does not have permission to view reconciliation.
          </p>
        ) : (
          <>
            <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {(Object.keys(RECONCILIATION_FLAG_LABELS) as ReconciliationFlagType[]).map((type) => (
                <div key={type} className="vl-panel rounded-2xl p-4">
                  <p className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">{RECONCILIATION_FLAG_LABELS[type]}</p>
                  <p className="mt-2 text-2xl font-semibold text-white">{countsByType[type] ?? 0}</p>
                </div>
              ))}
            </div>

            <div className="vl-panel mt-6 overflow-x-auto rounded-2xl">
              <table className="min-w-full divide-y divide-zinc-800 text-sm">
                <thead className="bg-zinc-900/80">
                  <tr>
                    <th className="px-4 py-3 text-left">Order</th>
                    <th className="px-4 py-3 text-left">Customer</th>
                    <th className="px-4 py-3 text-left">Flag</th>
                    <th className="px-4 py-3 text-left">Detail</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-800 bg-zinc-950/70">
                  {flags.map((flag, index) => (
                    <tr key={`${flag.orderId}-${flag.type}-${index}`}>
                      <td className="px-4 py-3"><Link href={`/admin/orders/${flag.orderId}`} className="hover:underline">{flag.orderId}</Link></td>
                      <td className="px-4 py-3 text-zinc-400">{flag.customerEmail ?? "—"}</td>
                      <td className="px-4 py-3">{RECONCILIATION_FLAG_LABELS[flag.type]}</td>
                      <td className="px-4 py-3 text-xs text-zinc-400">{flag.detail}</td>
                    </tr>
                  ))}
                  {flags.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="px-4 py-6 text-center text-sm text-zinc-500">No inconsistencies found.</td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
