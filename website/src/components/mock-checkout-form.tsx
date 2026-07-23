"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// Buttons on the sandbox /pay/mock page. "Pay" approves the simulated card and
// "Simulate decline" fails it; both post to /api/checkout/mock-pay, which runs
// the fake payment through the real webhook pipeline. On approval the shopper
// lands on the normal order-confirmation page, exactly like a live processor
// return.
export function MockCheckoutForm({ orderId, orderNumber }: { orderId: string; orderNumber: string }) {
  const router = useRouter();
  const [state, setState] = useState<"idle" | "processing" | "declined">("idle");
  const [message, setMessage] = useState<string | null>(null);

  async function submit(outcome: "approve" | "decline") {
    setState("processing");
    setMessage(null);

    try {
      const response = await fetch("/api/checkout/mock-pay", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderId, outcome }),
      });
      const result = await response.json();

      if (!response.ok || !result.success) {
        throw new Error(result.error ?? "The simulated payment could not be processed.");
      }

      if (outcome === "approve") {
        router.push(`/order-confirmation/${orderId}`);
        return;
      }

      setState("declined");
      setMessage("Payment declined (sandbox). You can try approving it instead.");
    } catch (error) {
      setState("idle");
      setMessage(error instanceof Error ? error.message : "Something went wrong.");
    }
  }

  const busy = state === "processing";

  return (
    <div>
      <label className="block text-xs uppercase tracking-wide text-white/40">Card number</label>
      <input
        type="text"
        inputMode="numeric"
        defaultValue="4242 4242 4242 4242"
        readOnly
        aria-label="Test card number"
        className="mt-2 w-full border border-white/15 bg-white/5 px-3 py-2 text-sm text-white/80"
      />
      <p className="mt-1 text-xs text-white/40">Sandbox test card — no real card is accepted here.</p>

      <div className="mt-6 flex flex-col gap-3 sm:flex-row">
        <button
          type="button"
          disabled={busy}
          onClick={() => submit("approve")}
          className="inline-flex flex-1 items-center justify-center border border-emerald-400/40 bg-emerald-400/10 px-5 py-3 text-sm font-medium text-emerald-200 transition hover:bg-emerald-400/20 disabled:opacity-50"
        >
          {busy ? "Processing…" : "Pay now (approve)"}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => submit("decline")}
          className="inline-flex flex-1 items-center justify-center border border-white/15 px-5 py-3 text-sm text-white/60 transition hover:text-white disabled:opacity-50"
        >
          Simulate decline
        </button>
      </div>

      {message ? (
        <p className={`mt-4 text-sm ${state === "declined" ? "text-amber-300" : "text-red-300"}`}>{message}</p>
      ) : null}

      <p className="mt-6 text-xs text-white/30">Order reference: {orderNumber}</p>
    </div>
  );
}
