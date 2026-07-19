"use client";

import { useState } from "react";

export function AdminOrderActions({
  orderId,
  initialPaymentStatus,
  initialFulfillmentStatus,
  initialTrackingNumber,
}: {
  orderId: string;
  initialPaymentStatus: string;
  initialFulfillmentStatus: string;
  initialTrackingNumber: string | null;
}) {
  const [paymentStatus, setPaymentStatus] = useState(initialPaymentStatus || "pending_payment");
  const [fulfillmentStatus, setFulfillmentStatus] = useState(initialFulfillmentStatus || "pending");
  const [trackingNumber, setTrackingNumber] = useState(initialTrackingNumber ?? "");
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const runAction = async (action: string, promptMessage?: string) => {
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
  };

  return (
    <div className="vl-panel-soft mt-6 rounded-xl p-4">
      <p className="text-xs uppercase tracking-[0.22em] text-zinc-500">Order Actions</p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="text-sm text-zinc-300">Payment status
          <select value={paymentStatus} onChange={(e) => setPaymentStatus(e.target.value)} className="vl-input mt-1 w-full px-3 py-2">
            <option value="pending_payment">Pending Payment</option>
            <option value="paid">Paid</option>
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
        <label className="text-sm text-zinc-300 sm:col-span-2">Tracking number
          <input value={trackingNumber} onChange={(e) => setTrackingNumber(e.target.value)} className="vl-input mt-1 w-full px-3 py-2" placeholder="1Z..." />
        </label>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <button type="button" disabled={saving} onClick={() => runAction("update_status")} className="vl-btn-primary px-4 py-2 text-xs disabled:opacity-60">Save status</button>
        <button type="button" disabled={saving} onClick={() => runAction("refund", "Mark this order as refunded?")} className="vl-btn-secondary px-4 py-2 text-xs disabled:opacity-60">Refund</button>
        <button type="button" disabled={saving} onClick={() => runAction("cancel", "Cancel this order?")} className="vl-btn-secondary px-4 py-2 text-xs disabled:opacity-60">Cancel</button>
        <button type="button" disabled={saving} onClick={() => runAction("resend_confirmation")} className="vl-btn-secondary px-4 py-2 text-xs disabled:opacity-60">Resend confirmation</button>
        <button type="button" disabled={saving} onClick={() => runAction("print_packing_slip")} className="vl-btn-secondary px-4 py-2 text-xs disabled:opacity-60">Print packing slip</button>
      </div>

      {message ? <p className="mt-3 text-sm text-zinc-300">{message}</p> : null}
    </div>
  );
}