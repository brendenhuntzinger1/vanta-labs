import { redirect } from "next/navigation";
import Link from "next/link";
import { verifyAdminSessionFromCookie } from "@/lib/admin-auth";
import { getAdminOrderRows } from "@/lib/admin-orders";
import { listAdminProducts } from "@/lib/admin-products";
import { getAdminPartnerRows } from "@/lib/partner-portal";
import { AdminControlCenterClient } from "@/components/admin-control-center-client";

export const dynamic = "force-dynamic";

function money(value: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);
}

export default async function AdminHomePage() {
  const session = await verifyAdminSessionFromCookie();
  if (!session) {
    redirect("/vault");
  }

  const [orders, products, partners] = await Promise.all([
    getAdminOrderRows().catch(() => []),
    listAdminProducts({ search: "", category: "all", status: "all" }).catch(() => []),
    getAdminPartnerRows({ status: "all" }).catch(() => []),
  ]);

  const totalRevenue = orders.reduce((sum, row) => sum + Number(row.amount_paid ?? 0), 0);
  const publishedProducts = products.filter((product) => product.isPublished && product.isEnabled && !product.isArchived).length;
  const pendingPartners = partners.filter((partner) => partner.status === "pending").length;

  return (
    <div className="vl-page-shell min-h-screen bg-zinc-950 px-4 py-8 text-zinc-100 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-7xl space-y-6">
        <section className="vl-panel rounded-[1.8rem] p-5 sm:p-7">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <p className="text-xs uppercase tracking-[0.28em] text-zinc-400">Admin Control</p>
              <h1 className="mt-2 text-3xl font-semibold text-white sm:text-4xl">Store Operations Dashboard</h1>
              <p className="mt-3 max-w-3xl text-sm text-zinc-400 sm:text-base">
                Manage products, orders, promotions, homepage content, and settings without editing code or database records directly.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Link href="/admin/products" className="vl-btn-secondary px-4 py-2 text-xs">Products</Link>
              <Link href="/admin/orders" className="vl-btn-secondary px-4 py-2 text-xs">Orders</Link>
              <Link href="/admin/partners" className="vl-btn-secondary px-4 py-2 text-xs">Partners</Link>
            </div>
          </div>
        </section>

        <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="vl-panel rounded-2xl p-4">
            <p className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">Orders</p>
            <p className="mt-2 text-2xl font-semibold text-white">{orders.length}</p>
          </div>
          <div className="vl-panel rounded-2xl p-4">
            <p className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">Revenue</p>
            <p className="mt-2 text-2xl font-semibold text-white">{money(totalRevenue)}</p>
          </div>
          <div className="vl-panel rounded-2xl p-4">
            <p className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">Published Products</p>
            <p className="mt-2 text-2xl font-semibold text-white">{publishedProducts}</p>
          </div>
          <div className="vl-panel rounded-2xl p-4">
            <p className="text-[11px] uppercase tracking-[0.22em] text-zinc-500">Pending Partners</p>
            <p className="mt-2 text-2xl font-semibold text-white">{pendingPartners}</p>
          </div>
        </section>

        <AdminControlCenterClient />
      </div>
    </div>
  );
}