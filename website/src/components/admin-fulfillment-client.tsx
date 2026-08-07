"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { FulfillmentRow } from "@/lib/admin-fulfillment";
import { methodLabel } from "@/components/admin-payments-client";
import { FulfillmentStatusPill } from "@/components/fulfillment-status-pill";
import { fulfillmentStatusLabel, normalizeLegacyStatus } from "@/lib/order-pipeline";

// ---------------------------------------------------------------------------
// The pack-and-ship queue.
//
// This is the list; the work happens one order at a time in the workstation
// (/admin/orders/<id>), which is where rates, labels and postage live. So the
// primary control on every card is "Open workstation" — the manual carrier +
// tracking form below it stays for the orders that ship WITHOUT a Shippo label
// (a courier drop-off, a hand-delivered local order), which would otherwise
// have no way to record tracking at all.
//
// Statuses are rendered through the order pipeline's own vocabulary rather than
// a private map, so the twelve current statuses AND the legacy values still in
// the database ('awaiting_fulfillment', 'processing', 'fulfilled', …) all read
// as the same words the rest of the admin uses.
//
// Everything is one column below `sm`: the owner works this queue on a phone,
// standing at the packing bench.
// ---------------------------------------------------------------------------

function formatDate(value: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
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
          /* Clipboard is unavailable over plain HTTP and in some in-app browsers. */
        }
      }}
      className="vl-focus-ring inline-flex min-h-[44px] shrink-0 items-center gap-1 rounded-xl border border-white/20 bg-white/[0.05] px-3 text-xs font-semibold text-white transition hover:border-white/50"
    >
      {copied ? "✓ Copied" : label}
    </button>
  );
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

  const normalized = normalizeLegacyStatus(row.fulfillment_status);
  // A parcel that has left is past the point where this queue's manual controls
  // help; the carrier's own scans move it from here.
  const alreadyGone =
    normalized === "in_transit"
    || normalized === "out_for_delivery"
    || normalized === "delivered"
    || normalized === "returned"
    || normalized === "cancelled"
    || normalized === "refunded";

  return (
    <div className="overflow-hidden rounded-xl border border-white/10 bg-white/[0.02] p-4 sm:p-5">
      {/* Order number is the single most prominent element when packing. */}
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-white/10 pb-4">
        <div className="min-w-0">
          <p className="text-[11px] uppercase tracking-[0.18em] text-zinc-500">Order Number</p>
          <p className="break-all font-mono text-2xl font-bold leading-tight text-white sm:text-4xl">{row.order_number}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <CopyButton value={row.order_number} label="Copy Order #" />
          <FulfillmentStatusPill status={row.fulfillment_status} />
        </div>
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <div className="min-w-0">
          <p className="text-[11px] uppercase tracking-[0.12em] text-zinc-500">Ship To</p>
          <div className="mt-1 flex items-start justify-between gap-2">
            <p className="min-w-0 whitespace-pre-line break-words text-sm text-zinc-200">{fullAddress || "—"}</p>
            {fullAddress ? <CopyButton value={fullAddress} label="Copy" /> : null}
          </div>
          <p className="mt-2 break-all text-xs text-zinc-400">{row.customer_email}</p>
          <p className="mt-1 text-xs text-zinc-500">Shipping: {row.shipping_method}</p>
        </div>

        <div className="min-w-0">
          <p className="text-[11px] uppercase tracking-[0.12em] text-zinc-500">Items</p>
          <ul className="mt-1 space-y-0.5 text-sm text-zinc-200">
            {row.items.length > 0 ? (
              row.items.map((item, index) => (
                <li key={index} className="break-words">{item.name} <span className="text-zinc-500">× {item.quantity}</span></li>
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
          {row.tracking_number ? (
            <p className="mt-2 break-all text-xs text-zinc-400">
              Tracking: <span className="font-mono text-zinc-300">{row.tracking_number}</span>
            </p>
          ) : null}
        </div>
      </div>

      {/* The daily path: everything that costs money or prints a label lives in
          the workstation, one order at a time. */}
      <div className="mt-4 border-t border-white/10 pt-4">
        <Link
          href={`/admin/orders/${row.order_id}`}
          className="vl-btn-primary w-full px-5 text-sm sm:w-auto"
        >
          Open workstation
        </Link>
        <p className="mt-2 text-[11px] text-zinc-500">
          Weigh the parcel, buy the Shippo label and print it there. {fulfillmentStatusLabel(row.fulfillment_status)}.
        </p>
      </div>

      {/* Kept for parcels that ship without a Shippo label. Collapsed, because
          it is the exception now and a phone screen has no room for both. */}
      <details className="mt-3 border-t border-white/10 pt-3">
        <summary className="vl-focus-ring cursor-pointer list-none py-1.5 text-[11px] uppercase tracking-[0.14em] text-zinc-500 hover:text-zinc-300">
          Record tracking manually (no Shippo label)
        </summary>

        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <label className="text-xs text-zinc-400">Carrier
            <input value={carrier} onChange={(e) => setCarrier(e.target.value)} placeholder="UPS, FedEx, USPS…" className="vl-input mt-1 w-full px-3 py-2.5 text-sm" />
          </label>
          <label className="text-xs text-zinc-400">Tracking number
            <input value={tracking} onChange={(e) => setTracking(e.target.value)} placeholder="1Z…" className="vl-input mt-1 w-full px-3 py-2.5 text-sm" />
          </label>
        </div>

        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
          <button
            type="button"
            disabled={busy || alreadyGone}
            onClick={() => save("shipped")}
            className="vl-btn-secondary w-full px-5 text-sm disabled:opacity-40 sm:w-auto"
          >
            {busy ? "Saving…" : "Mark Shipped"}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => save("delivered")}
            className="vl-btn-secondary w-full px-5 text-sm disabled:opacity-40 sm:w-auto"
          >
            Mark Delivered
          </button>
        </div>
        <p className="mt-2 text-[11px] text-zinc-500">
          An order shipped on a Shippo label updates itself from the carrier&rsquo;s scans — in transit, out for
          delivery and delivered all arrive on the tracking webhook. Only use these for a parcel Shippo never saw.
        </p>
        {message ? <p className="mt-2 text-xs text-zinc-300">{message}</p> : null}
      </details>
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
