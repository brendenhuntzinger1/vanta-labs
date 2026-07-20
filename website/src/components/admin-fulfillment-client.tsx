"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { FulfillmentRow } from "@/lib/admin-fulfillment";
import { methodLabel } from "@/components/admin-payments-client";

function formatDate(value: string | null) {
  if (!value) return "—";
  return new Date(value).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
}

function CopyButton({ value, label }: { value: string; label: string }) {
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
      className="vl-focus-ring inline-flex items-center gap-1 rounded-md border border-white/20 bg-white/[0.05] px-2.5 py-1 text-xs font-semibold text-white transition hover:border-white/50"
    >
      {copied ? "✓ Copied" : label}
    </button>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    awaiting_fulfillment: "border-amber-300/40 bg-amber-300/10 text-amber-200",
    shipped: "border-cyan-300/40 bg-cyan-300/10 text-cyan-200",
    delivered: "border-emerald-300/40 bg-emerald-300/10 text-emerald-200",
  };
  const label = status.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
  return <span className={`inline-block rounded-full border px-2.5 py-1 text-[11px] font-semibold ${map[status] ?? "border-white/20 bg-white/5 text-zinc-300"}`}>{label}</span>;
}

function FulfillmentCard({ row }: { row: FulfillmentRow }) {
  const router = useRouter();
  const [carrier, setCarrier] = useState("");
  const [tracking, setTracking] = useState(row.tracking_number ?? "");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const save = async (fulfillmentStatus: string) => {
    setBusy(true);
    setMessage(null);
    try {
      // Reuses the existing order status endpoint so tracking + shipping
      // emails + shipment records all flow through the same tested path.
      const res = await fetch(`/api/admin/orders/${row.order_id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "update_status", fulfillmentStatus, trackingNumber: tracking.trim(), carrier: carrier.trim() || undefined }),
      });
      const json = (await res.json()) as { success: boolean; error?: string };
      if (!res.ok || !json.success) {
        setMessage(json.error ?? "Save failed");
        setBusy(false);
        return;
      }
      setMessage("Saved.");
      router.refresh();
    } catch {
      setMessage("Save failed");
    } finally {
      setBusy(false);
    }
  };

  const addressLines = [row.shipping_address, [row.city, row.postal_code].filter(Boolean).join(", "), row.country].filter(Boolean) as string[];
  const fullAddress = [row.customer_name, ...addressLines].filter(Boolean).join("\n");

  return (
    <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4 sm:p-5">
      {/* Order number is the single most prominent element for the 3PL. */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 pb-4">
        <div>
          <p className="text-[11px] uppercase tracking-[0.18em] text-zinc-500">Order Number</p>
          <p className="font-mono text-3xl font-bold leading-none text-white sm:text-4xl">{row.order_number}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <CopyButton value={row.order_number} label="Copy Order #" />
          <StatusBadge status={row.fulfillment_status} />
        </div>
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <div>
          <p className="text-[11px] uppercase tracking-[0.12em] text-zinc-500">Ship To</p>
          <div className="mt-1 flex items-start gap-2">
            <p className="whitespace-pre-line text-sm text-zinc-200">{fullAddress || "—"}</p>
            {fullAddress ? <CopyButton value={fullAddress} label="Copy" /> : null}
          </div>
          <p className="mt-2 text-xs text-zinc-400">{row.customer_email}</p>
          <p className="mt-1 text-xs text-zinc-500">Shipping: {row.shipping_method}</p>
        </div>

        <div>
          <p className="text-[11px] uppercase tracking-[0.12em] text-zinc-500">Items</p>
          <ul className="mt-1 space-y-0.5 text-sm text-zinc-200">
            {row.items.length > 0 ? (
              row.items.map((item, index) => (
                <li key={index}>{item.name} <span className="text-zinc-500">× {item.quantity}</span></li>
              ))
            ) : (
              <li className="text-zinc-500">No items recorded</li>
            )}
          </ul>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-zinc-500">
            <span>Payment: {methodLabel(row.payment_method)}</span>
            <span>Approved by: {row.verified_by || "—"}</span>
            <span>Approved: {formatDate(row.approved_at)}</span>
          </div>
        </div>
      </div>

      <div className="mt-4 grid gap-2 border-t border-white/10 pt-4 sm:grid-cols-[1fr_1.4fr_auto] sm:items-end">
        <label className="text-xs text-zinc-400">Carrier
          <input value={carrier} onChange={(e) => setCarrier(e.target.value)} placeholder="UPS, FedEx, USPS…" className="vl-input mt-1 w-full px-3 py-2 text-sm" />
        </label>
        <label className="text-xs text-zinc-400">Tracking number
          <input value={tracking} onChange={(e) => setTracking(e.target.value)} placeholder="1Z…" className="vl-input mt-1 w-full px-3 py-2 text-sm" />
        </label>
        <div className="flex gap-2">
          <button type="button" disabled={busy} onClick={() => save("shipped")} className="vl-btn-primary px-4 py-2 text-xs disabled:opacity-50">Mark Shipped</button>
          <button type="button" disabled={busy} onClick={() => save("delivered")} className="vl-btn-secondary px-4 py-2 text-xs disabled:opacity-50">Delivered</button>
        </div>
      </div>
      {message ? <p className="mt-2 text-xs text-zinc-300">{message}</p> : null}
    </div>
  );
}

export function AdminFulfillmentClient({ rows }: { rows: FulfillmentRow[] }) {
  if (rows.length === 0) {
    return (
      <div className="vl-panel mt-6 rounded-2xl p-10 text-center text-sm text-zinc-400">
        Nothing in this view. Approved payments appear here automatically.
      </div>
    );
  }
  return (
    <div className="mt-6 grid gap-3">
      {rows.map((row) => (
        <FulfillmentCard key={row.id} row={row} />
      ))}
    </div>
  );
}
