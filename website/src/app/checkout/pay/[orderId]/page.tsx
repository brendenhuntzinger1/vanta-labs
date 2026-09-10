import Link from "next/link";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { supabaseAdmin } from "@/lib/supabase-server";
import VeyraCheckout from "./VeyraCheckout";

export const metadata: Metadata = {
  title: "Secure payment",
  // A payment page has no business in search results.
  robots: { index: false, follow: false },
};

// On-site card entry for a created checkout session.
//
// createCheckoutSession sends the shopper here rather than to the processor's
// hosted page, because Veyra's documented integration mounts the card iframe on
// the merchant's own domain. The session id arrives as `?cs=` — it is a
// short-lived handle to a server-created session (60 minutes), not a secret: the
// amount and line items were fixed server-side when the session was created, so a
// tampered value simply fails to mount rather than altering a charge.
export default async function CheckoutPayPage({
  params,
  searchParams,
}: {
  params: Promise<{ orderId: string }>;
  searchParams: Promise<{ cs?: string }>;
}) {
  const { orderId } = await params;
  const { cs } = await searchParams;

  if (!cs) {
    return (
      <main className="mx-auto w-full max-w-2xl px-6 py-20">
        <h1 className="text-2xl font-light tracking-wide text-white">Payment session missing</h1>
        <p className="mt-4 text-sm text-white/60">
          This payment link is incomplete, so there is nothing to pay yet.{" "}
          <strong className="text-white/80">No charge has been made.</strong> Please return to
          checkout and try again.
        </p>
        <Link
          href="/checkout"
          className="mt-8 inline-block border border-white/20 px-6 py-3 text-sm tracking-wide text-white transition hover:bg-white hover:text-black"
        >
          Back to checkout
        </Link>
      </main>
    );
  }

  // DO NOT SERVE A LIVE CARD FORM FOR AN ORDER THAT HAS ALREADY BEEN PAID.
  //
  // This page checked only that `cs` was present. Nothing read the order's
  // payment state, so a settled order still rendered a working card iframe —
  // and the only thing that moved the shopper off it was the client-side poll,
  // 2.5 seconds later at the earliest and never at all if the request failed.
  // Anyone who reloads a pay link after paying, returns to it from history, or
  // follows it from an old email is shown a form that can charge them again for
  // a purchase they have completed.
  //
  // Only the CAPTURED case redirects. A declined or cancelled order deliberately
  // still renders: the poll already reports it as terminal, and VeyraCheckout
  // says so and offers a route back to checkout — which is better than a bare
  // redirect that explains nothing. Best-effort by design: a read failure must
  // never stand between a shopper and a card form they legitimately need.
  // `redirect()` SIGNALS BY THROWING, so it must not be called inside the
  // try: this function's own catch would swallow the redirect and fall straight
  // through to rendering the card form — the exact bug being fixed, hidden
  // behind error handling that looks careful. The read is guarded; the redirect
  // is not.
  let alreadyCaptured = false;
  try {
    const { data: order } = await supabaseAdmin
      .from("orders")
      .select("payment_status")
      .eq("order_id", String(orderId ?? "").trim())
      .maybeSingle();
    const status = String(order?.payment_status ?? "").toLowerCase();
    alreadyCaptured = status === "paid" || status === "partially_refunded" || status === "refunded";
  } catch {
    // Fall through to the card form. An unreachable database is not a reason to
    // strand a shopper who still has a payment to make.
  }
  if (alreadyCaptured) {
    redirect(`/order-confirmation/${encodeURIComponent(orderId)}`);
  }

  return (
    <main className="mx-auto w-full max-w-2xl px-6 py-16">
      <h1 className="text-2xl font-light tracking-[0.2em] text-white">SECURE PAYMENT</h1>
      <p className="mt-3 text-sm text-white/60">
        Enter your card below. Your details are handled by our payment provider and never touch our
        servers.
      </p>

      <div className="mt-8">
        <VeyraCheckout sessionId={cs} orderId={orderId} />
      </div>

      <p className="mt-8 text-xs text-white/40">
        Leaving this page before payment completes will not charge you. Your order is held until
        payment is confirmed.
      </p>
    </main>
  );
}
