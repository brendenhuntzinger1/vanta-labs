import Link from "next/link";
import type { Metadata } from "next";
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
