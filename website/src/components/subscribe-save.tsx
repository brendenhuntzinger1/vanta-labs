"use client";

import { useEffect, useState } from "react";

type Config = { discountPercent: number; frequencyDays: number; headline: string };

// Subscribe & Save opt-in. Shown only when enabled in admin. It records intent
// (a pending subscription) and never charges — it activates once recurring
// billing is connected, so it's honestly labeled as launching soon.
export function SubscribeSave({ productSlug, variantId }: { productSlug: string; variantId?: string }) {
  const [config, setConfig] = useState<Config | null>(null);
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "done">("idle");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/catalog/subscribe-save", { cache: "no-store" });
        const data = (await res.json()) as { success: boolean; config: Config | null };
        if (data.success && data.config) setConfig(data.config);
      } catch {
        /* hidden if it fails */
      }
    })();
  }, []);

  if (!config) return null;

  const submit = async () => {
    if (!/^\S+@\S+\.\S+$/.test(email)) {
      setError("Enter a valid email.");
      return;
    }
    setState("sending");
    setError(null);
    try {
      const res = await fetch("/api/catalog/subscribe-save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productSlug, variantId, email }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setError(data.error ?? "Unable to save.");
        setState("idle");
        return;
      }
      setState("done");
    } catch {
      setError("Unable to save.");
      setState("idle");
    }
  };

  return (
    <div className="mt-4 rounded-xl border border-[color:var(--accent-gold-soft)] bg-white/[0.02] p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-white">{config.headline} — {config.discountPercent}% off</p>
          <p className="mt-0.5 text-xs text-white/55">Auto-delivery every {config.frequencyDays} days. Launching soon — reserve your spot.</p>
        </div>
        {state !== "done" ? (
          <button type="button" onClick={() => setOpen((o) => !o)} className="vl2-btn-secondary vl-focus-ring whitespace-nowrap px-3 py-2 text-xs">
            {open ? "Close" : "Opt in"}
          </button>
        ) : null}
      </div>

      {state === "done" ? (
        <p className="mt-2 text-sm text-emerald-300">✓ You&apos;re on the list — we&apos;ll email you when subscriptions launch.</p>
      ) : open ? (
        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@email.com"
            aria-label="Email to reserve a subscription"
            className="w-full flex-1 border border-white/15 bg-black/40 px-4 py-2.5 text-sm text-white placeholder:text-white/30 outline-none transition focus:border-white/50"
          />
          <button type="button" onClick={submit} disabled={state === "sending"} className="vl2-btn-primary vl-focus-ring px-4 py-2.5 text-sm disabled:opacity-60">
            {state === "sending" ? "…" : "Reserve"}
          </button>
        </div>
      ) : null}
      {error ? <p className="mt-2 text-xs text-rose-300">{error}</p> : null}
    </div>
  );
}
