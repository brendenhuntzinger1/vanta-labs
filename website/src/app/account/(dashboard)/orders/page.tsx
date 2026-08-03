import Link from "next/link";
import Image from "next/image";
import { redirect } from "next/navigation";
import { detectRoleFromUser } from "@/lib/auth-role";
import { getAuthenticatedUser } from "@/lib/auth-session";
import { getCustomerOrdersDetailed } from "@/lib/account-orders";
import { getOrderProgress, isUnpaid, statusLabel } from "@/lib/order-status";
import { OrderTracking } from "@/components/order-tracking";
import { ReorderButton } from "@/components/reorder-button";
import { displayOrderReference } from "@/lib/order-reference";

export const dynamic = "force-dynamic";

function money(value: number, currency = "USD") {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(value);
}

export default async function AccountOrdersPage() {
  const user = await getAuthenticatedUser();
  if (!user || detectRoleFromUser(user) !== "customer") {
    redirect("/account/login");
  }

  const orders = await getCustomerOrdersDetailed(user.id, user.email).catch(() => []);

  return (
    <div className="space-y-5">
      <header className="vl-fade-up">
        <p className="text-[11px] uppercase tracking-[0.24em] text-zinc-500">Account</p>
        <h1 className="vl2-serif mt-1.5 text-3xl text-white sm:text-4xl">Your orders</h1>
        <p className="mt-2 text-sm text-zinc-400">
          {orders.length === 0 ? "Everything you order will live here." : `${orders.length} order${orders.length === 1 ? "" : "s"} · track, reorder, and download receipts.`}
        </p>
      </header>

      {orders.length === 0 ? (
        <section className="vl-panel rounded-2xl p-10 text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full border border-white/12 bg-white/[0.03] text-2xl">📦</div>
          <h2 className="mt-5 text-lg font-semibold text-white">No orders yet</h2>
          <p className="mx-auto mt-2 max-w-sm text-sm text-zinc-500">
            When you place your first order it&apos;ll appear here with live tracking, receipts, and one-tap reorder.
          </p>
          <Link href="/products" className="vl2-btn-primary vl-focus-ring mt-6 inline-flex px-6 py-3 text-sm">Browse products</Link>
        </section>
      ) : (
        <div className="space-y-4">
          {orders.map((order) => {
            const progress = getOrderProgress(order.paymentStatus, order.fulfillmentStatus);
            const unpaid = isUnpaid(order.paymentStatus);
            const thumbs = order.items.slice(0, 4);
            const extra = order.items.length - thumbs.length;
            return (
              <section key={order.orderId} className="vl-panel overflow-hidden rounded-2xl">
                <div className="flex flex-wrap items-start justify-between gap-3 border-b border-white/10 p-5 sm:px-6">
                  <div>
                    <p className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">Order</p>
                    <p className="mt-1 text-sm font-semibold text-white">{displayOrderReference(order.orderNumber, order.orderId)}</p>
                    <p className="mt-1 text-xs text-zinc-500">{new Date(order.createdAt).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-lg font-semibold text-white">{money(order.amountPaid, order.currency)}</p>
                    <span className={`mt-1 inline-block rounded-full px-2.5 py-0.5 text-[11px] ${
                      unpaid ? "bg-amber-300/15 text-amber-200"
                      : progress.activeIndex === 4 ? "bg-emerald-400/15 text-emerald-300"
                      : progress.cancelled || progress.refunded ? "bg-zinc-500/15 text-zinc-400"
                      : "bg-cyan-400/12 text-cyan-200"
                    }`}>{progress.headline}</span>
                  </div>
                </div>

                <div className="p-5 sm:px-6">
                  {/* Item thumbnails */}
                  <div className="flex items-center gap-3">
                    <div className="flex -space-x-2">
                      {thumbs.map((item, i) => (
                        <div key={`${order.orderId}-${i}`} className="relative h-12 w-12 overflow-hidden rounded-lg border border-white/15 bg-white/5">
                          <Image src={item.image} alt={item.productName} fill sizes="48px" className="object-cover" />
                        </div>
                      ))}
                      {extra > 0 ? (
                        <div className="flex h-12 w-12 items-center justify-center rounded-lg border border-white/15 bg-white/[0.05] text-xs text-zinc-300">+{extra}</div>
                      ) : null}
                    </div>
                    <p className="min-w-0 flex-1 truncate text-sm text-zinc-300">
                      {order.items.map((it) => `${it.productName}${it.quantity > 1 ? ` ×${it.quantity}` : ""}`).join(", ")}
                    </p>
                  </div>

                  {/* Tracking */}
                  {!unpaid ? (
                    <div className="mt-5">
                      <OrderTracking paymentStatus={order.paymentStatus} fulfillmentStatus={order.fulfillmentStatus} estimatedDelivery={order.shipment?.estimatedDelivery} compact />
                    </div>
                  ) : null}

                  {order.shipment?.trackingNumber ? (
                    <p className="mt-3 text-xs text-zinc-400">
                      {order.shipment.carrier ? `${order.shipment.carrier} · ` : ""}
                      {order.shipment.trackingUrl ? (
                        <a href={order.shipment.trackingUrl} target="_blank" rel="noopener noreferrer" className="text-cyan-300 underline-offset-2 hover:underline">
                          Track {order.shipment.trackingNumber} →
                        </a>
                      ) : (
                        <span className="text-zinc-300">Tracking {order.shipment.trackingNumber}</span>
                      )}
                    </p>
                  ) : null}

                  {/* Actions */}
                  <div className="mt-5 flex flex-wrap items-center gap-2.5 border-t border-white/10 pt-4">
                    <Link href={`/account/orders/${encodeURIComponent(order.orderId)}`} className="vl2-btn-secondary vl-focus-ring inline-flex px-4 py-2 text-xs">
                      View details
                    </Link>
                    {unpaid ? (
                      <Link href={`/pay/${encodeURIComponent(order.orderId)}`} className="vl-focus-ring inline-flex rounded-full border border-amber-300/50 bg-amber-300/10 px-4 py-2 text-xs font-semibold text-amber-200 transition hover:bg-amber-300/20">
                        Complete payment →
                      </Link>
                    ) : (
                      <>
                        <ReorderButton orderId={order.orderId} />
                        <a href={`/account/orders/${encodeURIComponent(order.orderId)}/invoice`} target="_blank" rel="noopener noreferrer" className="vl-focus-ring inline-flex items-center gap-1.5 px-2 py-2 text-xs text-zinc-400 transition hover:text-white">
                          Invoice
                        </a>
                      </>
                    )}
                    {statusLabel(order.fulfillmentStatus) && !unpaid ? null : null}
                  </div>
                </div>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
