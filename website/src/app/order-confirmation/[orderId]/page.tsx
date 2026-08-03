import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { supabaseAdmin } from "@/lib/supabase-server";
import { getAuthenticatedUser } from "@/lib/auth-session";
import { detectRoleFromUser } from "@/lib/auth-role";
import { getPaymentMethodsConfig } from "@/lib/admin-control";
import { getPaymentMethodById, isManualPaymentMethod } from "@/lib/payment-methods";
import { SiteHeaderV2 } from "@/components/site-header-v2";
import { ClearCartOnMount } from "@/components/clear-cart-on-mount";
import { OrderConfirmationStatus } from "@/components/order-confirmation-status";
import { displayOrderReference } from "@/lib/order-reference";

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

  const { data: order } = await supabaseAdmin
    .from("orders")
    .select("order_id, order_number, amount_paid, payment_status, fulfillment_status, payment_method, customer_email, created_at, order_items(product_name, quantity, line_total)")
    .eq("order_id", orderId)
    .maybeSingle();

  if (!order) {
    notFound();
  }

  const orderNumber = displayOrderReference(order.order_number as string | null, order.order_id as string | null);
  const items = (order.order_items ?? []) as Array<{ product_name?: string; quantity?: number; line_total?: number }>;
  const isPaid = String(order.payment_status ?? "").toLowerCase() === "paid";

  // A card order that's not paid yet is almost always mid-webhook-confirmation
  // (the customer just paid); only a MANUAL method genuinely still owes payment.
  let isManual = false;
  try {
    const methods = await getPaymentMethodsConfig();
    const method = getPaymentMethodById(methods, order.payment_method ? String(order.payment_method) : null);
    isManual = Boolean(method && isManualPaymentMethod(method));
  } catch {
    /* treat as card */
  }

  // Only signed-in customers can use the account orders view; a guest who checked
  // out with just their email has no account to land on.
  const user = await getAuthenticatedUser().catch(() => null);
  const isCustomer = Boolean(user && detectRoleFromUser(user) === "customer");

  return (
    <div className="min-h-screen bg-[#0b0b0b] text-white">
      <ClearCartOnMount />
      <SiteHeaderV2 />
      <main className="mx-auto max-w-2xl px-4 pb-24 pt-28 sm:px-6 sm:pt-32 lg:px-12">
        <section className="rounded-2xl border border-white/10 bg-white/[0.02] p-6 text-center sm:p-8">
          <OrderConfirmationStatus
            orderId={String(order.order_id)}
            orderNumber={orderNumber}
            maskedEmail={order.customer_email ? maskEmail(String(order.customer_email)) : null}
            initialPaid={isPaid}
            isManual={isManual}
          />
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
          {isCustomer ? (
            <Link href="/account/orders" className="vl2-btn-secondary vl-focus-ring px-6 py-3 text-sm">
              View my orders
            </Link>
          ) : (
            <Link href={`/account/login?next=${encodeURIComponent("/account/orders")}`} className="vl2-btn-secondary vl-focus-ring px-6 py-3 text-sm">
              Create an account to track orders
            </Link>
          )}
        </div>
      </main>
    </div>
  );
}
