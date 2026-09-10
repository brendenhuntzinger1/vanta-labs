import Link from "next/link";
import Image from "next/image";
import { notFound, redirect } from "next/navigation";
import { detectRoleFromUser } from "@/lib/auth-role";
import { getAuthenticatedUser } from "@/lib/auth-session";
import { ownershipEmail } from "@/lib/order-ownership";
import { getCustomerOrderDetail } from "@/lib/account-orders";
import { getOrderProgress, isUnpaid } from "@/lib/order-status";
import { OrderTracking } from "@/components/order-tracking";
import { ReorderButton } from "@/components/reorder-button";
import { displayOrderReference } from "@/lib/order-reference";
import { formatDisplayDate } from "@/lib/format-date";
import { buildOrderSummaryLines } from "@/lib/order-summary-breakdown";
import { pointsToDollars } from "@/lib/points-math";
import { roundMoney } from "@/lib/bundle-pricing";

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
  // A DECLINED order is neither "unpaid" nor live. isUnpaid's list does not
  // include payment_failed, so this page used to fall into the `else` branch for
  // one — rendering the tracking stepper, a "Total paid" row and a Download
  // invoice button for a card that was never charged. getOrderProgress now says
  // so directly.
  const progress = getOrderProgress(order.paymentStatus, order.fulfillmentStatus);
  const failed = progress.failed;
  const addressLines = [order.customerName, order.shippingAddress, order.shippingAddress2, [order.city, order.state, order.postalCode].filter(Boolean).join(", "), order.country].filter(Boolean) as string[];

  return (
    <div className="space-y-5">
      <div className="vl-fade-up flex items-center justify-between">
        <div>
          <Link href="/account/orders" className="vl-focus-ring text-xs text-zinc-400 underline-offset-2 hover:text-white">← All orders</Link>
          <h1 className="vl2-serif mt-2 text-2xl text-white sm:text-3xl">Order {displayOrderReference(order.orderNumber, order.orderId)}</h1>
          <p className="mt-1 text-sm text-zinc-400">Placed {formatDisplayDate(order.createdAt, "long")}</p>
        </div>
      </div>

      {failed ? (
        <section className="vl-panel rounded-2xl border-red-400/20 p-5">
          <p className="text-sm font-semibold text-red-200">Payment not completed</p>
          <p className="mt-1 text-xs text-zinc-400">
            This payment did not go through, so this order was not placed and nothing was shipped.
            Your bank may have asked you to approve the purchase — if so, approve it and then place
            the order again. You can also use a different card.
          </p>
          <div className="mt-4 flex flex-wrap gap-2.5">
            <Link href="/products" className="vl2-btn-primary vl-focus-ring inline-flex px-5 py-2.5 text-xs font-semibold">
              Shop again
            </Link>
            <Link href="/contact" className="vl2-btn-secondary vl-focus-ring inline-flex px-4 py-2 text-xs">
              Contact support
            </Link>
          </div>
        </section>
      ) : unpaid ? (
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
                <p className="text-xs text-zinc-400">{order.shipment.carrier ?? "Carrier"}</p>
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
                {item.variantLabel ? <p className="text-xs text-zinc-400">{item.variantLabel}</p> : null}
                <p className="mt-0.5 text-xs text-zinc-400">Qty {item.quantity} · {money(item.unitPrice, order.currency)} each</p>
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
            {/* THE ROWS THE CUSTOMER SEES MUST ADD UP TO WHAT THEY WERE CHARGED.
                This panel hand-listed five terms — subtotal, discount, shipping,
                handling, tax — and the order row carries two more that are
                genuinely charged: shipping_protection_fee and
                card_processing_fee. Measured on a real order: rows summing to
                $28.49 above a "Total paid" of $30.27, with $1.78 unexplained and
                unlabelled on the one page a customer opens to check a charge.
                Both fees were already loaded by this page's own data source, and
                both were itemised correctly on the invoice, the emailed receipt,
                the confirmation page and the admin order page.

                buildOrderSummaryLines is the function all of those derive from.
                It models every term and keeps a residual line, so an unmodelled
                remainder is VISIBLE rather than silently absent — the summary
                adds up by construction instead of by five lists being kept in
                step by hand. */}
            {buildOrderSummaryLines({
              total: order.amountPaid,
              subtotal: order.subtotal,
              shipping: order.shippingAmount,
              handling: order.handlingFee,
              tax: order.taxAmount,
              discount: order.discountAmount,
              shippingProtection: order.shippingProtectionFee,
              cardProcessingFee: order.cardProcessingFee,
              // Store credit is cents; POINTS ARE NOT. They convert through
              // pointsToDollars at the configured rate, which is what the
              // emailed receipt and the confirmation page both use
              // (receiptAdjustmentsFromOrder). Dividing points by 100 here would
              // have printed a different credit line from the one the customer
              // was emailed, on the page they open to check a charge.
              creditsApplied: roundMoney(
                Math.max(0, order.storeCreditRedeemedCents ?? 0) / 100
                + pointsToDollars(Math.max(0, order.pointsRedeemed ?? 0)),
              ),
              itemsTotal: (order.items ?? []).reduce((running, item) => running + Number(item.lineTotal ?? 0), 0),
            }).map((line) => (
              <Row
                key={line.key}
                label={line.label}
                value={line.amount < 0
                  ? `−${money(Math.abs(line.amount), order.currency)}`
                  : line.key === "shipping" && line.amount === 0
                    ? "Free"
                    : money(line.amount, order.currency)}
                accent={line.tone === "credit" ? "positive" : undefined}
              />
            ))}
            {/* "Total paid" is a claim about money having changed hands. The
                order-confirmation page already reasoned its way to this and
                withholds the claim until the backend says it happened; these
                account pages were missed. */}
            <Row
              label={failed ? "Order total (not charged)" : "Total paid"}
              value={money(order.amountPaid, order.currency)}
              strong
            />
            {order.refundAmount > 0 ? <Row label="Refunded" value={`−${money(order.refundAmount, order.currency)}`} accent="positive" /> : null}
          </div>
          <div className="mt-4 flex flex-wrap gap-2.5 border-t border-white/10 pt-4">
            {!unpaid && !failed ? (
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
            <p className="text-xs uppercase tracking-[0.18em] text-zinc-400">Ship to</p>
            {addressLines.length ? (
              <div className="mt-1.5 text-sm text-zinc-300">
                {addressLines.map((line, i) => (
                  <p key={i} className={i === 0 ? "font-medium text-white" : "text-zinc-400"}>{line}</p>
                ))}
                {order.phone ? <p className="mt-1 text-zinc-400">{order.phone}</p> : null}
              </div>
            ) : (
              <p className="mt-1.5 text-sm text-zinc-400">No shipping address on file.</p>
            )}
          </div>
          <div className="mt-5 border-t border-white/10 pt-4">
            <p className="text-xs uppercase tracking-[0.18em] text-zinc-400">Payment method</p>
            <p className="mt-1.5 text-sm text-zinc-300">{order.paymentMethod ?? "—"}</p>
          </div>
        </section>
      </div>
    </div>
  );
}
