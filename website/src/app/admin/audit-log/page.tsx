import { redirect } from "next/navigation";
import Link from "next/link";
import { verifyAdminSessionFromCookie } from "@/lib/admin-auth";
import { canViewAuditLog } from "@/lib/admin-roles";
import { getAuditLogRows, getAuditLogTargetTables } from "@/lib/admin-audit-log";

export const dynamic = "force-dynamic";

const METADATA_KEYS_TO_HIDE = new Set(["performedAt", "ipAddress", "userAgent", "performedBy"]);

function fmtDate(v: string | null) {
  const d = v && v !== "null" ? new Date(v) : null;
  return d && !isNaN(d.getTime()) ? d.toLocaleString() : "—";
}

function summarizeMetadata(metadata: Record<string, unknown> | null) {
  if (!metadata) return null;
  const entries = Object.entries(metadata).filter(
    ([key, value]) => !METADATA_KEYS_TO_HIDE.has(key) && value !== null && value !== undefined && value !== "",
  );
  if (entries.length === 0) return null;
  return entries.map(([key, value]) => `${key}: ${typeof value === "object" ? JSON.stringify(value) : String(value)}`).join(" • ");
}

export default async function AdminAuditLogPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const session = await verifyAdminSessionFromCookie();
  if (!session) {
    redirect("/vault");
  }

  if (!canViewAuditLog(session.role)) {
    return (
      <div className="vl-page-shell min-h-screen bg-zinc-950 px-4 py-8 text-zinc-100 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-3xl">
          <p className="vl-panel rounded-2xl p-6 text-sm text-zinc-300">
            Your role ({session.role.replace("_", " ")}) does not have permission to view the audit log.
          </p>
        </div>
      </div>
    );
  }

  const params = await searchParams;
  const action = typeof params.action === "string" ? params.action : "";
  const targetTable = typeof params.targetTable === "string" ? params.targetTable : "all";
  const includeConfigSaves = params.includeConfigSaves === "1";
  const page = Math.max(1, Number(params.page) || 1);

  const [result, targetTables] = await Promise.all([
    getAuditLogRows({ action, targetTable, includeConfigSaves, page, pageSize: 30 }).catch(() => ({ rows: [], total: 0, page: 1, pageSize: 30, pageCount: 1 })),
    getAuditLogTargetTables().catch(() => []),
  ]);

  const buildPageHref = (targetPage: number) => {
    const query = new URLSearchParams();
    if (action) query.set("action", action);
    if (targetTable !== "all") query.set("targetTable", targetTable);
    if (includeConfigSaves) query.set("includeConfigSaves", "1");
    query.set("page", String(targetPage));
    return `/admin/audit-log?${query.toString()}`;
  };

  return (
    <div className="vl-page-shell min-h-screen bg-zinc-950 px-4 py-8 text-zinc-100 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-6xl">
        <h1 className="text-2xl font-semibold sm:text-3xl">Audit Log</h1>
        <p className="mt-2 text-sm text-zinc-400">
          {result.total} event{result.total === 1 ? "" : "s"} — every admin action recorded in Supabase.
        </p>

        <form method="GET" className="vl-panel mt-6 grid gap-3 rounded-2xl p-4 sm:grid-cols-4">
          <input
            type="text"
            name="action"
            defaultValue={action}
            placeholder="Search action (e.g. refund)"
            className="vl-input px-3 py-2 text-sm sm:col-span-2"
          />
          <select name="targetTable" defaultValue={targetTable} className="vl-input px-3 py-2 text-sm">
            <option value="all">All tables</option>
            {targetTables.map((table) => (
              <option key={table} value={table}>{table}</option>
            ))}
          </select>
          <label className="flex items-center gap-2 text-sm text-zinc-300">
            <input type="checkbox" name="includeConfigSaves" value="1" defaultChecked={includeConfigSaves} />
            Include homepage/config saves
          </label>
          <div className="sm:col-span-4">
            <button type="submit" className="vl-btn-primary px-4 py-2 text-xs">Apply filters</button>
            {action || targetTable !== "all" || includeConfigSaves ? (
              <Link href="/admin/audit-log" className="ml-3 text-xs text-zinc-400 hover:text-white">Clear</Link>
            ) : null}
          </div>
        </form>

        <div className="vl-panel mt-6 overflow-x-auto rounded-2xl">
          <table className="min-w-full divide-y divide-zinc-800 text-sm">
            <thead className="bg-zinc-900/80">
              <tr>
                <th className="px-4 py-3 text-left">When</th>
                <th className="px-4 py-3 text-left">Action</th>
                <th className="px-4 py-3 text-left">Target</th>
                <th className="px-4 py-3 text-left">By</th>
                <th className="px-4 py-3 text-left">Details</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800 bg-zinc-950/70">
              {result.rows.map((row) => (
                <tr key={row.id}>
                  <td className="px-4 py-3 whitespace-nowrap text-xs text-zinc-400">{fmtDate(row.createdAt)}</td>
                  <td className="px-4 py-3 font-medium text-zinc-100">{row.action}</td>
                  <td className="px-4 py-3 text-xs text-zinc-400">
                    {row.targetTable ?? "—"}{row.targetId ? ` / ${row.targetId}` : ""}
                  </td>
                  <td className="px-4 py-3 text-xs text-zinc-400">{typeof row.metadata?.performedBy === "string" ? row.metadata.performedBy : "—"}</td>
                  <td className="px-4 py-3 text-xs text-zinc-400">{summarizeMetadata(row.metadata) ?? "—"}</td>
                </tr>
              ))}
              {result.rows.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-6 text-center text-sm text-zinc-500">No events match these filters.</td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>

        {result.pageCount > 1 ? (
          <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
            {Array.from({ length: result.pageCount }, (_, index) => index + 1).map((pageNumber) => (
              <Link
                key={pageNumber}
                href={buildPageHref(pageNumber)}
                className={pageNumber === result.page
                  ? "rounded-lg border border-cyan-300/40 bg-cyan-400/15 px-3 py-1.5 text-xs font-semibold text-cyan-100"
                  : "rounded-lg border border-white/10 bg-white/[0.03] px-3 py-1.5 text-xs text-zinc-300 hover:border-white/25 hover:text-white"}
              >
                {pageNumber}
              </Link>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
