"use client";

import { useMemo, useState } from "react";
import { resolvePromotions, type PromotionRulesConfig, type PromotionType } from "@/lib/promotion-engine";

const PROMOTION_LABELS: Record<PromotionType, string> = {
  bulk_savings: "Bulk savings",
  buy3get1: "Buy 3 Get 1 Free",
  referral: "Referral code",
  coupon: "Coupon code",
  member_pricing: "Membership discount",
  ambassador: "Ambassador discount",
};

const STACKING_LABELS: Array<{ key: keyof PromotionRulesConfig["stacking"]; label: string }> = [
  { key: "buy3get1_ambassador", label: "Buy 3 Get 1 Free + Ambassador discount" },
  { key: "buy3get1_membership", label: "Buy 3 Get 1 Free + Membership discount" },
  { key: "referral_membership", label: "Referral code + Membership discount" },
  { key: "coupon_promotions", label: "Coupon code + Automatic promotions" },
];

export function AdminPromotionsClient({ initialBuy3Get1Enabled, initialRules }: { initialBuy3Get1Enabled: boolean; initialRules: PromotionRulesConfig }) {
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

  const [rules, setRules] = useState<PromotionRulesConfig>(initialRules);
  const [savingRules, setSavingRules] = useState(false);
  const [rulesMessage, setRulesMessage] = useState<string | null>(null);
  // Live-preview sample discount amounts (in dollars) per promotion.
  const [preview, setPreview] = useState<Record<PromotionType, string>>({
    bulk_savings: "0", buy3get1: "0", referral: "10", coupon: "0", member_pricing: "8", ambassador: "15",
  });

  const previewResult = useMemo(() => {
    const candidates = (Object.keys(preview) as PromotionType[])
      .map((type) => ({ type, amount: Number(preview[type]) || 0 }))
      .filter((c) => c.amount > 0);
    return resolvePromotions(candidates, rules);
  }, [preview, rules]);

  const saveRules = async () => {
    setSavingRules(true);
    setRulesMessage(null);
    try {
      const res = await fetch("/api/admin/promotions", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rules }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error(json.error ?? "Save failed");
      if (json.rules) setRules(json.rules);
      setRulesMessage("Promotion rules saved — live at checkout now.");
    } catch (error) {
      setRulesMessage(error instanceof Error ? error.message : "Save failed");
    } finally {
      setSavingRules(false);
    }
  };

  const movePriority = (index: number, direction: -1 | 1) => {
    setRules((prev) => {
      const next = [...prev.priority];
      const target = index + direction;
      if (target < 0 || target >= next.length) return prev;
      [next[index], next[target]] = [next[target], next[index]];
      return { ...prev, priority: next };
    });
  };

  return (
    <>
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

    <section className="vl-panel rounded-2xl p-5 sm:p-6">
      <h2 className="text-lg font-semibold text-white">Promotion Rules</h2>
      <p className="mt-2 text-sm text-zinc-400">Control which promotions are active, how they combine, and which wins. Changes apply to checkout instantly.</p>

      {/* Enable / disable individual promotions */}
      <div className="mt-5">
        <p className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">Enabled promotions</p>
        <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {(Object.keys(PROMOTION_LABELS) as PromotionType[]).map((type) => (
            <label key={type} className="flex items-center gap-2 rounded-lg border border-zinc-800 p-2 text-sm text-zinc-300">
              <input
                type="checkbox"
                checked={rules.enabled[type] !== false}
                onChange={(e) => setRules((prev) => ({ ...prev, enabled: { ...prev.enabled, [type]: e.target.checked } }))}
              />
              {PROMOTION_LABELS[type]}
            </label>
          ))}
        </div>
      </div>

      {/* Choose highest automatically */}
      <label className="mt-4 flex items-center gap-2 rounded-lg border border-zinc-800 p-2 text-sm text-zinc-300">
        <input
          type="checkbox"
          checked={rules.chooseHighestAutomatically}
          onChange={(e) => setRules((prev) => ({ ...prev, chooseHighestAutomatically: e.target.checked }))}
        />
        Choose highest discount automatically (off = use the priority order below)
      </label>

      {/* Stacking toggles */}
      <div className="mt-4">
        <p className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">Allow stacking</p>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          {STACKING_LABELS.map(({ key, label }) => (
            <label key={key} className="flex items-center gap-2 rounded-lg border border-zinc-800 p-2 text-sm text-zinc-300">
              <input
                type="checkbox"
                checked={rules.stacking[key]}
                onChange={(e) => setRules((prev) => ({ ...prev, stacking: { ...prev.stacking, [key]: e.target.checked } }))}
              />
              {label}
            </label>
          ))}
        </div>
      </div>

      {/* Priority order */}
      <div className="mt-4">
        <p className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">Priority order (top = highest)</p>
        <ol className="mt-2 space-y-1">
          {rules.priority.map((type, index) => (
            <li key={type} className="flex items-center justify-between gap-2 rounded-lg border border-zinc-800 px-3 py-1.5 text-sm text-zinc-200">
              <span>{index + 1}. {PROMOTION_LABELS[type]}</span>
              <span className="flex gap-1">
                <button type="button" onClick={() => movePriority(index, -1)} disabled={index === 0} className="rounded border border-zinc-700 px-2 text-xs disabled:opacity-40">↑</button>
                <button type="button" onClick={() => movePriority(index, 1)} disabled={index === rules.priority.length - 1} className="rounded border border-zinc-700 px-2 text-xs disabled:opacity-40">↓</button>
              </span>
            </li>
          ))}
        </ol>
      </div>

      {/* Live preview */}
      <div className="mt-5 rounded-xl border border-zinc-800/70 bg-zinc-900/40 p-3">
        <p className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">Live preview — enter sample discount $ per promotion</p>
        <div className="mt-2 grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
          {(Object.keys(PROMOTION_LABELS) as PromotionType[]).map((type) => (
            <label key={type} className="text-xs text-zinc-400">
              {PROMOTION_LABELS[type]}
              <input
                type="number"
                min={0}
                step="0.01"
                value={preview[type]}
                onChange={(e) => setPreview((prev) => ({ ...prev, [type]: e.target.value }))}
                className="vl-input mt-1 w-full px-2 py-1 text-sm"
              />
            </label>
          ))}
        </div>
        <p className="mt-3 text-sm text-zinc-200">
          Applied: <span className="font-semibold text-emerald-300">{previewResult.applied.length ? previewResult.applied.map((t) => PROMOTION_LABELS[t]).join(" + ") : "none"}</span>
          {" · "}Total discount: <span className="font-semibold text-emerald-300">${previewResult.totalDiscount.toFixed(2)}</span>
        </p>
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-3">
        <button type="button" onClick={saveRules} disabled={savingRules} className="vl-focus-ring rounded-lg bg-cyan-300 px-4 py-2 text-sm font-semibold text-zinc-950 disabled:opacity-60">
          {savingRules ? "Saving…" : "Save promotion rules"}
        </button>
        {rulesMessage ? <span className="text-sm text-zinc-200">{rulesMessage}</span> : null}
      </div>
    </section>
    </>
  );
}
