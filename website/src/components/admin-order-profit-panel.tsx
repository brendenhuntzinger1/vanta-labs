"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export interface OrderProfitView {
  grossRevenue: number;
  merchandiseRevenue: number;
  shippingCharged: number;
  additionalRevenue: number;
  taxCountedAsProfit: boolean;
  cogs: number;
  shippingCost: number;
  shippingCostIsEstimate: boolean;
  shippingCostSource: string | null;
  shippingProfit: number;
  processingFee: number;
  commission: number;
  refund: number;
  taxCollected: number;
  profit: number;
  marginPercent: number;
  profitStatus: "estimated" | "finalized";
  hasEstimatedCost: boolean;
}

export interface ShippingCostAuditView {
  id: string;
  estimatedCostCents: number | null;
  exactCostCents: number | null;
  differenceCents: number | null;
  source: string;
  finalizedNetProfitCents: number | null;
  createdAt: string;
}

function money(n: number): string {
  const sign = n < 0 ? "-" : "";
  return `${sign}$${Math.abs(n).toFixed(2)}`;
}

function centsMoney(c: number | null): string {
  return c == null ? "—" : money(c / 100);
}

function ExpenseRow({ label, amount, muted }: { label: string; amount: number; muted?: boolean }) {
  return (
    <div className="flex justify-between">
      <dt className="text-zinc-400">− {label}</dt>
      <dd className={`tabular-nums ${muted ? "text-zinc-400" : "text-rose-300"}`}>{money(-amount)}</dd>
    </div>
  );
}

export function AdminOrderProfitPanel({
  orderId,
  profit,
  audit,
  canEdit,
}: {
  orderId: string;
  profit: OrderProfitView;
  audit: ShippingCostAuditView[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const [amount, setAmount] = useState(profit.shippingCostIsEstimate ? "" : profit.shippingCost.toFixed(2));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const estimated = profit.profitStatus === "estimated";

  async function saveShippingCost(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const value = Number(amount);
    if (!Number.isFinite(value) || value < 0) {
      setError("Enter a valid shipping cost.");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`/api/admin/orders/${orderId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "set_shipping_cost", shippingCostAmount: value }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.success) {
        setError(json.error ?? "Unable to save shipping cost.");
        return;
      }
      router.refresh();
    } catch {
      setError("Network error — try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <details open className="mt-6 rounded-2xl border border-white/10 bg-white/[0.02] p-4 sm:p-5">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3">
        <span className="text-sm font-semibold uppercase tracking-[0.18em] text-zinc-300">Profit Breakdown</span>
        <span className="flex items-center gap-2">
          <span className={`tabular-nums text-base font-semibold ${profit.profit >= 0 ? "text-emerald-300" : "text-rose-300"}`}>{money(profit.profit)}</span>
          <span
            className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
              estimated ? "bg-amber-400/15 text-amber-300" : "bg-emerald-400/15 text-emerald-300"
            }`}
          >
            {estimated ? "Estimated" : "Finalized"}
          </span>
        </span>
      </summary>

      <dl className="mt-4 space-y-1.5 text-sm">
        <div className="flex justify-between">
          <dt className="text-zinc-300 font-medium">Gross revenue{profit.taxCountedAsProfit ? " (incl. tax)" : " (ex-tax)"}</dt>
          <dd className="text-zinc-100 tabular-nums font-medium">{money(profit.grossRevenue)}</dd>
        </div>
        <div className="flex justify-between pl-3">
          <dt className="text-zinc-500">Merchandise</dt>
          <dd className="text-zinc-400 tabular-nums">{money(profit.merchandiseRevenue)}</dd>
        </div>
        <div className="flex justify-between pl-3">
          <dt className="text-zinc-500">Shipping charged</dt>
          <dd className="text-zinc-400 tabular-nums">{money(profit.shippingCharged)}</dd>
        </div>
        {profit.additionalRevenue > 0 ? (
          <div className="flex justify-between pl-3">
            <dt className="text-zinc-500">Shipping protection &amp; fees</dt>
            <dd className="text-zinc-400 tabular-nums">{money(profit.additionalRevenue)}</dd>
          </div>
        ) : null}
        {profit.taxCountedAsProfit && profit.taxCollected > 0 ? (
          <div className="flex justify-between pl-3">
            <dt className="text-zinc-500">Sales tax (counted as profit)</dt>
            <dd className="text-zinc-400 tabular-nums">{money(profit.taxCollected)}</dd>
          </div>
        ) : null}

        <div className="!mt-3 border-t border-white/10 pt-2" />

        <ExpenseRow label="Product cost (COGS)" amount={profit.cogs} />
        <div className="flex justify-between">
          <dt className="text-zinc-400">
            − Shipping cost
            <span className="text-zinc-500">
              {" "}
              ({profit.shippingCostIsEstimate ? "estimated" : profit.shippingCostSource ?? "exact"})
            </span>
          </dt>
          <dd className="text-rose-300 tabular-nums">{money(-profit.shippingCost)}</dd>
        </div>
        <div className="flex justify-between pl-3">
          <dt className="text-zinc-500">Shipping profit / loss</dt>
          <dd className={`tabular-nums ${profit.shippingProfit >= 0 ? "text-emerald-300/80" : "text-rose-300/80"}`}>{money(profit.shippingProfit)}</dd>
        </div>
        <ExpenseRow label="Payment processor fee" amount={profit.processingFee} />
        {profit.commission > 0 ? <ExpenseRow label="Ambassador commission" amount={profit.commission} /> : null}
        {profit.refund > 0 ? <ExpenseRow label="Refunds" amount={profit.refund} /> : null}

        {!profit.taxCountedAsProfit && profit.taxCollected > 0 ? (
          <div className="flex justify-between pt-1">
            <dt className="text-zinc-500">Sales tax collected (remitted — not profit)</dt>
            <dd className="text-zinc-500 tabular-nums">{money(profit.taxCollected)}</dd>
          </div>
        ) : null}

        <div className="!mt-2 flex justify-between border-t border-white/10 pt-2 text-base font-semibold">
          <dt className={profit.profit >= 0 ? "text-emerald-300" : "text-rose-300"}>Net profit</dt>
          <dd className={`tabular-nums ${profit.profit >= 0 ? "text-emerald-300" : "text-rose-300"}`}>
            {money(profit.profit)} <span className="text-xs font-normal text-zinc-500">({profit.marginPercent.toFixed(1)}%)</span>
          </dd>
        </div>
      </dl>

      {estimated ? (
        <p className="mt-3 rounded-lg border border-amber-400/20 bg-amber-400/5 px-3 py-2 text-[11px] text-amber-300/90">
          {profit.shippingCostIsEstimate ? "⚠ Exact shipping cost pending — profit uses the estimated shipping cost and will finalize once the label cost is recorded." : ""}
          {profit.hasEstimatedCost ? " Some items had no cost recorded at checkout, so their COGS is estimated at the worst-case assumption." : ""}
        </p>
      ) : null}

      {canEdit ? (
        <form onSubmit={saveShippingCost} className="mt-4 flex flex-wrap items-end gap-2 border-t border-white/10 pt-4">
          <label className="text-xs text-zinc-400">
            {profit.shippingCostIsEstimate ? "Enter exact shipping-label cost" : "Correct shipping-label cost"}
            <div className="mt-1 flex items-center gap-1">
              <span className="text-zinc-500">$</span>
              <input
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                inputMode="decimal"
                placeholder="7.25"
                className="vl-input w-28 px-3 py-2 text-sm"
              />
            </div>
          </label>
          <button type="submit" disabled={saving} className="vl-btn-primary px-4 py-2 text-xs disabled:opacity-60">
            {saving ? "Saving…" : "Save exact cost"}
          </button>
          {error ? <span className="text-[11px] text-rose-300">{error}</span> : null}
        </form>
      ) : null}

      {audit.length > 0 ? (
        <details className="mt-4 border-t border-white/10 pt-3">
          <summary className="cursor-pointer text-[11px] uppercase tracking-[0.18em] text-zinc-500">Shipping cost history ({audit.length})</summary>
          <ul className="mt-2 space-y-1.5 text-[11px] text-zinc-400">
            {audit.map((entry) => (
              <li key={entry.id} className="flex flex-wrap justify-between gap-2">
                <span>
                  {new Date(entry.createdAt).toLocaleString()} · <span className="text-zinc-500">{entry.source}</span>
                </span>
                <span className="tabular-nums">
                  est {centsMoney(entry.estimatedCostCents)} → exact {centsMoney(entry.exactCostCents)}
                  {entry.differenceCents != null ? ` (${entry.differenceCents >= 0 ? "+" : "−"}${centsMoney(Math.abs(entry.differenceCents))})` : ""}
                </span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </details>
  );
}
