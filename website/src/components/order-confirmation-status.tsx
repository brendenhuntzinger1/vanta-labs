"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { OrderStatusTimeline } from "@/components/order-status-timeline";

/**
 * Lead-in for the order line's email clause.
 *
 * This must NEVER assert completed delivery. The confirmation email is queued
 * and sent asynchronously (see order_email_log), so at the instant this page
 * renders the send is usually still in flight, and if the provider is
 * unreachable it may never land at all — the log records `failed` in that case.
 * The old copy ("a confirmation was sent to …") stated delivery as settled fact
 * regardless of outcome, so a customer whose email hard-failed was told to wait
 * for something that was never coming instead of contacting support.
 *
 * Exported so the regression test can hold the line on the tense.
 */
export const EMAIL_CONFIRMATION_LEAD = "we'll email your confirmation to";

/**
 * Confirmation hero that resolves the brief gap between a card/Apple Pay charge
 * completing and its webhook marking the order "paid". A customer who just paid
 * must NEVER see "complete payment" — for card orders we show a "confirming your
 * payment…" state and poll until it flips to paid. Only manual methods
 * (Cash App / Zelle, where the customer really does still owe payment) show a
 * Complete-payment CTA.
 */
export function OrderConfirmationStatus({
  orderId,
  orderNumber,
  maskedEmail,
  initialPaid,
  initialFailed,
  isManual,
  fulfillmentStatus,
}: {
  orderId: string;
  orderNumber: string;
  maskedEmail: string | null;
  initialPaid: boolean;
  /**
   * The processor has finished with this order and did NOT pay it — declined,
   * cancelled or expired (payment_failed / canceled). Rendered as its own state:
   * this page used to show such an order "Confirming your payment…" and then
   * "Order received … no need to pay again", so a shopper whose card was
   * declined was thanked for an order that will never ship and told not to pay.
   */
  initialFailed: boolean;
  isManual: boolean;
  fulfillmentStatus: string | null;
}) {
  const [paid, setPaid] = useState(initialPaid);
  const [failed, setFailed] = useState(initialFailed);
  const [timedOut, setTimedOut] = useState(false);
  const attempts = useRef(0);

  // Poll only for a not-yet-paid CARD order (the webhook-lag case). Manual
  // orders genuinely await payment; paid and failed orders are done.
  const confirming = !paid && !failed && !isManual && !timedOut;

  useEffect(() => {
    if (paid || failed || isManual) return;
    let active = true;
    let timer: number | undefined;
    const MAX_ATTEMPTS = 20; // ~60s at 3s

    const tick = async () => {
      if (!active) return;
      attempts.current += 1;
      try {
        const res = await fetch(`/api/checkout/order-status/${encodeURIComponent(orderId)}`, { cache: "no-store" });
        const json = (await res.json()) as { isPaid?: boolean; pending?: boolean };
        if (active && json?.isPaid) {
          setPaid(true);
          // Announce it so measurement can react without polling this order
          // a second time. No payment logic depends on this event.
          window.dispatchEvent(new CustomEvent("vanta:order-paid", { detail: { orderId } }));
          return;
        }
        // The route's own verdict: `pending: false` without `isPaid` means the
        // processor is finished and the order was not paid. Only an explicit
        // false counts — the same rule the payment page's decideFromOrderStatus
        // applies — so a truncated or older response keeps polling rather than
        // announcing a decline.
        if (active && json?.pending === false) {
          setFailed(true);
          return;
        }
      } catch {
        /* transient — keep polling */
      }
      if (!active) return;
      if (attempts.current >= MAX_ATTEMPTS) {
        setTimedOut(true);
        return;
      }
      timer = window.setTimeout(tick, 3000);
    };

    timer = window.setTimeout(tick, 2500);
    return () => {
      active = false;
      if (timer) window.clearTimeout(timer);
    };
  }, [paid, failed, isManual, orderId]);

  // break-words so a long masked address wraps instead of forcing the card wide
  // and clipping the reference on a narrow phone.
  const orderLine = (
    <p className="mt-2.5 break-words text-sm leading-6 text-white/60">
      Order <span className="font-semibold text-white">{orderNumber}</span>
      {maskedEmail ? <> — {EMAIL_CONFIRMATION_LEAD} <span className="text-white/80">{maskedEmail}</span>.</> : "."}
    </p>
  );

  // Tightened from h-14/mt-5/mt-3/text-4xl: on a phone the hero occupied most of
  // the first screen, pushing the order summary below the fold.
  const icon = "mx-auto flex h-12 w-12 items-center justify-center rounded-full border";
  const heading = "vl2-serif mt-2.5 text-[26px] leading-tight text-white sm:text-[32px]";

  if (paid) {
    return (
      <>
        <div className={`${icon} border-emerald-300/40 bg-emerald-400/15 text-xl`}>✓</div>
        <p className="vl2-eyebrow mt-4 text-emerald-300">Order confirmed</p>
        <h1 className={heading}>Thank you for your order</h1>
        {orderLine}
        <p className="mt-2 text-sm leading-6 text-white/50">We&apos;re preparing your order. You&apos;ll get a shipping email with tracking once it&apos;s on the way.</p>
        {/* Only on the confirmed branch — a timeline whose first step reads
            "Order confirmed" must not appear while we're still verifying the
            charge. It renders the moment polling flips `paid` to true. */}
        <OrderStatusTimeline fulfillmentStatus={fulfillmentStatus} />
      </>
    );
  }

  // A card order the processor has finished with and did NOT pay. The only
  // honest words are that no money moved and the order will not ship — never
  // "thank you", never "no need to pay again". Both were shown for exactly this
  // state, and a shopper told not to pay again does not; the sale is lost in
  // silence. A declined order releases its stock hold, so the way forward is a
  // fresh checkout, the same as the payment page's own decline notice.
  if (failed) {
    return (
      <>
        <div className={`${icon} border-amber-300/40 bg-amber-400/15 text-xl`}>!</div>
        <p className="vl2-eyebrow mt-4 text-amber-200" role="status" aria-live="polite">Payment not completed</p>
        <h1 className={heading}>Your payment didn&apos;t go through</h1>
        <p className="mt-2.5 text-sm leading-6 text-white/60">
          Order <span className="font-semibold text-white">{orderNumber}</span>.
        </p>
        <p className="mt-2 text-sm leading-6 text-white/50">
          Your card has not been charged and this order will not ship. This is usually the bank declining the transaction — go back to checkout to place the order again, or contact support if you think this is a mistake.
        </p>
        <Link href="/checkout" className="vl2-btn-primary vl-focus-ring mt-5 flex w-full items-center justify-center px-6 py-3.5 text-sm">
          Back to checkout →
        </Link>
      </>
    );
  }

  if (confirming) {
    return (
      <>
        <div className={`${icon} border-cyan-300/40 bg-cyan-400/15`}>
          <span className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-cyan-200/40 border-t-cyan-200" aria-hidden="true" />
        </div>
        <p className="vl2-eyebrow mt-4 text-cyan-200" role="status" aria-live="polite">Confirming your payment…</p>
        <h1 className={heading}>Thank you for your order</h1>
        {orderLine}
        <p className="mt-2 text-sm leading-6 text-white/50">This usually takes just a few seconds — no need to pay again. You&apos;ll get an email confirmation the moment it clears.</p>
      </>
    );
  }

  // Manual method awaiting payment → real "complete payment" CTA.
  if (isManual) {
    return (
      <>
        <div className={`${icon} border-amber-300/40 bg-amber-400/15 text-xl`}>⏳</div>
        <p className="vl2-eyebrow mt-4 text-amber-200">Order received — payment pending</p>
        <h1 className={heading}>One step left</h1>
        {orderLine}
        <p className="mt-2 text-sm leading-6 text-white/50">Your order is reserved but hasn&apos;t been paid yet — complete payment below and we&apos;ll ship it as soon as it clears.</p>
        <Link href={`/pay/${encodeURIComponent(orderId)}`} className="vl2-btn-primary vl-focus-ring mt-5 flex w-full items-center justify-center px-6 py-3.5 text-sm">
          Complete payment →
        </Link>
      </>
    );
  }

  // Card order still not confirmed after the polling window: reassure, never
  // tell them to pay again.
  return (
    <>
      <div className={`${icon} border-cyan-300/40 bg-cyan-400/15 text-xl`}>✓</div>
      <p className="vl2-eyebrow mt-4 text-cyan-200">Order received</p>
      <h1 className={heading}>Thank you for your order</h1>
      {orderLine}
      <p className="mt-2 text-sm leading-6 text-white/50">
        Your payment is still being confirmed — this can occasionally take a minute. You&apos;ll get an email as soon as it clears; there&apos;s no need to pay again.
      </p>
    </>
  );
}
