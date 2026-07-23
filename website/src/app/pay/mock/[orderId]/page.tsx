import { notFound } from "next/navigation";
import { supabaseAdmin } from "@/lib/supabase-server";
import { isMockPaymentMode } from "@/lib/payment-provider";
import { SiteHeaderV2 } from "@/components/site-header-v2";
import { MockCheckoutForm } from "@/components/mock-checkout-form";

export const dynamic = "force-dynamic";

// Simulated hosted-checkout page for the MOCK payment gateway
// (PAYMENT_PROVIDER=mock). A card checkout redirects here instead of a real
// processor; approving or declining drives the real webhook pipeline with a
// fake payment. Returns 404 in any non-mock environment so it can never be
// reached in production.
export default async function MockCheckoutPage({ params }: { params: Promise<{ orderId: string }> }) {
  if (!isMockPaymentMode()) {
    notFound();
  }

  const { orderId } = await params;

  const { data: order } = await supabaseAdmin
    .from("orders")
    .select("order_id, order_number, amount_paid, currency, payment_method, payment_status")
    .eq("order_id", orderId)
    .maybeSingle();

  if (!order) {
    notFound();
  }

  if (order.payment_method && order.payment_method !== "card") {
    notFound();
  }

  const orderNumber = String(order.order_number ?? order.order_id);
  const amountDue = Number(order.amount_paid ?? 0);
  const currency = String(order.currency ?? "USD");
  const alreadyPaid = order.payment_status === "paid";

  return (
    <div className="min-h-screen bg-[#0b0b0b] text-white">
      <SiteHeaderV2 />
      <main className="mx-auto max-w-xl px-6 pb-20 pt-32 lg:px-12">
        <section className="border border-white/10 p-5 sm:p-8">
          <p className="vl2-eyebrow">Test payment · sandbox</p>
          <h1 className="vl2-serif mt-3 text-3xl text-white sm:text-4xl">Order {orderNumber}</h1>
          <p className="mt-2 text-2xl font-semibold text-white">
            {currency} ${amountDue.toFixed(2)}
          </p>
          <p className="mt-3 text-sm leading-7 text-amber-300/90">
            Sandbox gateway — no real card is charged. This stands in for your live
            processor so the full order flow can be tested end to end.
          </p>

          {alreadyPaid ? (
            <p className="mt-6 text-sm text-emerald-300">This order is already paid — no further action is needed.</p>
          ) : (
            <div className="mt-7">
              <MockCheckoutForm orderId={String(order.order_id)} orderNumber={orderNumber} />
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
