"use client";

import { useMemo, useState } from "react";
import type { AbandonedCartRow, CartRecoveryStats, RecoveryTrendPoint } from "@/lib/admin-cart-recovery";
import type { CartRecoveryConfig } from "@/lib/admin-control";

function money(cents: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);
}

function TrendChart({ title, points }: { title: string; points: RecoveryTrendPoint[] }) {
  const max = useMemo(() => Math.max(...points.map((p) => p.abandoned), 1), [points]);

  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.03] p-4">
      <p className="text-xs font-semibold uppercase tracking-[0.14em] text-zinc-500">{title}</p>
      {points.length === 0 ? (
        <p className="mt-3 text-sm text-zinc-500">No data yet.</p>
      ) : (
        <div className="mt-4 grid grid-flow-col auto-cols-fr gap-1.5 overflow-x-auto">
          {points.map((point) => {
            const abandonedHeight = Math.max(6, Math.round((point.abandoned / max) * 100));
            const recoveredHeight = Math.max(0, Math.round((point.recovered / max) * 100));
            return (
              <div key={point.date} className="flex min-w-[20px] flex-col items-center gap-1">
                <div className="relative flex h-24 w-full items-end rounded-sm bg-white/5 p-0.5">
                  <div className="w-full rounded-sm bg-white/40" style={{ height: `${abandonedHeight}%` }} />
                  <div className="absolute bottom-0.5 w-full rounded-sm bg-emerald-400" style={{ height: `${recoveredHeight}%` }} />
                </div>
                <p className="text-[9px] text-zinc-600">{point.date.slice(5)}</p>
              </div>
            );
          })}
        </div>
      )}
      <div className="mt-2 flex gap-4 text-[10px] text-zinc-500">
        <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-white/40" /> Abandoned</span>
        <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-emerald-400" /> Recovered</span>
      </div>
    </div>
  );
}

export function AdminCartRecoveryClient({
  initialCarts,
  initialStats,
  initialWeeklyTrend,
  initialMonthlyTrend,
  initialConfig,
}: {
  initialCarts: AbandonedCartRow[];
  initialStats: CartRecoveryStats;
  initialWeeklyTrend: RecoveryTrendPoint[];
  initialMonthlyTrend: RecoveryTrendPoint[];
  initialConfig: CartRecoveryConfig;
}) {
  const [carts] = useState(initialCarts);
  const [stats] = useState(initialStats);
  const [config, setConfig] = useState(initialConfig);
  const [message, setMessage] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [savingConfig, setSavingConfig] = useState(false);

  const resend = async (cartId: string, stage: "t30m" | "t12h" | "t24h" | "t72h") => {
    setBusyId(`${cartId}:${stage}`);
    setMessage(null);
    try {
      const response = await fetch("/api/admin/cart-recovery/resend", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cartId, stage }),
      });
      const result = await response.json() as { success: boolean; error?: string };
      setMessage(result.success ? "Recovery email sent." : (result.error ?? "Unable to send that email."));
    } catch {
      setMessage("Unable to send that email right now.");
    } finally {
      setBusyId(null);
    }
  };

  const saveConfig = async () => {
    setSavingConfig(true);
    setMessage(null);
    try {
      const response = await fetch("/api/admin/cart-recovery/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      });
      const result = await response.json() as { success: boolean; error?: string };
      setMessage(result.success ? "Settings saved." : (result.error ?? "Unable to save settings."));
    } catch {
      setMessage("Unable to save settings right now.");
    } finally {
      setSavingConfig(false);
    }
  };

  return (
    <div className="space-y-6">
      {message ? <p className="vl-panel rounded-xl p-3 text-sm text-zinc-200">{message}</p> : null}

      <section className="vl-panel rounded-2xl p-5 sm:p-6">
        <h2 className="text-lg font-semibold text-white">Overview</h2>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="vl-panel-soft rounded-xl p-4">
            <p className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">Total Abandoned</p>
            <p className="mt-2 text-2xl font-semibold text-white">{stats.totalAbandoned}</p>
          </div>
          <div className="vl-panel-soft rounded-xl p-4">
            <p className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">Total Recovered</p>
            <p className="mt-2 text-2xl font-semibold text-white">{stats.totalRecovered}</p>
          </div>
          <div className="vl-panel-soft rounded-xl p-4">
            <p className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">Recovery Rate</p>
            <p className="mt-2 text-2xl font-semibold text-white">{stats.recoveryPercent}%</p>
          </div>
          <div className="vl-panel-soft rounded-xl p-4">
            <p className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">Avg Recovery Time</p>
            <p className="mt-2 text-2xl font-semibold text-white">{stats.averageRecoveryTimeHours !== null ? `${stats.averageRecoveryTimeHours}h` : "—"}</p>
          </div>
          <div className="vl-panel-soft rounded-xl p-4">
            <p className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">Potential Lost Revenue</p>
            <p className="mt-2 text-2xl font-semibold text-white">{money(stats.potentialLostRevenueCents)}</p>
          </div>
          <div className="vl-panel-soft rounded-xl p-4">
            <p className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">Revenue Recovered</p>
            <p className="mt-2 text-2xl font-semibold text-white">{money(stats.revenueRecoveredCents)}</p>
          </div>
          <div className="vl-panel-soft rounded-xl p-4">
            <p className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">Open / Click Rate</p>
            <p className="mt-2 text-2xl font-semibold text-white">{stats.openRatePercent}% / {stats.clickRatePercent}%</p>
          </div>
          <div className="vl-panel-soft rounded-xl p-4">
            <p className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">Coupon Redemption Rate</p>
            <p className="mt-2 text-2xl font-semibold text-white">{stats.couponRedemptionRatePercent}%</p>
          </div>
        </div>
      </section>

      <section className="vl-panel rounded-2xl p-5 sm:p-6">
        <h2 className="text-lg font-semibold text-white">Recovery Performance</h2>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <TrendChart title="Last 7 Days" points={initialWeeklyTrend} />
          <TrendChart title="Last 30 Days" points={initialMonthlyTrend} />
        </div>
      </section>

      <section className="vl-panel rounded-2xl p-5 sm:p-6">
        <h2 className="text-lg font-semibold text-white">Email Sequence Settings</h2>
        <div className="mt-4 grid gap-3 sm:grid-cols-4">
          <label className="flex items-center gap-2 text-xs text-zinc-300">
            <input type="checkbox" checked={config.t30mEnabled} onChange={(e) => setConfig((prev) => ({ ...prev, t30mEnabled: e.target.checked }))} />
            30 min reminder
          </label>
          <label className="flex items-center gap-2 text-xs text-zinc-300">
            <input type="checkbox" checked={config.t12hEnabled} onChange={(e) => setConfig((prev) => ({ ...prev, t12hEnabled: e.target.checked }))} />
            12 hr reminder
          </label>
          <label className="flex items-center gap-2 text-xs text-zinc-300">
            <input type="checkbox" checked={config.t24hEnabled} onChange={(e) => setConfig((prev) => ({ ...prev, t24hEnabled: e.target.checked }))} />
            24 hr + coupon
          </label>
          <label className="flex items-center gap-2 text-xs text-zinc-300">
            <input type="checkbox" checked={config.t72hEnabled} onChange={(e) => setConfig((prev) => ({ ...prev, t72hEnabled: e.target.checked }))} />
            72 hr final reminder
          </label>
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <label className="text-xs text-zinc-400">
            Discount (%)
            <input
              type="number"
              step="0.5"
              value={config.discountPercent}
              onChange={(e) => setConfig((prev) => ({ ...prev, discountPercent: Number(e.target.value) }))}
              className="vl-input mt-1 w-full px-2 py-1.5"
            />
          </label>
          <label className="text-xs text-zinc-400">
            Coupon expiration (hours)
            <input
              type="number"
              value={config.couponExpirationHours}
              onChange={(e) => setConfig((prev) => ({ ...prev, couponExpirationHours: Number(e.target.value) }))}
              className="vl-input mt-1 w-full px-2 py-1.5"
            />
          </label>
        </div>
        <button type="button" onClick={saveConfig} disabled={savingConfig} className="vl-btn-primary vl-focus-ring mt-4 px-5 py-2.5 text-sm disabled:opacity-60">
          {savingConfig ? "Saving…" : "Save settings"}
        </button>
      </section>

      <section className="vl-panel rounded-2xl p-5 sm:p-6">
        <h2 className="text-lg font-semibold text-white">Abandoned Carts</h2>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[820px] text-left text-sm">
            <thead className="text-xs uppercase tracking-wide text-zinc-500">
              <tr>
                <th className="pb-2 pr-4">Email</th>
                <th className="pb-2 pr-4">Cart Value</th>
                <th className="pb-2 pr-4">Abandoned</th>
                <th className="pb-2 pr-4">Status</th>
                <th className="pb-2 pr-4">Stages Sent</th>
                <th className="pb-2 pr-4">Resend</th>
              </tr>
            </thead>
            <tbody>
              {carts.map((cart) => (
                <tr key={cart.id} className="border-t border-white/10">
                  <td className="py-2 pr-4 text-zinc-200">{cart.email}</td>
                  <td className="py-2 pr-4 text-zinc-200">{money(cart.cartValueCents)}</td>
                  <td className="py-2 pr-4 text-zinc-400">{new Date(cart.firstSeenAt).toLocaleString()}</td>
                  <td className="py-2 pr-4 text-zinc-400">{cart.status}</td>
                  <td className="py-2 pr-4 text-zinc-400">{cart.stagesSent.join(", ") || "—"}</td>
                  <td className="py-2 pr-4">
                    <div className="flex flex-wrap gap-1.5">
                      {(["t30m", "t12h", "t24h", "t72h"] as const).map((stage) => (
                        <button
                          key={stage}
                          type="button"
                          onClick={() => resend(cart.id, stage)}
                          disabled={busyId === `${cart.id}:${stage}` || cart.status !== "active"}
                          className="vl-btn-secondary px-2 py-1 text-[10px] disabled:opacity-50"
                        >
                          {stage}
                        </button>
                      ))}
                    </div>
                  </td>
                </tr>
              ))}
              {carts.length === 0 ? (
                <tr><td colSpan={6} className="py-6 text-center text-sm text-zinc-500">No abandoned carts yet.</td></tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
