import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { supabaseAdmin } from "@/lib/supabase-server";
import { SiteHeaderV2 } from "@/components/site-header-v2";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Order Confirmed",
  robots: { index: false, follow: false },
};

function money(value: number) {
  return `$${Number(value ?? 0).toFixed(2)}`;
}

// Customer-facing thank-you page. The order UUID is an unguessable bearer token
// (same pattern as /pay/[orderId] and the hosted-checkout return URL).
export default async function OrderConfirmationPage({ params }: { params: Promise<{ orderId: string }> }) {
  const { orderId } = await params;

  const { data: order } = await supabaseAdmin
    .from("orders")
    .select("order_id, order_number, amount_paid, payment_status, fulfillment_status, customer_email, created_at, order_items(product_name, quantity, line_total)")
    .eq("order_id", orderId)
    .maybeSingle();

  if (!order) {
    notFound();
  }

  const orderNumber = String(order.order_number ?? order.order_id);
  const items = (order.order_items ?? []) as Array<{ product_name?: string; quantity?: number; line_total?: number }>;
  const isPaid = String(order.payment_status ?? "").toLowerCase() === "paid";

  return (
    <div className="min-h-screen bg-[#0b0b0b] text-white">
      <SiteHeaderV2 />
      <main className="mx-auto max-w-2xl px-4 pb-24 pt-28 sm:px-6 sm:pt-32 lg:px-12">
        <section className="rounded-2xl border border-white/10 bg-white/[0.02] p-6 text-center sm:p-8">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full border border-emerald-300/40 bg-emerald-400/15 text-2xl">
            ✓
          </div>
          <p className="vl2-eyebrow mt-5 text-emerald-300">Order confirmed</p>
          <h1 className="vl2-serif mt-3 text-3xl text-white sm:text-4xl">Thank you for your order</h1>
          <p className="mt-3 text-sm leading-7 text-white/60">
            Order <span className="font-semibold text-white">{orderNumber}</span>
            {order.customer_email ? <> — a confirmation was sent to <span className="text-white/80">{String(order.customer_email)}</span>.</> : "."}
          </p>
          <p className="mt-2 text-sm text-white/50">
            {isPaid
              ? "We're preparing your order. You'll get a shipping email with tracking once it's on the way."
              : "We've received your order. You'll get an email as soon as your payment is confirmed and it ships."}
          </p>
        </section>

        <section className="mt-6 rounded-2xl border border-white/10 p-5 sm:p-6">
          <h2 className="text-sm font-semibold uppercase tracking-[0.2em] text-white/50">Order summary</h2>
          <ul className="mt-4 space-y-2 text-sm text-white/80">
            {items.map((item, index) => (
              <li key={index} className="flex justify-between gap-3">
                <span>{item.product_name ?? "Item"} × {item.quantity ?? 1}</span>
                <span className="text-white/60 tabular-nums">{money(Number(item.line_total ?? 0))}</span>
              </li>
            ))}
          </ul>
          <div className="mt-4 flex justify-between border-t border-white/10 pt-4 text-base font-semibold text-white">
            <span>Total</span>
            <span className="tabular-nums">{money(Number(order.amount_paid ?? 0))}</span>
          </div>
        </section>

        <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:justify-center">
          <Link href="/products" className="vl2-btn-primary vl-focus-ring px-6 py-3 text-sm">
            Continue shopping
          </Link>
          <Link href="/account" className="vl2-btn-secondary vl-focus-ring px-6 py-3 text-sm">
            View my orders
          </Link>
        </div>
      </main>
    </div>
  );
}
