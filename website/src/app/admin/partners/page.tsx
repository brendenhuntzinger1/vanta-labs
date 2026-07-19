import { redirect } from "next/navigation";
import { AdminPartnersClient } from "@/components/admin-partners-client";
import { detectRoleFromUser } from "@/lib/auth-role";
import { getAuthenticatedUser } from "@/lib/auth-session";
import { getAdminOperationsSummary, getAdminPartnerRows } from "@/lib/partner-portal";

function currency(value: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);
}

export const dynamic = "force-dynamic";

export default async function AdminPartnersPage() {
  const user = await getAuthenticatedUser();

  if (!user || detectRoleFromUser(user) !== "admin") {
    redirect("/login");
  }

  const [rows, operations] = await Promise.all([
    getAdminPartnerRows({ status: "all" }),
    getAdminOperationsSummary(),
  ]);

  return (
    <div className="vl-page-shell min-h-screen bg-[radial-gradient(circle_at_top_right,rgba(59,130,246,0.1),transparent_52%),linear-gradient(145deg,#04060f_0%,#0b1324_50%,#060911_100%)] px-4 py-8 text-zinc-100 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-7xl space-y-6">
        <section className="vl-panel rounded-[1.8rem] p-5 sm:p-7">
          <p className="text-xs uppercase tracking-[0.28em] text-cyan-300/80">Admin Portal</p>
          <h1 className="mt-2 text-3xl font-semibold text-white sm:text-4xl">Partner Operations</h1>
          <p className="mt-3 max-w-3xl text-sm text-zinc-400 sm:text-base">
            Approve or disable partners, tune commission percentages, review live performance, and export payout records.
          </p>
        </section>

        <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
          <div className="vl-panel rounded-2xl p-4">
            <p className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">Sales Today</p>
            <p className="mt-2 text-2xl font-semibold text-white">{currency(operations.liveSalesToday)}</p>
          </div>
          <div className="vl-panel rounded-2xl p-4">
            <p className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">Sales This Month</p>
            <p className="mt-2 text-2xl font-semibold text-white">{currency(operations.liveSalesMonth)}</p>
          </div>
          <div className="vl-panel rounded-2xl p-4">
            <p className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">Customers</p>
            <p className="mt-2 text-sm text-zinc-300">New: {operations.newCustomers}</p>
            <p className="text-sm text-zinc-300">Returning: {operations.returningCustomers} ({operations.returningCustomerRate.toFixed(1)}%)</p>
          </div>
          <div className="vl-panel rounded-2xl p-4">
            <p className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">Ops Queue</p>
            <p className="mt-2 text-sm text-zinc-300">Low stock: {operations.lowStockItems}</p>
            <p className="text-sm text-zinc-300">Pending shipments: {operations.pendingShipments}</p>
          </div>
          <div className="vl-panel rounded-2xl p-4">
            <p className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">Marketing</p>
            <p className="mt-2 text-sm text-zinc-300">Active coupons: {operations.activeCoupons}</p>
            <p className="text-sm text-zinc-300">Pending emails: {operations.pendingNotifications}</p>
          </div>
        </section>

        <AdminPartnersClient initialRows={rows} />
      </div>
    </div>
  );
}
