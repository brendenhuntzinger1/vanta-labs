"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { AdminOrderRow } from "@/lib/admin-orders";
import { PaymentOutcome } from "@/components/payment-status-badge";

// "Mark Delivered" is gone on purpose. Delivery is what the CARRIER reports —
// order-pipeline.ts permits only the "shippo" source to write `delivered` — and
// a dashboard button that asserts it anyway tells a customer their parcel
// arrived when nothing has scanned it. The Shippo tracking webhook already
// drives delivered automatically, so this button was never needed for the
// normal path; it existed only to paper over a carrier that had not scanned
// yet, which is an exception to investigate, not a routine bulk action.
type BulkAction = "mark_shipped" | "cancel";

const BULK_ACTIONS: Array<{ action: BulkAction; label: string }> = [
  { action: "mark_shipped", label: "Mark Shipped" },
  { action: "cancel", label: "Cancel" },
];

function money(value: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);
}

export function AdminOrdersClient({ orders }: { orders: AdminOrderRow[] }) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  /** Per-order refusals from the last bulk action, with the pipeline's reason. */
  const [refusals, setRefusals] = useState<Array<{ orderId: string; reason?: string }>>([]);

  const toggleOne = (orderId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(orderId)) {
        next.delete(orderId);
      } else {
        next.add(orderId);
      }
      return next;
    });
  };

  const toggleAll = () => {
    setSelected((prev) => (prev.size === orders.length ? new Set() : new Set(orders.map((order) => order.order_id))));
  };

  const runBulkAction = async (action: BulkAction) => {
    if (selected.size === 0) {
      return;
    }

    setBusy(true);
    setMessage(null);
    setRefusals([]);
    try {
      const response = await fetch("/api/admin/orders", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderIds: Array.from(selected), action }),
      });
      // REPORT WHAT THE SERVER DID, NOT WHAT WAS ASKED FOR.
      //
      // This used to read `Updated ${selected.size} orders` — the SELECTION
      // size. Since the pipeline refuses moves that are illegal from an order's
      // current state, a mixed selection genuinely comes back partial: pick 5,
      // 3 move, and the screen still claimed 5. The server has always sent the
      // real numbers; the client was reading back its own input.
      const result = await response.json() as {
        success: boolean;
        error?: string;
        requested?: number;
        updated?: number;
        refused?: Array<{ orderId: string; reason?: string }>;
      };
      if (!result.success) {
        setMessage(result.error ?? "Unable to update selected orders.");
        return;
      }

      const updated = result.updated ?? 0;
      const refused = result.refused ?? [];
      const plural = (n: number) => (n === 1 ? "order" : "orders");

      if (updated === 0) {
        // A complete failure must never wear a success message.
        setMessage(`No orders were updated. ${refused.length} ${plural(refused.length)} could not be changed.`);
      } else if (refused.length > 0) {
        setMessage(`${updated} ${plural(updated)} updated · ${refused.length} could not be updated.`);
      } else {
        setMessage(`${updated} ${plural(updated)} updated.`);
      }
      // The reasons are kept so the operator can see WHY, rather than being
      // told a number and left to guess which orders it referred to.
      setRefusals(refused);

      // Only clear the selection for the orders that actually moved: leaving
      // the refused ones selected is what lets an operator act on them next.
      if (refused.length === 0) {
        setSelected(new Set());
      } else {
        setSelected(new Set(refused.map((r) => r.orderId)));
      }
      router.refresh();
    } catch {
      setMessage("Unable to update selected orders right now.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-6">
      {selected.size > 0 ? (
        <div className="vl-panel-soft mb-4 flex flex-wrap items-center gap-3 rounded-xl p-3 text-sm">
          <span className="text-zinc-300">{selected.size} selected</span>
          {BULK_ACTIONS.map(({ action, label }) => (
            <button
              key={action}
              type="button"
              disabled={busy}
              onClick={() => runBulkAction(action)}
              className="vl-btn-secondary px-3 py-1.5 text-xs disabled:opacity-60"
            >
              {label}
            </button>
          ))}
          {message ? <span className="text-xs text-zinc-400">{message}</span> : null}
        </div>
      ) : message ? (
        <p className="mb-4 text-xs text-zinc-400">{message}</p>
      ) : null}

      {/* WHICH orders were refused, and why. A count on its own tells an
          operator that something did not happen without telling them what to
          do about it — and these are exactly the orders that still need
          attention, so they are named. */}
      {refusals.length > 0 ? (
        <div role="status" className="vl-panel-soft mb-4 rounded-xl p-3">
          <p className="text-xs font-medium text-amber-300">
            {refusals.length} order{refusals.length === 1 ? "" : "s"} could not be updated
          </p>
          <ul className="mt-2 space-y-1">
            {refusals.map((refusal) => (
              <li key={refusal.orderId} className="text-xs text-zinc-400">
                <span className="font-mono text-zinc-300">{refusal.orderId}</span>
                {refusal.reason ? <> — {refusal.reason}</> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="grid gap-3 sm:hidden">
        {orders.map((order) => (
          <article key={order.id} className="vl-panel rounded-xl p-4">
            <div className="flex items-start justify-between gap-2">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={selected.has(order.order_id)}
                  onChange={() => toggleOne(order.order_id)}
                  className="h-4 w-4 rounded border-zinc-700 bg-zinc-900"
                />
                <span className="text-xs uppercase tracking-[0.2em] text-zinc-500">Order</span>
              </label>
            </div>
            <p className="mt-1 text-sm font-semibold text-white break-all">{order.order_number ?? order.order_id}</p>
            <div className="mt-3 space-y-1.5 text-sm text-zinc-300">
              <p><span className="text-zinc-500">Customer:</span> {order.customer_email ?? "Unknown"}</p>
              <p><span className="text-zinc-500">Items:</span> {order.item_count}</p>
              <p><span className="text-zinc-500">Amount:</span> {money(order.amount_paid)}</p>
              <p><span className="text-zinc-500">Sales tax:</span> {order.tax_amount > 0 ? money(order.tax_amount) : "—"}</p>
              <p><span className="text-zinc-500">Referral / Coupon:</span> {order.referral_code ?? order.coupon_code ?? "-"}</p>
              <div className="flex items-start gap-2">
                <span className="text-zinc-500">Payment:</span>
                <PaymentOutcome
                  status={order.payment_status}
                  failureKind={order.payment_failure_kind}
                  failureReason={order.payment_failure_reason}
                  paidRetry={order.paid_retry}
                />
              </div>
              <p><span className="text-zinc-500">Fulfillment:</span> {order.fulfillment_status}</p>
            </div>
            <Link href={`/admin/orders/${order.order_id}`} className="mt-3 inline-flex text-xs text-zinc-200 underline-offset-4 hover:underline">
              Open order
            </Link>
          </article>
        ))}
        {orders.length === 0 ? <p className="py-6 text-center text-sm text-zinc-500">No orders match these filters.</p> : null}
      </div>

      <div className="vl-panel hidden overflow-x-auto rounded-2xl sm:block">
        <table className="min-w-full divide-y divide-zinc-800 text-sm">
          <thead className="bg-zinc-900/80">
            <tr>
              <th className="px-4 py-3 text-left">
                <input
                  type="checkbox"
                  checked={orders.length > 0 && selected.size === orders.length}
                  onChange={toggleAll}
                  className="h-4 w-4 rounded border-zinc-700 bg-zinc-900"
                />
              </th>
              <th className="px-4 py-3 text-left">Order</th>
              <th className="px-4 py-3 text-left">Customer</th>
              <th className="px-4 py-3 text-left">Items</th>
              <th className="px-4 py-3 text-left">Amount</th>
              <th className="px-4 py-3 text-left">Tax</th>
              <th className="px-4 py-3 text-left">Referral / Coupon</th>
              <th className="px-4 py-3 text-left">Payment</th>
              <th className="px-4 py-3 text-left">Fulfillment</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800 bg-zinc-950/70">
            {orders.map((order) => (
              <tr key={order.id}>
                <td className="px-4 py-3">
                  <input
                    type="checkbox"
                    checked={selected.has(order.order_id)}
                    onChange={() => toggleOne(order.order_id)}
                    className="h-4 w-4 rounded border-zinc-700 bg-zinc-900"
                  />
                </td>
                <td className="px-4 py-3"><Link href={`/admin/orders/${order.order_id}`} className="hover:underline">{order.order_number ?? order.order_id}</Link></td>
                <td className="px-4 py-3">{order.customer_email ?? "Unknown"}</td>
                <td className="px-4 py-3">{order.item_count}</td>
                <td className="px-4 py-3">{money(order.amount_paid)}</td>
                <td className="px-4 py-3">{order.tax_amount > 0 ? money(order.tax_amount) : "—"}</td>
                <td className="px-4 py-3">{order.referral_code ?? order.coupon_code ?? "—"}</td>
                <td className="px-4 py-3">
                  <PaymentOutcome
                    status={order.payment_status}
                    failureKind={order.payment_failure_kind}
                    failureReason={order.payment_failure_reason}
                    paidRetry={order.paid_retry}
                  />
                </td>
                <td className="px-4 py-3">{order.fulfillment_status}</td>
              </tr>
            ))}
            {orders.length === 0 ? (
              <tr>
                <td colSpan={9} className="px-4 py-6 text-center text-sm text-zinc-500">No orders match these filters.</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
