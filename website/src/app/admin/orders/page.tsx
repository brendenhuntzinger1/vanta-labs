import { redirect } from "next/navigation";
import { createServerClient } from "@/lib/supabase-server";
import { getAdminOrderRows, type AdminOrderRow } from "@/lib/admin-orders";

export const dynamic = "force-dynamic";

export default async function AdminOrdersPage() {
  const supabase = createServerClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    redirect("/login");
  }

  const orders = await getAdminOrderRows();

  return (
    <div className="min-h-screen bg-zinc-950 p-8 text-zinc-100">
      <div className="mx-auto max-w-7xl">
        <h1 className="text-3xl font-semibold">Admin Orders</h1>
        <p className="mt-2 text-sm text-zinc-400">Real Supabase orders and commissions.</p>
        <div className="mt-8 overflow-hidden rounded-2xl border border-zinc-800">
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
                  <td className="px-4 py-3">{order.order_id}</td>
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
