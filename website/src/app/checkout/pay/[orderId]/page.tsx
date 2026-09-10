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
  let currentSessionId: string | null = null;
  try {
    const { data: order } = await supabaseAdmin
      .from("orders")
      .select("payment_status, payment_id")
      .eq("order_id", String(orderId ?? "").trim())
      .maybeSingle();
    const status = String(order?.payment_status ?? "").toLowerCase();
    alreadyCaptured = status === "paid" || status === "partially_refunded" || status === "refunded";
    currentSessionId = order?.payment_id ? String(order.payment_id) : null;
  } catch {
    // Fall through to the card form. An unreachable database is not a reason to
    // strand a shopper who still has a payment to make.
  }
  if (alreadyCaptured) {
    redirect(`/order-confirmation/${encodeURIComponent(orderId)}`);
  }

  // ONE ORDER, ONE LIVE CARD FORM.
  //
  // resumeExistingOrder mints a BRAND NEW processor session every time an unpaid
  // order is resumed, and repoints orders.payment_id at it. Nothing on our side
  // voids the session it replaced, and whether the processor does is not
  // something we can see from here.
  //
  // Until this check, that left the superseded session fully chargeable. A tab
  // still holding the old link — a second tab, the back button, a restored
  // browser session, an older email — served a working card form for an unpaid
  // order alongside the new one. Two live forms for one order, and the only
  // thing between that and two real charges was the shopper not paying twice.
  // The duplicate-capture alert added by this audit notices that AFTER the money
  // has moved; this stops it moving.
  //
  // A REDIRECT, NOT A REFUSAL. Sending them to the order's current session keeps
  // the same order, mints nothing, and collapses however many tabs are open onto
  // ONE session — which a processor can refuse a second capture on. It cannot
  // refuse two captures across two sessions, because to it that is two payments.
  //
  // NARROW ON PURPOSE. It fires only when the order positively names a DIFFERENT
  // session. A missing payment_id, or the read above having failed, still
  // renders the form: a shopper with a real payment to make must always reach it.
  // One hop at most, since after the redirect `cs` IS the current session.
  //
  // Outside the try for the reason the block above gives: redirect() signals by
  // throwing, so inside it the catch would swallow it and fall through to
  // rendering the very form this prevents.
  if (currentSessionId && currentSessionId !== cs) {
    redirect(`/checkout/pay/${encodeURIComponent(orderId)}?cs=${encodeURIComponent(currentSessionId)}`);
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
