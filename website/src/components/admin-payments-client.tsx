"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { AdminPaymentRow } from "@/lib/admin-payments";

function money(value: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);
}

export function methodLabel(method: string) {
  switch (method) {
    case "cashapp":
      return "Cash App";
    case "zelle":
      return "Zelle";
    case "paypal":
      return "PayPal";
    case "venmo":
      return "Venmo";
    case "card":
      return "Card";
    default:
      return method;
  }
}

function formatDate(value: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  return date.toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    awaiting_verification: "border-amber-300/40 bg-amber-300/10 text-amber-200",
    paid: "border-emerald-300/40 bg-emerald-300/10 text-emerald-200",
    payment_rejected: "border-rose-300/40 bg-rose-300/10 text-rose-200",
    pending_payment: "border-white/20 bg-white/5 text-zinc-300",
  };
  const label = status.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
  return (
    <span className={`inline-block rounded-full border px-2.5 py-1 text-[11px] font-semibold ${map[status] ?? "border-white/20 bg-white/5 text-zinc-300"}`}>
      {label}
    </span>
  );
}

function CopyOrderNumber({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          /* no-op */
        }
      }}
      className="vl-focus-ring inline-flex items-center gap-1 rounded-md border border-white/15 bg-white/[0.04] px-2 py-1 text-[11px] font-semibold text-zinc-200 transition hover:border-white/40"
      title="Copy order number"
    >
      {copied ? "✓ Copied" : "Copy #"}
    </button>
  );
}

function PaymentRow({ row }: { row: AdminPaymentRow }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const isPaid = row.payment_status === "paid";

  const runAction = async (action: string, reason?: string) => {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/admin/payments/${row.order_id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, reason }),
      });
      const json = (await res.json()) as { success: boolean; error?: string };
      if (!res.ok || !json.success) {
        setMessage(json.error ?? "Action failed");
        setBusy(false);
        return;
      }
      router.refresh();
    } catch {
      setMessage("Action failed");
    } finally {
      setBusy(false);
    }
  };

  const handleReject = () => {
    const reason = window.prompt("Reason for rejecting this payment (emailed to the customer):", "");
    if (reason === null) return;
    void runAction("reject", reason);
  };

  const handleApprove = () => {
    if (!window.confirm(`Approve ${methodLabel(row.payment_method)} payment for ${row.order_number}? This marks it paid and sends it to fulfillment.`)) {
      return;
    }
    void runAction("approve");
  };

  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-lg font-bold text-white">{row.order_number}</span>
            <CopyOrderNumber value={row.order_number} />
            <StatusBadge status={row.payment_status} />
          </div>
          <p className="mt-1 text-sm text-zinc-300">
            {row.customer_name || "—"} · <span className="text-zinc-400">{row.customer_email || "—"}</span>
          </p>
          <p className="mt-1 text-xs text-zinc-500">Submitted {formatDate(row.payment_submitted_at)} · Placed {formatDate(row.created_at)}</p>
        </div>
        <div className="text-right">
          <p className="text-xl font-semibold text-white">{money(row.amount_paid)}</p>
          <p className="text-xs uppercase tracking-[0.12em] text-zinc-400">{methodLabel(row.payment_method)}</p>
        </div>
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <div className="rounded-lg border border-white/10 bg-black/20 p-3">
          <p className="text-[11px] uppercase tracking-[0.12em] text-zinc-500">Products</p>
          <ul className="mt-1 space-y-0.5 text-sm text-zinc-300">
            {row.items.length > 0 ? (
              row.items.map((item, index) => (
                <li key={index}>
                  {item.name} <span className="text-zinc-500">× {item.quantity}</span>
                </li>
              ))
            ) : (
              <li className="text-zinc-500">No items recorded</li>
            )}
          </ul>
        </div>
        <div className="rounded-lg border border-white/10 bg-black/20 p-3">
          <p className="text-[11px] uppercase tracking-[0.12em] text-zinc-500">Payment Proof</p>
          <p className="mt-1 break-all text-sm text-zinc-300">
            {row.payment_reference ? <>Txn: <span className="font-mono">{row.payment_reference}</span></> : <span className="text-zinc-500">No transaction ID</span>}
          </p>
          {row.payment_proof_url ? (
            <a href={row.payment_proof_url} target="_blank" rel="noopener noreferrer" className="mt-1 inline-block text-sm text-cyan-300 underline-offset-2 hover:underline">
              View screenshot ↗
            </a>
          ) : (
            <p className="mt-1 text-sm text-zinc-500">No screenshot uploaded</p>
          )}
          {row.rejection_reason ? <p className="mt-1 text-xs text-rose-300">Rejected: {row.rejection_reason}</p> : null}
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button type="button" disabled={busy || isPaid} onClick={handleApprove} className="rounded-lg border border-emerald-400/40 bg-emerald-400/10 px-3 py-1.5 text-xs font-semibold text-emerald-200 transition hover:bg-emerald-400/20 disabled:opacity-40">
          Approve Payment
        </button>
        <button type="button" disabled={busy || isPaid} onClick={handleReject} className="rounded-lg border border-rose-400/40 bg-rose-400/10 px-3 py-1.5 text-xs font-semibold text-rose-200 transition hover:bg-rose-400/20 disabled:opacity-40">
          Reject
        </button>
        <button type="button" disabled={busy || isPaid} onClick={() => runAction("mark_paid")} className="vl-btn-secondary px-3 py-1.5 text-xs disabled:opacity-40">
          Mark Paid
        </button>
        <button type="button" disabled={busy} onClick={() => runAction("resend_email")} className="vl-btn-secondary px-3 py-1.5 text-xs disabled:opacity-40">
          Resend Email
        </button>
        {message ? <span className="text-xs text-rose-300">{message}</span> : null}
      </div>
    </div>
  );
}

export function AdminPaymentsClient({ rows }: { rows: AdminPaymentRow[] }) {
  if (rows.length === 0) {
    return (
      <div className="vl-panel mt-6 rounded-2xl p-10 text-center text-sm text-zinc-400">
        No manual payments match these filters yet.
      </div>
    );
  }

  return (
    <div className="mt-6 grid gap-3">
      {rows.map((row) => (
        <PaymentRow key={row.id} row={row} />
      ))}
    </div>
  );
}
