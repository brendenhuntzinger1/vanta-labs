import Link from "next/link";
import Image from "next/image";
import { notFound, redirect } from "next/navigation";
import { detectRoleFromUser } from "@/lib/auth-role";
import { getAuthenticatedUser } from "@/lib/auth-session";
import { ownershipEmail } from "@/lib/order-ownership";
import { getCustomerOrderDetail } from "@/lib/account-orders";
import { isUnpaid } from "@/lib/order-status";
import { OrderTracking } from "@/components/order-tracking";
import { ReorderButton } from "@/components/reorder-button";
import { displayOrderReference } from "@/lib/order-reference";
import { formatDisplayDate } from "@/lib/format-date";

export const dynamic = "force-dynamic";

function money(value: number, currency = "USD") {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(value);
}

function Row({ label, value, strong = false, accent }: { label: string; value: string; strong?: boolean; accent?: "muted" | "positive" }) {
  return (
    <div className="flex items-center justify-between py-1.5 text-sm">
      <span className="text-zinc-400">{label}</span>
      <span className={`${strong ? "font-semibold text-white" : accent === "positive" ? "text-emerald-300" : "text-zinc-200"}`}>{value}</span>
    </div>
  );
}

export default async function OrderDetailPage({ params }: { params: Promise<{ orderId: string }> }) {
  const user = await getAuthenticatedUser();
  if (!user || detectRoleFromUser(user) !== "customer") {
    redirect("/account/login");
  }

  const { orderId } = await params;
  const order = await getCustomerOrderDetail(user.id, ownershipEmail(user), decodeURIComponent(orderId)).catch(() => null);
  if (!order) {
    notFound();
  }

  const unpaid = isUnpaid(order.paymentStatus);
  const addressLines = [order.customerName, order.shippingAddress, order.shippingAddress2, [order.city, order.state, order.postalCode].filter(Boolean).join(", "), order.country].filter(Boolean) as string[];

  return (
    <div className="space-y-5">
      <div className="vl-fade-up flex items-center justify-between">
        <div>
          <Link href="/account/orders" className="vl-focus-ring text-xs text-zinc-400 underline-offset-2 hover:text-white">← All orders</Link>
          <h1 className="vl2-serif mt-2 text-2xl text-white sm:text-3xl">Order {displayOrderReference(order.orderNumber, order.orderId)}</h1>
          <p className="mt-1 text-sm text-zinc-500">Placed {formatDisplayDate(order.createdAt, "long")}</p>
        </div>
      </div>

      {unpaid ? (
        <section className="vl-panel rounded-2xl border-amber-300/20 p-5">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-sm font-semibold text-amber-200">Payment not completed</p>
              <p className="mt-1 text-xs text-zinc-400">This order is reserved but won&apos;t ship until payment is completed.</p>
            </div>
            <Link href={`/pay/${encodeURIComponent(order.orderId)}`} className="vl-focus-ring shrink-0 rounded-full border border-amber-300/50 bg-amber-300/10 px-5 py-2.5 text-xs font-semibold text-amber-100 transition hover:bg-amber-300/20">
              Complete payment →
            </Link>
          </div>
        </section>
      ) : (
        <section className="vl-panel rounded-2xl p-5 sm:p-6">
          <OrderTracking paymentStatus={order.paymentStatus} fulfillmentStatus={order.fulfillmentStatus} estimatedDelivery={order.shipment?.estimatedDelivery} />
          {order.shipment?.trackingNumber ? (
            <div className="mt-4 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-white/10 bg-white/[0.02] p-3.5">
              <div>
                <p className="text-xs text-zinc-500">{order.shipment.carrier ?? "Carrier"}</p>
                <p className="text-sm text-white">{order.shipment.trackingNumber}</p>
              </div>
              {order.shipment.trackingUrl ? (
                <a href={order.shipment.trackingUrl} target="_blank" rel="noopener noreferrer" className="vl2-btn-secondary vl-focus-ring inline-flex px-4 py-2 text-xs">
                  Track shipment →
                </a>
              ) : null}
            </div>
          ) : null}
        </section>
      )}

      {/* Items */}
      <section className="vl-panel rounded-2xl p-5 sm:p-6">
        <h2 className="text-lg font-semibold text-white">Items</h2>
        <ul className="mt-4 divide-y divide-white/10">
          {order.items.map((item, i) => (
            <li key={`${order.orderId}-${i}`} className="flex items-center gap-3.5 py-3">
              <Link href={`/products/${item.slug}`} className="relative h-16 w-16 shrink-0 overflow-hidden rounded-xl border border-white/12 bg-white/5">
                <Image src={item.image} alt={item.productName} fill sizes="64px" className="object-cover" />
              </Link>
              <div className="min-w-0 flex-1">
                <Link href={`/products/${item.slug}`} className="block truncate text-sm font-medium text-white hover:text-cyan-200">{item.productName}</Link>
                {item.variantLabel ? <p className="text-xs text-zinc-500">{item.variantLabel}</p> : null}
                <p className="mt-0.5 text-xs text-zinc-500">Qty {item.quantity} · {money(item.unitPrice, order.currency)} each</p>
              </div>
              <p className="shrink-0 text-sm font-medium text-white">{money(item.lineTotal, order.currency)}</p>
            </li>
          ))}
        </ul>
      </section>

      <div className="grid gap-5 lg:grid-cols-2">
        {/* Summary */}
        <section className="vl-panel rounded-2xl p-5 sm:p-6">
          <h2 className="text-lg font-semibold text-white">Payment summary</h2>
          <div className="mt-3 divide-y divide-white/[0.06]">
            <Row label="Subtotal" value={money(order.subtotal, order.currency)} />
            {order.discountAmount > 0 ? <Row label="Discount" value={`−${money(order.discountAmount, order.currency)}`} accent="positive" /> : null}
            <Row label="Shipping" value={order.shippingAmount > 0 ? money(order.shippingAmount, order.currency) : "Free"} />
            {order.handlingFee > 0 ? <Row label="Handling" value={money(order.handlingFee, order.currency)} /> : null}
            {order.taxAmount > 0 ? <Row label="Tax" value={money(order.taxAmount, order.currency)} /> : null}
            <Row label="Total paid" value={money(order.amountPaid, order.currency)} strong />
            {order.refundAmount > 0 ? <Row label="Refunded" value={`−${money(order.refundAmount, order.currency)}`} accent="positive" /> : null}
          </div>
          <div className="mt-4 flex flex-wrap gap-2.5 border-t border-white/10 pt-4">
            {!unpaid ? (
              <>
                <a href={`/account/orders/${encodeURIComponent(order.orderId)}/invoice`} target="_blank" rel="noopener noreferrer" className="vl2-btn-secondary vl-focus-ring inline-flex px-4 py-2 text-xs">
                  Download invoice
                </a>
                <ReorderButton orderId={order.orderId} />
              </>
            ) : null}
          </div>
        </section>

        {/* Shipping + payment method */}
        <section className="vl-panel rounded-2xl p-5 sm:p-6">
          <h2 className="text-lg font-semibold text-white">Shipping &amp; payment</h2>
          <div className="mt-3">
            <p className="text-xs uppercase tracking-[0.18em] text-zinc-500">Ship to</p>
            {addressLines.length ? (
              <div className="mt-1.5 text-sm text-zinc-300">
                {addressLines.map((line, i) => (
                  <p key={i} className={i === 0 ? "font-medium text-white" : "text-zinc-400"}>{line}</p>
                ))}
                {order.phone ? <p className="mt-1 text-zinc-500">{order.phone}</p> : null}
              </div>
            ) : (
              <p className="mt-1.5 text-sm text-zinc-500">No shipping address on file.</p>
            )}
          </div>
          <div className="mt-5 border-t border-white/10 pt-4">
            <p className="text-xs uppercase tracking-[0.18em] text-zinc-500">Payment method</p>
            <p className="mt-1.5 text-sm text-zinc-300">{order.paymentMethod ?? "—"}</p>
          </div>
        </section>
      </div>
    </div>
  );
}
