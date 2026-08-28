"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import { pointsToDollars } from "@/lib/points-math";

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
  storeCreditRedeemedCents = 0,
  pointsRedeemed = 0,
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
  /** `orders.store_credit_redeemed_cents` — tender, and refundable. */
  storeCreditRedeemedCents?: number;
  /** `orders.points_redeemed` — tender, and refundable. */
  pointsRedeemed?: number;
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
  const [reimbursementMethod, setReimbursementMethod] = useState("zelle");
  const [reimbursementNote, setReimbursementNote] = useState("");
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

  // ---------------------------------------------------------------------
  // STORE CREDIT AND POINTS ARE TENDER, AND THIS PANEL USED TO FORGET IT.
  //
  // `remaining` above is a statement about CASH. The refund route is explicit
  // that it is not the whole question: it computes the same `nonCashTender`
  // from these two columns and deliberately accepts a refund on an order whose
  // amount_paid is zero, because that is the only path by which a customer's
  // store credit ever comes back.
  //
  // Gating the control on `remaining > 0` alone meant an order settled entirely
  // with credit — amount_paid 0 — rendered "Fully reimbursed." in green on its
  // first ever view, with no control anywhere in the admin able to return the
  // credit. The screen reported a closed matter and the customer was out the
  // money.
  //
  // Computed from the same two columns and the same exported points rate the
  // server uses, so the panel cannot offer a refund the route would reject, or
  // hide one it would accept.
  // ---------------------------------------------------------------------
  const nonCashTender = Math.round(
    (Math.max(0, storeCreditRedeemedCents) / 100 + Math.max(0, pointsToDollars(pointsRedeemed))) * 100,
  ) / 100;
  /** The route's own idempotency guard: this order's refund has already run. */
  const alreadyRefunded = String(initialPaymentStatus ?? "").toLowerCase() === "refunded";
  /** Cash is what an amount box can be about. Nothing else. */
  const cashAvailable = remaining > 0;
  const nonCashOutstanding = !alreadyRefunded && nonCashTender > 0;
  const canRecordReimbursement = !alreadyRefunded && (cashAvailable || nonCashTender > 0);

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

    // A CREDIT-ONLY RETURN IS A DIFFERENT ACT AND GETS DIFFERENT WORDS. No cash
    // moved and none is being claimed to have moved; Vanta itself puts the
    // credit and the points back.
    if (!cashAvailable) {
      void runAction(
        "refund",
        `Return ${money(nonCashTender)} of store credit and points to this customer?\n\nThis order collected no cash, so nothing you have paid is being recorded. Vanta puts the credit and points back on the customer's account.`,
        { reimbursementMethod, note: reimbursementNote.trim() || undefined },
      );
      return;
    }

    const confirmLabel = parsedAmount ? money(parsedAmount) : `the remaining ${money(remaining)}`;
    void runAction(
      "refund",
      `Record that you have ALREADY reimbursed this customer ${confirmLabel}?\n\nVANTA WILL NOT SEND ANY MONEY. This records the payment you made yourself and emails the customer to confirm it. Only continue if the money has already left your account.`,
      {
        ...(parsedAmount ? { refundAmount: parsedAmount } : {}),
        reimbursementMethod,
        note: reimbursementNote.trim() || undefined,
      },
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
        <p className="text-xs uppercase tracking-[0.22em] text-zinc-500">Record manual reimbursement</p>
        <p className="mt-1 text-xs text-zinc-500">
          For a return you have already settled: the customer emailed, you authorised the return, the sealed product
          came back, you inspected it, and you have <em>already sent them the money</em>.
        </p>
        <p className="mt-2 text-sm text-zinc-300">
          Paid {money(amountPaid)} • Reimbursed {money(refundAmount)} • Remaining {money(remaining)}
          {nonCashTender > 0 ? (
            <>
              {" "}• Store credit &amp; points {money(nonCashTender)}
            </>
          ) : null}
        </p>
        {/* The most consequential sentence on the page gets the most prominent
            styling on it. Someone skimming must not read "reimbursement",
            click, and believe Vanta paid the customer. */}
        <p className="mt-2 rounded-lg border border-amber-300/40 bg-amber-300/10 px-3 py-2 text-[13px] text-amber-100">
          <strong>Recording this does not send money.</strong> Use it only after you have already reimbursed the
          customer yourself. Vanta records the payment you made and emails the customer to confirm it — nothing here
          moves funds, and the payment processor is not involved.
        </p>
        <p className="mt-2 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-[13px] text-zinc-400">
          Returned stock is <strong>not</strong> added back automatically. If the vial came back sealed and saleable,
          adjust the count yourself in Inventory.
        </p>
        {canRefund ? (
          canRecordReimbursement ? (
            <div className="mt-3 space-y-3">
              {/* CREDIT-ONLY ORDERS GET NO AMOUNT BOX. The route rejects any
                  non-zero amount on an order that collected no cash — recording
                  cash returned that never was would push reported revenue below
                  zero — so offering the field could only produce a 400. */}
              {!cashAvailable ? (
                <p className="rounded-lg border border-sky-300/40 bg-sky-300/10 px-3 py-2 text-[13px] text-sky-100">
                  <strong>This order collected no cash.</strong> It was settled with {money(nonCashTender)} of store
                  credit and points, so there is nothing for you to send. Vanta returns the credit and the points to
                  the customer&apos;s account itself.
                </p>
              ) : null}
              <div className={`grid gap-3 ${cashAvailable ? "sm:grid-cols-3" : "sm:grid-cols-2"}`}>
                {cashAvailable ? (
                  <label className="text-sm text-zinc-300">Amount
                    <input
                      value={refundInput}
                      onChange={(e) => setRefundInput(e.target.value)}
                      placeholder={`Full remaining (${money(remaining)})`}
                      className="vl-input mt-1 w-full px-3 py-2 text-sm"
                    />
                  </label>
                ) : null}
                <label className="text-sm text-zinc-300">How you sent it
                  <select
                    value={reimbursementMethod}
                    onChange={(e) => setReimbursementMethod(e.target.value)}
                    className="vl-input mt-1 w-full px-3 py-2 text-sm"
                  >
                    <option value="zelle">Zelle</option>
                    <option value="cashapp">Cash App</option>
                    <option value="other">Other</option>
                  </select>
                </label>
                <label className="text-sm text-zinc-300">Internal note (optional)
                  <input
                    value={reimbursementNote}
                    onChange={(e) => setReimbursementNote(e.target.value)}
                    placeholder="Seal intact, inspected 24 Aug"
                    className="vl-input mt-1 w-full px-3 py-2 text-sm"
                  />
                </label>
              </div>
              <button type="button" disabled={saving} onClick={handleRefund} className="vl-btn-secondary px-4 py-2 text-xs disabled:opacity-60">
                {saving
                  ? "Recording…"
                  : cashAvailable
                    ? "Record manual reimbursement"
                    : `Return store credit & points (${money(nonCashTender)})`}
              </button>
              {cashAvailable && nonCashOutstanding ? (
                <p className="text-[13px] text-zinc-400">
                  This order also used {money(nonCashTender)} of store credit and points. Refunding the full remaining
                  balance returns those too; a partial refund does not.
                </p>
              ) : null}
            </div>
          ) : (
            <p className="mt-3 text-sm text-emerald-300">Fully reimbursed.</p>
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