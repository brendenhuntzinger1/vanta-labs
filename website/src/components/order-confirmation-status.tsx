"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { OrderStatusTimeline } from "@/components/order-status-timeline";

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
  isManual,
  fulfillmentStatus,
}: {
  orderId: string;
  orderNumber: string;
  maskedEmail: string | null;
  initialPaid: boolean;
  isManual: boolean;
  fulfillmentStatus: string | null;
}) {
  const [paid, setPaid] = useState(initialPaid);
  const [timedOut, setTimedOut] = useState(false);
  const attempts = useRef(0);

  // Poll only for a not-yet-paid CARD order (the webhook-lag case). Manual
  // orders genuinely await payment; paid orders are done.
  const confirming = !paid && !isManual && !timedOut;

  useEffect(() => {
    if (paid || isManual) return;
    let active = true;
    let timer: number | undefined;
    const MAX_ATTEMPTS = 20; // ~60s at 3s

    const tick = async () => {
      if (!active) return;
      attempts.current += 1;
      try {
        const res = await fetch(`/api/checkout/order-status/${encodeURIComponent(orderId)}`, { cache: "no-store" });
        const json = (await res.json()) as { isPaid?: boolean };
        if (active && json?.isPaid) {
          setPaid(true);
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
  }, [paid, isManual, orderId]);

  // break-words so a long masked address wraps instead of forcing the card wide
  // and clipping the reference on a narrow phone.
  const orderLine = (
    <p className="mt-2.5 break-words text-sm leading-6 text-white/60">
      Order <span className="font-semibold text-white">{orderNumber}</span>
      {maskedEmail ? <> — a confirmation was sent to <span className="text-white/80">{maskedEmail}</span>.</> : "."}
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
