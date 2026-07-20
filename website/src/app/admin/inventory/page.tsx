import { redirect } from "next/navigation";
import { verifyAdminSessionFromCookie } from "@/lib/admin-auth";
import { canManageInventory } from "@/lib/admin-roles";
import { getInventoryRows } from "@/lib/admin-inventory";
import { AdminInventoryClient } from "@/components/admin-inventory-client";

export const dynamic = "force-dynamic";

export default async function AdminInventoryPage() {
  const session = await verifyAdminSessionFromCookie();
  if (!session) {
    redirect("/vault");
  }

  const rows = await getInventoryRows();
  const lowStockCount = rows.filter((row) => row.isLowStock || row.isOutOfStock).length;

  return (
    <div className="vl-page-shell min-h-screen bg-[radial-gradient(circle_at_top_right,rgba(59,130,246,0.1),transparent_52%),linear-gradient(145deg,#04060f_0%,#0b1324_50%,#060911_100%)] px-4 py-8 text-zinc-100 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-6xl space-y-6">
        <section className="vl-panel rounded-[1.8rem] p-5 sm:p-7">
          <p className="text-xs uppercase tracking-[0.28em] text-cyan-300/80">Admin Portal</p>
          <h1 className="mt-2 text-3xl font-semibold text-white sm:text-4xl">Inventory</h1>
          <p className="mt-3 max-w-3xl text-sm text-zinc-400 sm:text-base">
            Live stock counts from every product and variant, with per-line low-stock thresholds.
            {lowStockCount > 0 ? ` ${lowStockCount} line${lowStockCount === 1 ? "" : "s"} need attention.` : " Everything is stocked above threshold."}
          </p>
        </section>

        <AdminInventoryClient initialRows={rows} canManage={canManageInventory(session.role)} />
      </div>
    </div>
  );
}
