import { redirect } from "next/navigation";
import Link from "next/link";
import { verifyAdminSessionFromCookie } from "@/lib/admin-auth";
import { getAdminOrderRows, type AdminOrderRow } from "@/lib/admin-orders";

export const dynamic = "force-dynamic";

export default async function AdminOrdersPage() {
  const session = await verifyAdminSessionFromCookie();
  if (!session) {
    redirect("/vault");
  }

  const orders = await getAdminOrderRows();

  return (
    <div className="vl-page-shell min-h-screen bg-zinc-950 px-4 py-8 text-zinc-100 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-7xl">
        <h1 className="text-2xl font-semibold sm:text-3xl">Admin Orders</h1>
        <p className="mt-2 text-sm text-zinc-400">Real Supabase orders and commissions.</p>
        <div className="mt-4">
          <Link href="/api/admin/orders/export" className="vl-btn-secondary inline-flex px-4 py-2 text-xs">
            Export Orders CSV
          </Link>
        </div>

        <div className="mt-6 grid gap-3 sm:hidden">
          {orders.map((order: AdminOrderRow) => (
            <article key={order.id} className="vl-panel rounded-xl p-4">
              <p className="text-xs uppercase tracking-[0.2em] text-zinc-500">Order</p>
              <p className="mt-1 text-sm font-semibold text-white break-all">{order.order_id}</p>
              <div className="mt-3 space-y-1.5 text-sm text-zinc-300">
                <p><span className="text-zinc-500">Customer:</span> {order.customer_email}</p>
                <p><span className="text-zinc-500">Items:</span> {order.item_count}</p>
                <p><span className="text-zinc-500">Amount:</span> ${order.amount_paid.toFixed(2)}</p>
                <p><span className="text-zinc-500">Referral:</span> {order.referral_code ?? "-"}</p>
                <p><span className="text-zinc-500">Status:</span> {order.payment_status}</p>
              </div>
              <Link href={`/admin/orders/${order.order_id}`} className="mt-3 inline-flex text-xs text-zinc-200 underline-offset-4 hover:underline">
                Open order
              </Link>
            </article>
          ))}
        </div>

        <div className="vl-panel mt-8 hidden overflow-x-auto rounded-2xl sm:block">
          <table className="min-w-full divide-y divide-zinc-800 text-sm">
            <thead className="bg-zinc-900/80">
              <tr>
                <th className="px-4 py-3 text-left">Order</th>
                <th className="px-4 py-3 text-left">Customer</th>
                <th className="px-4 py-3 text-left">Items</th>
                <th className="px-4 py-3 text-left">Amount</th>
                <th className="px-4 py-3 text-left">Referral</th>
                <th className="px-4 py-3 text-left">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800 bg-zinc-950/70">
              {orders.map((order: AdminOrderRow) => (
                <tr key={order.id}>
                  <td className="px-4 py-3"><Link href={`/admin/orders/${order.order_id}`} className="hover:underline">{order.order_id}</Link></td>
                  <td className="px-4 py-3">{order.customer_email}</td>
                  <td className="px-4 py-3">{order.item_count}</td>
                  <td className="px-4 py-3">${order.amount_paid.toFixed(2)}</td>
                  <td className="px-4 py-3">{order.referral_code ?? "—"}</td>
                  <td className="px-4 py-3">{order.payment_status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
