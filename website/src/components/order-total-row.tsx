"use client";

import { useEffect, useState } from "react";

/**
 * The summary total, labelled by what is actually true right now.
 *
 * Two claims live on this page: the hero, which polls for payment, and this
 * row. Rendering the label on the server would freeze it at page load, so a
 * customer whose card confirms two seconds later would read "Order confirmed"
 * above "Not yet charged" — a new contradiction in place of the old one.
 *
 * The confirmation hero already announces `vanta:order-paid` the moment the
 * backend says so, so this listens to the same signal and both statements
 * change together. No payment logic depends on this; it decides a word.
 */
export function OrderTotalRow({ amount, initialPaid }: { amount: string; initialPaid: boolean }) {
  const [paid, setPaid] = useState(initialPaid);

  useEffect(() => {
    if (initialPaid) return;
    const onPaid = () => setPaid(true);
    window.addEventListener("vanta:order-paid", onPaid);
    return () => window.removeEventListener("vanta:order-paid", onPaid);
  }, [initialPaid]);

  return (
    <>
      <div className="mt-2 flex items-baseline justify-between gap-4 border-t border-white/10 pt-4">
        <span className="text-base font-semibold text-white">{paid ? "Total paid" : "Order total"}</span>
        <span className="text-lg font-semibold tabular-nums text-white">{amount}</span>
      </div>
      {!paid ? (
        <p className="mt-2 text-xs leading-5 text-white/45">
          Not yet charged — this is the amount due once your payment is confirmed.
        </p>
      ) : null}
    </>
  );
}
