import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { supabaseAdmin } from "@/lib/supabase-server";
import { getPaymentMethodsConfig } from "@/lib/admin-control";
import { getPaymentMethodById, isManualPaymentMethod } from "@/lib/payment-methods";
import { SiteHeaderV2 } from "@/components/site-header-v2";
import { ManualPaymentInstructions } from "@/components/manual-payment-instructions";

export const dynamic = "force-dynamic";

// Private, order-scoped payment page — never index it.
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

// Customer-facing resubmission page. The order UUID acts as an unguessable
// bearer token (same pattern as the hosted-checkout return URL). Linked from
// the "payment not verified" email so a customer can re-send proof.
export default async function ResubmitPaymentPage({ params }: { params: Promise<{ orderId: string }> }) {
  const { orderId } = await params;

  const { data: order } = await supabaseAdmin
    .from("orders")
    .select("order_id, order_number, amount_paid, payment_method, payment_status, rejection_reason")
    .eq("order_id", orderId)
    .maybeSingle();

  if (!order) {
    notFound();
  }

  const methods = await getPaymentMethodsConfig();
  const method = getPaymentMethodById(methods, order.payment_method ? String(order.payment_method) : null);
  const isManual = Boolean(method && isManualPaymentMethod(method));
  const orderNumber = String(order.order_number ?? order.order_id);
  const alreadyPaid = order.payment_status === "paid";

  return (
    <div className="min-h-screen bg-[#0b0b0b] text-white">
      <SiteHeaderV2 />
      <main className="mx-auto max-w-3xl px-6 pb-20 pt-32 lg:px-12">
        <section className="border border-white/10 p-5 sm:p-8">
          <p className="vl2-eyebrow">Complete your payment</p>
          <h1 className="vl2-serif mt-3 text-3xl text-white sm:text-4xl">Order {orderNumber}</h1>
          {alreadyPaid ? (
            <p className="mt-3 text-sm text-emerald-300">This order is already paid — no further action is needed.</p>
          ) : isManual ? (
            <p className="mt-3 text-sm leading-7 text-white/60">
              {order.rejection_reason
                ? `We couldn't verify your previous payment: ${String(order.rejection_reason)}. Please re-send your payment and submit the details below.`
                : "Send the exact amount, then submit your payment details below so we can verify and ship your order."}
            </p>
          ) : (
            // Card order that hasn't been paid: the on-site card session is
            // short-lived and can't be safely re-mounted from here, so guide the
            // customer to finish securely rather than dead-ending on a 404.
            <p className="mt-3 text-sm leading-7 text-white/60">
              Your order is reserved and <span className="text-white/80">no charge has been made</span>. To finish paying by
              card, return to secure checkout, or contact us and we&apos;ll send you a secure payment link.
            </p>
          )}
        </section>

        {alreadyPaid ? (
          <Link href="/products" className="mt-8 inline-flex text-sm text-white/45 transition hover:text-white">
            Continue shopping
          </Link>
        ) : isManual && method ? (
          <div className="mt-7">
            <ManualPaymentInstructions
              method={method}
              orderId={String(order.order_id)}
              orderNumber={orderNumber}
              amountDue={Number(order.amount_paid ?? 0)}
            />
          </div>
        ) : (
          <div className="mt-7 flex flex-col gap-3 sm:flex-row">
            <Link href="/checkout" className="vl2-btn-primary vl-focus-ring px-6 py-3 text-sm">Return to secure checkout</Link>
            <Link href="/contact" className="vl2-btn-secondary vl-focus-ring px-6 py-3 text-sm">Contact support</Link>
          </div>
        )}
      </main>
    </div>
  );
}
