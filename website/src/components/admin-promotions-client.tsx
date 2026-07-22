"use client";

import { useState } from "react";

export function AdminPromotionsClient({ initialBuy3Get1Enabled }: { initialBuy3Get1Enabled: boolean }) {
  const [buy3Get1, setBuy3Get1] = useState(initialBuy3Get1Enabled);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const toggle = async (next: boolean) => {
    setSaving(true);
    setMessage(null);
    const previous = buy3Get1;
    setBuy3Get1(next); // optimistic
    try {
      const res = await fetch("/api/admin/promotions", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ buy3Get1Enabled: next }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json.error ?? "Save failed");
      }
      setMessage(next ? "Buy 3 Get 1 Free is now LIVE across the store." : "Buy 3 Get 1 Free is turned off.");
    } catch (error) {
      setBuy3Get1(previous); // revert on failure
      setMessage(error instanceof Error ? error.message : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="vl-panel rounded-2xl p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-lg font-semibold text-white">Buy 3 Get 1 Free</h2>
            <span
              className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold ${
                buy3Get1
                  ? "border-emerald-300/40 bg-emerald-300/10 text-emerald-200"
                  : "border-white/20 bg-white/5 text-zinc-300"
              }`}
            >
              {buy3Get1 ? "LIVE" : "Off"}
            </span>
          </div>
          <p className="mt-2 text-sm text-zinc-400">
            When on, every 4th eligible item in a cart is free automatically (the cheapest ones), with no coupon code.
            4 items → cheapest free · 8 → two cheapest free · 12 → three cheapest free. Works with mixed products and
            quantities, and never stacks with a referral or coupon code (the best single discount wins).
          </p>
        </div>

        <button
          type="button"
          role="switch"
          aria-checked={buy3Get1}
          disabled={saving}
          onClick={() => toggle(!buy3Get1)}
          className={`relative inline-flex h-11 w-[4.75rem] shrink-0 items-center rounded-full border transition disabled:opacity-60 ${
            buy3Get1 ? "border-emerald-300/50 bg-emerald-400/30" : "border-white/20 bg-white/10"
          }`}
        >
          <span
            className={`inline-block h-9 w-9 transform rounded-full bg-white shadow transition ${
              buy3Get1 ? "translate-x-[2.05rem]" : "translate-x-0.5"
            }`}
          />
          <span className="sr-only">Toggle Buy 3 Get 1 Free</span>
        </button>
      </div>

      {message ? <p className="mt-4 rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-sm text-zinc-200">{message}</p> : null}
    </section>
  );
}
