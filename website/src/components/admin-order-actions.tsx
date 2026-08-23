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
  orderItems = [],
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
  orderItems?: Array<{ id: string; name: string; quantity: number }>;
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
  // Replacement panel state: which items (and how many of each) to reship.
  const [replaceOpen, setReplaceOpen] = useState(false);
  /**
   * One id per opening of the replacement dialog.
   *
   * A double-click, a retried fetch or a second submit reuses this id, so the
   * server resolves them all to the SAME replacement. Closing and reopening the
   * dialog mints a new one, so two deliberate replacements still work.
   */
  const [replaceRequestId, setReplaceRequestId] = useState(() => crypto.randomUUID());
  const [replaceReason, setReplaceReason] = useState("damaged");
  const [replaceNote, setReplaceNote] = useState("");
  const [replaceQty, setReplaceQty] = useState<Record<string, number>>(
    () => Object.fromEntries(orderItems.map((item) => [item.id, item.quantity])),
  );

  const remaining = Math.max(0, amountPaid - refundAmount);

  const runAction = async (action: string, promptMessage?: string, extra?: Record<string, unknown>) => {
    if (promptMessage && !window.confirm(promptMessage)) {
      return;
    }

    setSaving(true);
    setMessage(null);

    // Only send paymentStatus when the admin actually CHANGED it. Sending the
    // unchanged current status (e.g. "paid") makes the server reject a plain
    // fulfillment/tracking save (money-state statuses must go through the
    // verification/refund flows) and 403s staff who can't manage payments — so
    // shipping an order and emailing tracking became impossible. Omitting the
    // unchanged value lets fulfillment saves through while the guard still
    // catches a genuine attempt to flip payment status here.
    const payload: Record<string, unknown> = {
      action,
      fulfillmentStatus,
      trackingNumber,
      ...extra,
    };
    if (paymentStatus !== (initialPaymentStatus || "pending_payment")) {
      payload.paymentStatus = paymentStatus;
    }

    const res = await fetch(`/api/admin/orders/${orderId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const json = await res.json() as { success: boolean; error?: string; replacementOrderNumber?: string };
    if (!res.ok || !json.success) {
      setMessage(json.error ?? "Action failed");
      setSaving(false);
      return;
    }

    if (action === "send_replacement") {
      setMessage(`Replacement ${json.replacementOrderNumber ?? ""} created — it's in the fulfillment queue and the customer has been emailed.`.trim());
      setReplaceOpen(false);
      setSaving(false);
      router.refresh();
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
      `Record a refund of ${confirmLabel} for this order?\n\nNO MONEY WILL BE SENT. This updates Vanta's records only — you must issue the actual refund in your payment processor.`,
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
            {/* Every value the system actually writes must be listed. A select
                whose current value is absent from its options silently displays
                the FIRST option instead, so an order sitting in
                "awaiting_fulfillment" or "label_purchased" showed as "Pending"
                — and saving anything else on the form then wrote that
                regression back, re-running the status-change side effects. */}
            <option value="pending">Pending</option>
            <option value="awaiting_fulfillment">Awaiting fulfillment</option>
            <option value="ready_to_fulfill">Ready to fulfill</option>
            <option value="processing">Processing</option>
            <option value="label_purchased">Label purchased</option>
            <option value="shipped">Shipped</option>
            {/* Present so an already-delivered order displays correctly, but
                DISABLED: only the "shippo" source may write `delivered`, so
                choosing it here could only ever produce a 400. */}
            <option value="delivered" disabled>Delivered (carrier-reported only)</option>
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
        <p className="text-xs uppercase tracking-[0.22em] text-zinc-500">Record a refund</p>
        <p className="mt-1 text-xs text-zinc-500">
          Replacements are the standard remedy. Use this only when a refund is unavoidable — a dispute, or a
          customer who will not accept a reship.
        </p>
        <p className="mt-2 text-sm text-zinc-300">
          Paid {money(amountPaid)} • Refunded {money(refundAmount)} • Remaining refundable {money(remaining)}
        </p>
        {/* This was grey 12px helper text -- the least prominent styling on the
            page, carrying the most consequential fact on it. Someone skimming
            reads "Refund", clicks, and believes the customer has their money. */}
        <p className="mt-2 rounded-lg border border-amber-300/40 bg-amber-300/10 px-3 py-2 text-[13px] text-amber-100">
          <strong>This does not send money.</strong> There is no refund integration with the payment processor, so this
          only records the refund in Vanta. Issue the actual refund in your processor, then tell the customer — they are
          not emailed by this action.
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

      {/* Replacement shipment — the Shipping Protection promise. Creates a
          linked $0 order, queues it for shipping, and emails the customer. */}
      {canRefund && orderItems.length > 0 ? (
        <div className="mt-6 border-t border-white/10 pt-4">
          <p className="text-xs uppercase tracking-[0.22em] text-zinc-500">Replacement</p>
          <p className="mt-2 text-sm text-zinc-300">
            The store&apos;s standard remedy. Item damaged, lost, stolen, or wrong? Send a free replacement — the customer is never charged, the
            reship goes straight to fulfillment, and the claim is logged.
          </p>
          {!replaceOpen ? (
            <button type="button" onClick={() => setReplaceOpen(true)} className="vl-btn-secondary mt-3 px-4 py-2 text-xs">
              Send replacement…
            </button>
          ) : (
            <div className="mt-3 space-y-3 rounded-xl border border-white/10 bg-white/[0.02] p-4">
              <div className="space-y-2">
                {orderItems.map((item) => {
                  const qty = replaceQty[item.id] ?? 0;
                  const included = qty > 0;
                  return (
                    <div key={item.id} className="flex items-center justify-between gap-3 text-sm">
                      <label className="flex min-w-0 items-center gap-2 text-zinc-200">
                        <input
                          type="checkbox"
                          checked={included}
                          onChange={(e) => setReplaceQty((prev) => ({ ...prev, [item.id]: e.target.checked ? item.quantity : 0 }))}
                          className="h-4 w-4 accent-amber-300"
                        />
                        <span className="truncate">{item.name}</span>
                      </label>
                      {included ? (
                        <input
                          type="number"
                          min={1}
                          max={item.quantity}
                          value={qty}
                          onChange={(e) => setReplaceQty((prev) => ({ ...prev, [item.id]: Math.min(item.quantity, Math.max(1, Math.floor(Number(e.target.value) || 1))) }))}
                          className="vl-input w-16 px-2 py-1 text-center text-sm"
                          aria-label={`Replacement quantity for ${item.name}`}
                        />
                      ) : (
                        <span className="text-xs text-zinc-600">excluded</span>
                      )}
                    </div>
                  );
                })}
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="text-sm text-zinc-300">Reason
                  <select value={replaceReason} onChange={(e) => setReplaceReason(e.target.value)} className="vl-input mt-1 w-full px-3 py-2">
                    <option value="damaged">Damaged in transit</option>
                    <option value="lost">Lost in transit</option>
                    <option value="stolen">Stolen</option>
                    <option value="other">Other</option>
                  </select>
                </label>
                <label className="text-sm text-zinc-300">Note (optional)
                  <input value={replaceNote} onChange={(e) => setReplaceNote(e.target.value)} placeholder="Photo received, vial cracked" className="vl-input mt-1 w-full px-3 py-2" />
                </label>
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={saving || Object.values(replaceQty).every((q) => !q)}
                  onClick={() => {
                    const items = orderItems
                      .filter((item) => (replaceQty[item.id] ?? 0) > 0)
                      .map((item) => ({ itemId: item.id, quantity: replaceQty[item.id] }));
                    void runAction(
                      "send_replacement",
                      "Send a free replacement shipment for the selected items? The customer will be emailed and the reship goes to fulfillment.",
                      { reason: replaceReason, note: replaceNote.trim() || undefined, items, requestId: replaceRequestId },
                    );
                  }}
                  className="vl-btn-primary px-4 py-2 text-xs disabled:opacity-60"
                >
                  {saving ? "Sending…" : "Send free replacement"}
                </button>
                <button type="button" onClick={() => setReplaceOpen(false)} className="vl-btn-secondary px-4 py-2 text-xs">Cancel</button>
              </div>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}