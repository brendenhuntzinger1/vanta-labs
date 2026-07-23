"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

function money(value: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);
}

export function AdminOrderActions({
  orderId,
  initialPaymentStatus,
  initialFulfillmentStatus,
  initialTrackingNumber,
  amountPaid,
  refundAmount,
  canRefund,
  initialCarrier,
  initialEstimatedDelivery,
}: {
  orderId: string;
  initialPaymentStatus: string;
  initialFulfillmentStatus: string;
  initialTrackingNumber: string | null;
  amountPaid: number;
  refundAmount: number;
  canRefund: boolean;
  initialCarrier?: string | null;
  initialEstimatedDelivery?: string | null;
}) {
  const router = useRouter();
  const [paymentStatus, setPaymentStatus] = useState(initialPaymentStatus || "pending_payment");
  const [fulfillmentStatus, setFulfillmentStatus] = useState(initialFulfillmentStatus || "pending");
  const [trackingNumber, setTrackingNumber] = useState(initialTrackingNumber ?? "");
  const [carrier, setCarrier] = useState(initialCarrier ?? "");
  const [estimatedDelivery, setEstimatedDelivery] = useState(initialEstimatedDelivery ? initialEstimatedDelivery.slice(0, 10) : "");
  const [refundInput, setRefundInput] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const remaining = Math.max(0, amountPaid - refundAmount);

  const runAction = async (action: string, promptMessage?: string, extra?: Record<string, unknown>) => {
    if (promptMessage && !window.confirm(promptMessage)) {
      return;
    }

    setSaving(true);
    setMessage(null);

    const res = await fetch(`/api/admin/orders/${orderId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action,
        paymentStatus,
        fulfillmentStatus,
        trackingNumber,
        ...extra,
      }),
    });

    const json = await res.json() as { success: boolean; error?: string };
    if (!res.ok || !json.success) {
      setMessage(json.error ?? "Action failed");
      setSaving(false);
      return;
    }

    setMessage("Order updated.");
    setSaving(false);
    router.refresh();
  };

  const handleRefund = () => {
    const trimmed = refundInput.trim();
    const parsedAmount = trimmed ? Number(trimmed) : undefined;

    if (trimmed && (!Number.isFinite(parsedAmount) || (parsedAmount as number) <= 0)) {
      setMessage("Enter a valid refund amount, or leave blank to refund the remaining balance.");
      return;
    }

    const confirmLabel = parsedAmount ? money(parsedAmount) : `the remaining ${money(remaining)}`;
    void runAction(
      "refund",
      `Refund ${confirmLabel} for this order? This updates the store's records immediately; a live payment processor must be connected for money to actually move.`,
      parsedAmount ? { refundAmount: parsedAmount } : {},
    );
  };

  return (
    <div className="vl-panel-soft mt-6 rounded-xl p-4">
      <p className="text-xs uppercase tracking-[0.22em] text-zinc-500">Order Actions</p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="text-sm text-zinc-300">Payment status
          <select value={paymentStatus} onChange={(e) => setPaymentStatus(e.target.value)} className="vl-input mt-1 w-full px-3 py-2">
            <option value="pending_payment">Pending Payment</option>
            <option value="paid">Paid</option>
            <option value="partially_refunded">Partially Refunded</option>
            <option value="refunded">Refunded</option>
            <option value="failed">Failed</option>
          </select>
        </label>
        <label className="text-sm text-zinc-300">Fulfillment status
          <select value={fulfillmentStatus} onChange={(e) => setFulfillmentStatus(e.target.value)} className="vl-input mt-1 w-full px-3 py-2">
            <option value="pending">Pending</option>
            <option value="processing">Processing</option>
            <option value="shipped">Shipped</option>
            <option value="delivered">Delivered</option>
            <option value="cancelled">Cancelled</option>
          </select>
        </label>
        <label className="text-sm text-zinc-300">Carrier
          <input value={carrier} onChange={(e) => setCarrier(e.target.value)} className="vl-input mt-1 w-full px-3 py-2" placeholder="UPS, FedEx, USPS…" />
        </label>
        <label className="text-sm text-zinc-300">Tracking number
          <input value={trackingNumber} onChange={(e) => setTrackingNumber(e.target.value)} className="vl-input mt-1 w-full px-3 py-2" placeholder="1Z..." />
        </label>
        <label className="text-sm text-zinc-300 sm:col-span-2">Estimated delivery
          <input type="date" value={estimatedDelivery} onChange={(e) => setEstimatedDelivery(e.target.value)} className="vl-input mt-1 w-full px-3 py-2" />
        </label>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <button type="button" disabled={saving} onClick={() => runAction("update_status", undefined, { carrier, estimatedDelivery: estimatedDelivery || undefined })} className="vl-btn-primary px-4 py-2 text-xs disabled:opacity-60">Save status</button>
        <button type="button" disabled={saving} onClick={() => runAction("cancel", "Cancel this order?")} className="vl-btn-secondary px-4 py-2 text-xs disabled:opacity-60">Cancel</button>
        <button type="button" disabled={saving} onClick={() => runAction("resend_confirmation")} className="vl-btn-secondary px-4 py-2 text-xs disabled:opacity-60">Resend confirmation</button>
        <button type="button" onClick={() => window.open(`/api/admin/orders/${orderId}/packing-slip`, "_blank", "noopener,noreferrer")} className="vl-btn-secondary px-4 py-2 text-xs">Print packing slip</button>
      </div>

      {message ? <p className="mt-3 text-sm text-zinc-300">{message}</p> : null}

      <div className="mt-6 border-t border-white/10 pt-4">
        <p className="text-xs uppercase tracking-[0.22em] text-zinc-500">Refund</p>
        <p className="mt-2 text-sm text-zinc-300">
          Paid {money(amountPaid)} • Refunded {money(refundAmount)} • Remaining refundable {money(remaining)}
        </p>
        <p className="mt-1 text-xs text-zinc-500">
          Updates this order&apos;s records immediately. No real payment processor is connected yet, so no money actually
          moves until one is — issue the refund through your processor directly as well.
        </p>
        {canRefund ? (
          remaining > 0 ? (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <input
                value={refundInput}
                onChange={(e) => setRefundInput(e.target.value)}
                placeholder={`Full remaining (${money(remaining)})`}
                className="vl-input w-48 px-3 py-2 text-sm"
              />
              <button type="button" disabled={saving} onClick={handleRefund} className="vl-btn-secondary px-4 py-2 text-xs disabled:opacity-60">
                Issue refund
              </button>
            </div>
          ) : (
            <p className="mt-3 text-sm text-emerald-300">Fully refunded.</p>
          )
        ) : (
          <p className="mt-3 text-sm text-zinc-500">Your role does not have permission to issue refunds.</p>
        )}
      </div>
    </div>
  );
}