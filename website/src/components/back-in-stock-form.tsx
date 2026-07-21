"use client";

import { useState } from "react";

// Shown on a sold-out product/variant so shoppers can be emailed when it's
// restocked (auto-sent when inventory is replenished in admin).
export function BackInStockForm({ productSlug, variantId }: { productSlug: string; variantId?: string }) {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "done">("idle");
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!/^\S+@\S+\.\S+$/.test(email)) {
      setError("Enter a valid email.");
      return;
    }
    setState("sending");
    setError(null);
    try {
      const res = await fetch("/api/catalog/back-in-stock", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productSlug, variantId, email }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setError(data.error ?? "Unable to save your request.");
        setState("idle");
        return;
      }
      setState("done");
    } catch {
      setError("Unable to save your request.");
      setState("idle");
    }
  };

  if (state === "done") {
    return (
      <div className="rounded-xl border border-emerald-400/30 bg-emerald-400/5 p-4 text-sm text-emerald-200">
        ✓ You&apos;re on the list — we&apos;ll email you the moment it&apos;s back in stock.
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-white/12 bg-white/[0.02] p-4">
      <p className="text-sm font-semibold text-white">Out of stock</p>
      <p className="mt-1 text-xs text-white/55">Get an email the moment this is back.</p>
      <div className="mt-3 flex flex-col gap-2 sm:flex-row">
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@email.com"
          aria-label="Email for back-in-stock notification"
          className="w-full flex-1 border border-white/15 bg-black/40 px-4 py-2.5 text-sm text-white placeholder:text-white/30 outline-none transition focus:border-white/50"
        />
        <button type="button" onClick={submit} disabled={state === "sending"} className="vl2-btn-primary vl-focus-ring px-4 py-2.5 text-sm disabled:opacity-60">
          {state === "sending" ? "…" : "Notify me"}
        </button>
      </div>
      {error ? <p className="mt-2 text-xs text-rose-300">{error}</p> : null}
    </div>
  );
}
