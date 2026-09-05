import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { supabaseAdmin } from "@/lib/supabase-server";
import { getAuthenticatedUser } from "@/lib/auth-session";
import { detectRoleFromUser } from "@/lib/auth-role";
import { getCardProcessingFeeConfig, getPaymentMethodsConfig } from "@/lib/admin-control";
import { getPaymentMethodById, isManualPaymentMethod } from "@/lib/payment-methods";
import { SiteHeaderV2 } from "@/components/site-header-v2";
import { ClearCartOnMount } from "@/components/clear-cart-on-mount";
import { OrderConfirmationStatus } from "@/components/order-confirmation-status";
import { OrderTotalRow } from "@/components/order-total-row";
import { TikTokPurchaseEvent } from "@/components/tiktok-purchase-event";
import { buildAdvancedMatching } from "@/lib/ads/advanced-matching";
import { displayOrderReference } from "@/lib/order-reference";
import { buildOrderSummaryLines } from "@/lib/order-summary-breakdown";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Order received",
  robots: { index: false, follow: false },
};

function money(value: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(Number(value ?? 0));
}

// The confirmation URL is an unguessable bearer token but can circulate (shared
// devices, forwarded screenshots). Mask the email so a casual holder of the
// link doesn't see the full address: j***@domain.com.
function maskEmail(email: string) {
  const [local, domain] = email.split("@");
  if (!domain) return "***";
  const shown = local.slice(0, 1);
  return `${shown}${"*".repeat(Math.max(3, local.length - 1))}@${domain}`;
}

// Customer-facing thank-you page. The order UUID is an unguessable bearer token
// (same pattern as /pay/[orderId] and the hosted-checkout return URL).
export default async function OrderConfirmationPage({ params }: { params: Promise<{ orderId: string }> }) {
  const { orderId } = await params;

  // THREE INDEPENDENT ROUND TRIPS, RUN AS ONE.
  //
  // These used to be awaited in series: the order, then the payment-method
  // config, then the session. Only their USE depends on the order — neither of
  // the other two needs it — so the receipt was paying three sequential network
  // latencies to render, on the screen a customer reaches straight after paying.
  //
  // A missing order now costs two wasted lookups before the 404. That is the
  // right trade: an unguessable order id that resolves to nothing is rare, and
  // every real customer gets the faster receipt.
  const [orderResult, paymentMethods, user, cardFeeConfig] = await Promise.all([
    supabaseAdmin
      .from("orders")
      .select("order_id, order_number, subtotal, shipping_amount, handling_fee, tax_amount, discount_amount, shipping_protection_fee, card_processing_fee, amount_paid, payment_status, fulfillment_status, payment_method, customer_email, created_at, order_items(product_name, quantity, line_total)")
      .eq("order_id", orderId)
      .maybeSingle(),
    // Each keeps the failure behaviour it had when it was awaited alone: a
    // config that cannot load means "treat as card", and no session means guest.
    getPaymentMethodsConfig().catch(() => null),
    getAuthenticatedUser().catch(() => null),
    // The store's own name for the card surcharge, so the receipt calls it what
    // checkout called it. A config that cannot load falls back to the default
    // label inside buildOrderSummaryLines rather than dropping the line.
    getCardProcessingFeeConfig().catch(() => null),
  ]);

  const order = orderResult.data;

  if (!order) {
    notFound();
  }

  const orderNumber = displayOrderReference(order.order_number as string | null, order.order_id as string | null);
  const items = (order.order_items ?? []) as Array<{ product_name?: string; quantity?: number; line_total?: number }>;
  const paymentStatus = String(order.payment_status ?? "").toLowerCase();
  const isPaid = paymentStatus === "paid";
  // The processor is finished and did not pay — the same terminal set
  // /api/checkout/order-status reports as `pending: false`. Veyra's return_url
  // is this page, the reconcile sweep can retire an order to payment_failed
  // while the shopper is parked here, and back/forward lands here too; every one
  // of those used to render "Thank you for your order … no need to pay again".
  const isFailed = paymentStatus === "payment_failed" || paymentStatus === "canceled" || paymentStatus === "cancelled";

  // THE TOTAL IS WHAT WAS CHARGED. amount_paid is the settled figure — never a
  // sum recomputed here, which could disagree with the card statement. The line
  // items are derived from it so the column always adds up (see
  // order-summary-breakdown.ts for why the residual line exists).
  const total = Number(order.amount_paid ?? 0);
  const summaryLines = buildOrderSummaryLines({
    total,
    subtotal: Number(order.subtotal ?? 0),
    shipping: Number(order.shipping_amount ?? 0),
    handling: Number(order.handling_fee ?? 0),
    tax: Number(order.tax_amount ?? 0),
    discount: Number(order.discount_amount ?? 0),
    // Recorded, so the receipt names it instead of inferring it from what is
    // left over. 0 on orders written before the column existed, which keeps the
    // old residual behaviour for exactly those.
    shippingProtection: Number(order.shipping_protection_fee ?? 0),
    // Recorded too, and a DIFFERENT charge from protection. Without this the
    // surcharge fell into the residual and was announced as "Shipping
    // protection" on every card order that declined cover.
    cardProcessingFee: Number(order.card_processing_fee ?? 0),
    cardFeeLabel: cardFeeConfig?.label,
    itemsTotal: items.reduce((running, item) => running + Number(item.line_total ?? 0), 0),
  });

  // A card order that's not paid yet is almost always mid-webhook-confirmation
  // (the customer just paid); only a MANUAL method genuinely still owes payment.
  let isManual = false;
  if (paymentMethods) {
    const method = getPaymentMethodById(paymentMethods, order.payment_method ? String(order.payment_method) : null);
    isManual = Boolean(method && isManualPaymentMethod(method));
  }

  // Only signed-in customers can use the account orders view; a guest who checked
  // out with just their email has no account to land on.
  const isCustomer = Boolean(user && detectRoleFromUser(user) === "customer");

  return (
    <div className="min-h-screen bg-[#0b0b0b] text-white">
      {/* ClearCartOnMount exists so "a cancelled/abandoned hosted payment keeps
          the cart intact, but a real confirmation empties it" (its own words).
          A declined or cancelled order is the former: emptying the cart here
          would send the shopper "back to checkout" with nothing to buy. */}
      {!isFailed ? <ClearCartOnMount /> : null}
      <TikTokPurchaseEvent
        orderId={String(order.order_id)}
        advancedMatching={buildAdvancedMatching({ email: order.customer_email ? String(order.customer_email) : null })}
      />
      <SiteHeaderV2 />
      {/* pt clears the fixed header and no more. This was pt-28/32, which left a
          screen-height gap above the confirmation on a phone — the first thing a
          customer saw after paying was empty space. */}
      <main className="vl-nav-clearance mx-auto max-w-xl px-4 pb-16 pt-20 sm:px-6 sm:pt-24">
        <section className="rounded-2xl border border-white/10 bg-white/[0.02] px-5 py-7 text-center sm:px-8 sm:py-9">
          <OrderConfirmationStatus
            orderId={String(order.order_id)}
            orderNumber={orderNumber}
            maskedEmail={order.customer_email ? maskEmail(String(order.customer_email)) : null}
            initialPaid={isPaid}
            initialFailed={isFailed}
            isManual={isManual}
            fulfillmentStatus={order.fulfillment_status ? String(order.fulfillment_status) : null}
          />
        </section>

        <section className="mt-4 rounded-2xl border border-white/10 px-5 py-5 sm:px-6">
          <h2 className="text-[11px] font-semibold uppercase tracking-[0.22em] text-white/45">Order summary</h2>

          <ul className="mt-4 space-y-2.5">
            {items.map((item, index) => (
              <li key={index} className="flex items-baseline justify-between gap-4">
                <span className="min-w-0 text-sm text-white/85">
                  {item.product_name ?? "Item"}
                  <span className="text-white/40"> × {item.quantity ?? 1}</span>
                </span>
                <span className="flex-shrink-0 text-sm tabular-nums text-white/85">{money(Number(item.line_total ?? 0))}</span>
              </li>
            ))}
          </ul>

          <div className="mt-4 border-t border-white/10 pt-2">
            {summaryLines.map((line) => (
              <div key={line.key} className="flex items-baseline justify-between gap-4 py-2">
                <span className="text-sm text-white/55">{line.label}</span>
                <span
                  className={`flex-shrink-0 text-sm tabular-nums ${line.tone === "credit" ? "text-emerald-300" : "text-white/85"}`}
                >
                  {/* Free shipping is the one line worth naming rather than
                      showing as $0.00 — it reads as a perk, not a blank. */}
                  {line.key === "shipping" && line.amount === 0
                    ? "Free"
                    : line.amount < 0
                      ? `−${money(Math.abs(line.amount))}`
                      : money(line.amount)}
                </span>
              </div>
            ))}
          </div>

          {/* "Total paid" is a claim about money having changed hands, and it
              must only be made when the backend says it has. `amount_paid` is
              written at order creation with the full total, so on a pending
              order this row asserted a payment that had not happened — directly
              beneath a spinner reading "Confirming your payment…". The figure is
              the same either way; what it is called is not. */}
          <OrderTotalRow amount={money(total)} initialPaid={isPaid} />
        </section>

        {/* Full-width, stacked, thumb-sized. The PRIMARY action is tracking the
            order they just placed — "Continue shopping" was the white button
            here, which pushed the customer away from the thing they actually
            came to this page for. */}
        <div className="mt-6 flex flex-col gap-2.5">
          {isCustomer ? (
            <Link
              href="/account/orders"
              className="vl2-btn-primary vl-focus-ring flex w-full items-center justify-center px-6 py-3.5 text-sm"
            >
              View order details
            </Link>
          ) : (
            <Link
              href={`/account/login?next=${encodeURIComponent("/account/orders")}`}
              className="vl2-btn-primary vl-focus-ring flex w-full items-center justify-center px-6 py-3.5 text-sm"
            >
              Create account &amp; track order
            </Link>
          )}
          <Link
            href="/products"
            className="vl2-btn-secondary vl-focus-ring flex w-full items-center justify-center px-6 py-3.5 text-sm"
          >
            Continue shopping
          </Link>
        </div>

        <p className="mt-6 text-center text-xs leading-6 text-white/40">
          Questions about your order?{" "}
          <Link
            href="/contact"
            className="vl-focus-ring rounded text-white/70 underline decoration-white/20 underline-offset-4 transition hover:text-white hover:decoration-white/50"
          >
            Contact Vanta Labs Support
          </Link>
          .
        </p>
      </main>
    </div>
  );
}
