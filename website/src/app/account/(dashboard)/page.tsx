import { redirect } from "next/navigation";
import { detectRoleFromUser } from "@/lib/auth-role";
import { getAuthenticatedUser } from "@/lib/auth-session";
import { getCustomerOrders } from "@/lib/customer-account";
import { ReorderButton } from "@/components/reorder-button";

function money(value: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);
}

function statusLabel(value: string) {
  return value.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

export default async function AccountDashboardPage() {
  const user = await getAuthenticatedUser();
  if (!user || detectRoleFromUser(user) !== "customer" || !user.email) {
    redirect("/account/login");
  }

  const orders = await getCustomerOrders(user.email);

  return (
    <div className="space-y-6">
      <section className="vl-panel rounded-2xl p-5 sm:p-6">
        <h1 className="text-2xl font-semibold text-white">Your Orders</h1>
        <p className="mt-2 text-sm text-zinc-400">
          {orders.length} order{orders.length === 1 ? "" : "s"} placed with {user.email}.
        </p>
      </section>

      {orders.length === 0 ? (
        <section className="vl-panel rounded-2xl p-6 text-sm text-zinc-400">
          No orders yet.
        </section>
      ) : (
        <div className="space-y-4">
          {orders.map((order) => (
            <section key={order.orderId} className="vl-panel rounded-2xl p-5 sm:p-6">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="text-xs uppercase tracking-[0.2em] text-zinc-500">Order</p>
                  <p className="mt-1 break-all text-sm font-semibold text-white">{order.orderId}</p>
                  <p className="mt-1 text-xs text-zinc-500">{new Date(order.createdAt).toLocaleString()}</p>
                </div>
                <div className="text-right">
                  <p className="text-lg font-semibold text-white">{money(order.amountPaid)}</p>
                  <p className="text-xs text-zinc-400">{statusLabel(order.paymentStatus)} • {statusLabel(order.fulfillmentStatus)}</p>
                  {order.trackingNumber ? (
                    <p className="mt-1 text-xs text-cyan-300">Tracking: {order.trackingNumber}</p>
                  ) : null}
                </div>
              </div>

              <ul className="mt-4 space-y-1.5 border-t border-white/10 pt-4 text-sm text-zinc-300">
                {order.items.map((item, index) => (
                  <li key={`${order.orderId}-${index}`} className="flex justify-between gap-3">
                    <span>{item.productName} × {item.quantity}</span>
                    <span className="text-zinc-400">{money(item.lineTotal)}</span>
                  </li>
                ))}
              </ul>

              <div className="mt-4 border-t border-white/10 pt-4">
                <ReorderButton orderId={order.orderId} />
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
