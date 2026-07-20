"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { PayoutRow } from "@/lib/admin-payouts";
import { methodLabel } from "@/components/admin-payments-client";

function money(value: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    paid: "border-emerald-300/40 bg-emerald-300/10 text-emerald-200",
    pending: "border-amber-300/40 bg-amber-300/10 text-amber-200",
    failed: "border-rose-300/40 bg-rose-300/10 text-rose-200",
  };
  return <span className={`inline-block rounded-full border px-2 py-0.5 text-[11px] font-semibold ${map[status] ?? map.pending}`}>{status.replace(/^\w/, (c) => c.toUpperCase())}</span>;
}

function Row({ row }: { row: PayoutRow }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  const setStatus = async (status: string) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/payouts/${row.order_id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if ((await res.json()).success) router.refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <tr className="border-b border-white/5">
      <td className="px-3 py-3 font-mono font-semibold text-white">{row.order_number}</td>
      <td className="px-3 py-3 text-zinc-300">{row.customer_name || "—"}</td>
      <td className="px-3 py-3 text-zinc-400">{methodLabel(row.payment_method)}</td>
      <td className="px-3 py-3 text-right text-zinc-300">{row.units}</td>
      <td className="px-3 py-3 text-right text-zinc-200">{money(row.gross)}</td>
      <td className="px-3 py-3 text-right text-zinc-400">{money(row.processorFees)}</td>
      <td className="px-3 py-3 text-right text-zinc-200">{money(row.netRevenue)}</td>
      <td className="px-3 py-3 text-right font-semibold text-amber-200">{money(row.threeplOwed)}</td>
      <td className="px-3 py-3 text-right font-semibold text-emerald-200">{money(row.profit)}</td>
      <td className="px-3 py-3"><StatusBadge status={row.payoutStatus} /></td>
      <td className="px-3 py-3">
        <div className="flex gap-1">
          <button type="button" disabled={busy} onClick={() => setStatus("paid")} className="rounded border border-emerald-400/30 bg-emerald-400/10 px-2 py-1 text-[11px] text-emerald-200 disabled:opacity-40">Paid</button>
          <button type="button" disabled={busy} onClick={() => setStatus("failed")} className="rounded border border-rose-400/30 bg-rose-400/10 px-2 py-1 text-[11px] text-rose-200 disabled:opacity-40">Failed</button>
          <button type="button" disabled={busy} onClick={() => setStatus("pending")} className="rounded border border-white/15 bg-white/5 px-2 py-1 text-[11px] text-zinc-300 disabled:opacity-40">Reset</button>
        </div>
      </td>
    </tr>
  );
}

export function AdminPayoutsClient({ rows }: { rows: PayoutRow[] }) {
  if (rows.length === 0) {
    return <div className="vl-panel mt-6 rounded-2xl p-10 text-center text-sm text-zinc-400">No paid orders yet — payouts appear here automatically.</div>;
  }
  return (
    <div className="vl-panel mt-6 overflow-x-auto rounded-2xl p-2">
      <table className="w-full min-w-[880px] text-left text-sm">
        <thead>
          <tr className="text-[11px] uppercase tracking-[0.1em] text-zinc-500">
            <th className="px-3 py-2">Order #</th>
            <th className="px-3 py-2">Customer</th>
            <th className="px-3 py-2">Method</th>
            <th className="px-3 py-2 text-right">Units</th>
            <th className="px-3 py-2 text-right">Gross</th>
            <th className="px-3 py-2 text-right">Proc. Fees</th>
            <th className="px-3 py-2 text-right">Net</th>
            <th className="px-3 py-2 text-right">3PL Owed</th>
            <th className="px-3 py-2 text-right">Profit</th>
            <th className="px-3 py-2">Payout</th>
            <th className="px-3 py-2">Actions</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => <Row key={row.order_id} row={row} />)}
        </tbody>
      </table>
    </div>
  );
}
