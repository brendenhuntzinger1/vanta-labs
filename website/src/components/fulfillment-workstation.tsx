"use client";

import { useCallback, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import type { BucketCount, QueueOrder } from "@/lib/fulfillment-queues";
import type { ExceptionDefinition } from "@/lib/fulfillment-buckets";
import type { FulfillmentBatch, PackingOrder, PickList } from "@/lib/fulfillment-batches";

// ---------------------------------------------------------------------------
// THE WORKSTATION.
//
// Ordered the way the day runs: exceptions, then ready, then the bench. Nothing
// here computes a status — every value shown comes from the server, which
// derives it from the canonical pipeline.
// ---------------------------------------------------------------------------

function Pill({ tone, children }: { tone: "ok" | "warn" | "crit" | "muted"; children: React.ReactNode }) {
  const tones = {
    ok: "bg-emerald-500/10 text-emerald-300 border-emerald-500/20",
    warn: "bg-amber-500/10 text-amber-300 border-amber-500/20",
    crit: "bg-rose-500/10 text-rose-300 border-rose-500/20",
    muted: "bg-white/[0.04] text-zinc-400 border-white/10",
  };
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${tones[tone]}`}>
      {children}
    </span>
  );
}

export function FulfillmentWorkstation({
  counts,
  exceptions,
  exceptionReasons,
  ready,
  inProgress,
  awaitingCarrier,
  cancelledWithLabel,
  openBatches,
}: {
  counts: BucketCount[];
  exceptions: QueueOrder[];
  exceptionReasons: ExceptionDefinition[];
  ready: QueueOrder[];
  inProgress: QueueOrder[];
  awaitingCarrier: QueueOrder[];
  cancelledWithLabel: QueueOrder[];
  openBatches: FulfillmentBatch[];
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [rejections, setRejections] = useState<Array<{ orderId: string; reason: string }>>([]);
  const [pickList, setPickList] = useState<PickList | null>(null);
  const [packing, setPacking] = useState<PackingOrder | null>(null);
  const [activeBatch, setActiveBatch] = useState<string | null>(openBatches[0]?.id ?? null);

  const reasonMap = useMemo(
    () => new Map(exceptionReasons.map((r) => [r.reason, r])),
    [exceptionReasons],
  );

  const toggle = (orderId: string) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(orderId)) next.delete(orderId); else next.add(orderId);
    return next;
  });

  const call = useCallback(async (path: string, init?: RequestInit) => {
    const res = await fetch(path, {
      ...init,
      headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    });
    return res.json() as Promise<Record<string, unknown>>;
  }, []);

  const createBatch = async () => {
    setBusy(true); setMessage(null); setRejections([]);
    try {
      const body = await call("/api/admin/fulfillment/batches", {
        method: "POST",
        body: JSON.stringify({ orderIds: Array.from(selected) }),
      });
      if (!body.success) { setMessage(String(body.error ?? "Could not create the batch.")); return; }

      const added = Number(body.added ?? 0);
      const rejected = (body.rejected ?? []) as Array<{ orderId: string; reason: string }>;
      // Same rule as the bulk actions: report what happened, not what was asked.
      setMessage(rejected.length > 0
        ? `${added} order${added === 1 ? "" : "s"} batched · ${rejected.length} could not be added.`
        : `${added} order${added === 1 ? "" : "s"} batched.`);
      setRejections(rejected);
      const batch = body.batch as { id?: string } | null;
      if (batch?.id) setActiveBatch(batch.id);
      setSelected(new Set(rejected.map((r) => r.orderId)));
      router.refresh();
    } finally { setBusy(false); }
  };

  const loadPickList = async (batchId: string) => {
    setBusy(true);
    try {
      const body = await call(`/api/admin/fulfillment/batches?batchId=${batchId}&view=picklist`);
      setPickList((body.pickList as PickList) ?? null);
      setPacking(null);
    } finally { setBusy(false); }
  };

  const loadNext = async (batchId: string) => {
    setBusy(true);
    try {
      const body = await call(`/api/admin/fulfillment/batches?batchId=${batchId}&view=next`);
      setPacking((body.next as PackingOrder) ?? null);
      setPickList(null);
    } finally { setBusy(false); }
  };

  /** Verify → the order moves to `packed` through the canonical pipeline. */
  const markPacked = async (orderId: string, batchId: string) => {
    setBusy(true); setMessage(null);
    try {
      const body = await call(`/api/admin/orders/${encodeURIComponent(orderId)}`, {
        method: "PATCH",
        body: JSON.stringify({ action: "update_status", fulfillmentStatus: "packed" }),
      });
      if (!body.success) { setMessage(String(body.error ?? "Could not mark it packed.")); return; }
      await loadNext(batchId);
      router.refresh();
    } finally { setBusy(false); }
  };

  return (
    <div className="space-y-8">
      {/* ---- THE BOARD ------------------------------------------------- */}
      <section>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {counts.map((bucket) => (
            <div
              key={bucket.id}
              className={`vl-panel rounded-xl p-4 ${bucket.id === "exceptions" && bucket.count > 0 ? "border-rose-500/30" : ""}`}
            >
              <p className="text-[11px] uppercase tracking-[0.14em] text-zinc-500">{bucket.label}</p>
              <p className={`mt-1 font-mono text-2xl tabular-nums ${bucket.id === "exceptions" && bucket.count > 0 ? "text-rose-300" : "text-white"}`}>
                {bucket.count}
              </p>
              <p className="mt-1 text-xs leading-5 text-zinc-500">{bucket.description}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ---- EXCEPTIONS, ABOVE EVERYTHING ------------------------------ */}
      {exceptions.length > 0 ? (
        <section className="vl-panel rounded-xl border-rose-500/30 p-5">
          <h2 className="text-sm font-semibold text-rose-300">
            {exceptions.length} order{exceptions.length === 1 ? "" : "s"} need attention
          </h2>
          <p className="mt-1 text-xs text-zinc-400">
            These are not in any pick queue. Resolve them before batching.
          </p>
          <ul className="mt-4 space-y-3">
            {exceptions.map((order) => (
              <li key={order.orderId} className="border-t border-white/5 pt-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-xs text-zinc-300">{order.orderNumber ?? order.orderId}</span>
                  <span className="text-xs text-zinc-500">{order.customerName}</span>
                  {order.exceptions.map((reason) => (
                    <Pill key={reason} tone="crit">{reasonMap.get(reason)?.label ?? reason}</Pill>
                  ))}
                </div>
                {order.exceptions.map((reason) => (
                  <p key={reason} className="mt-1 text-xs text-zinc-400">
                    {reasonMap.get(reason)?.action}
                  </p>
                ))}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* ---- CANCELLED WITH A LABEL ------------------------------------ */}
      {cancelledWithLabel.length > 0 ? (
        <section className="vl-panel rounded-xl border-amber-500/30 p-5">
          <h2 className="text-sm font-semibold text-amber-300">
            {cancelledWithLabel.length} cancelled order{cancelledWithLabel.length === 1 ? " has" : "s have"} a purchased label
          </h2>
          {/* The precise, honest claim. Cancelling in Vanta does NOT void or
              refund the Shippo label — this application cannot buy or void
              postage — so saying anything softer here would imply money came
              back that has not. */}
          <p className="mt-1 text-xs text-zinc-400">
            Cancelling the order here did <strong className="text-amber-300">not</strong> void or refund the label.
            If the parcel was never handed over, void it in Shippo&rsquo;s dashboard to recover the postage.
          </p>
          <ul className="mt-3 space-y-1">
            {cancelledWithLabel.map((order) => (
              <li key={order.orderId} className="text-xs text-zinc-400">
                <span className="font-mono text-zinc-300">{order.orderNumber ?? order.orderId}</span>
                {order.trackingNumber ? <> · {order.carrier} {order.trackingNumber}</> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* ---- READY TO FULFILL ------------------------------------------ */}
      <section className="vl-panel rounded-xl p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-white">Ready to Fulfill</h2>
            <p className="mt-1 text-xs text-zinc-500">{ready.length} paid, eligible, unbatched.</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={busy || ready.length === 0}
              onClick={() => setSelected(new Set(ready.map((o) => o.orderId)))}
              className="vl-btn-secondary px-3 py-1.5 text-xs disabled:opacity-50"
            >
              Select all
            </button>
            <button
              type="button"
              disabled={busy || selected.size === 0}
              onClick={createBatch}
              className="vl-btn-primary px-4 py-1.5 text-xs disabled:opacity-50"
            >
              Create batch ({selected.size})
            </button>
          </div>
        </div>

        {message ? <p className="mt-3 text-xs text-zinc-300">{message}</p> : null}
        {rejections.length > 0 ? (
          <div role="status" className="mt-3 rounded-lg border border-amber-500/20 bg-amber-500/[0.04] p-3">
            <p className="text-xs font-medium text-amber-300">Not added to the batch</p>
            <ul className="mt-1 space-y-1">
              {rejections.map((r) => (
                <li key={r.orderId} className="text-xs text-zinc-400">
                  <span className="font-mono text-zinc-300">{r.orderId}</span> — {r.reason}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        <ul className="mt-4 max-h-96 space-y-1 overflow-y-auto">
          {ready.map((order) => (
            <li key={order.orderId}>
              <label className="flex cursor-pointer items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-white/[0.03]">
                <input
                  type="checkbox"
                  checked={selected.has(order.orderId)}
                  onChange={() => toggle(order.orderId)}
                  className="h-4 w-4"
                />
                <span className="font-mono text-xs text-zinc-300">{order.orderNumber ?? order.orderId}</span>
                <span className="text-xs text-zinc-500">{order.customerName}</span>
                <span className="ml-auto text-xs text-zinc-600">{order.destination}</span>
              </label>
            </li>
          ))}
          {ready.length === 0 ? <li className="text-xs text-zinc-500">Nothing waiting. </li> : null}
        </ul>
      </section>

      {/* ---- BATCHES: PICK AND PACK ------------------------------------ */}
      {openBatches.length > 0 ? (
        <section className="vl-panel rounded-xl p-5">
          <h2 className="text-sm font-semibold text-white">Open batches</h2>
          <ul className="mt-3 space-y-2">
            {openBatches.map((batch) => (
              <li key={batch.id} className="flex flex-wrap items-center gap-3 border-t border-white/5 pt-2">
                <span className="font-mono text-xs text-zinc-300">{batch.label}</span>
                <Pill tone="muted">{batch.orderCount} orders</Pill>
                <button type="button" disabled={busy} onClick={() => loadPickList(batch.id)}
                  className="vl-btn-secondary px-3 py-1 text-xs disabled:opacity-50">
                  Pick list
                </button>
                <button type="button" disabled={busy} onClick={() => { setActiveBatch(batch.id); loadNext(batch.id); }}
                  className="vl-btn-primary px-3 py-1 text-xs disabled:opacity-50">
                  Start packing
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* ---- CONSOLIDATED PICK LIST ------------------------------------ */}
      {pickList ? (
        <section className="vl-panel rounded-xl p-5">
          <h2 className="text-sm font-semibold text-white">
            Pick list — {pickList.batchLabel}
          </h2>
          <p className="mt-1 text-xs text-zinc-500">
            {pickList.totalUnits} units across {pickList.lines.length} products, for {pickList.orderCount} orders.
            One walk per product.
          </p>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/10 text-left text-[11px] uppercase tracking-wider text-zinc-500">
                  <th className="pb-2">Product</th>
                  <th className="pb-2 text-right">Units</th>
                  <th className="pb-2 text-right">Orders</th>
                </tr>
              </thead>
              <tbody>
                {pickList.lines.map((line) => (
                  <tr key={line.productId} className="border-b border-white/5">
                    <td className="py-2">
                      <span className="text-zinc-200">{line.productName}</span>
                      <span className="ml-2 font-mono text-[10px] text-zinc-600">{line.productId}</span>
                    </td>
                    <td className="py-2 text-right font-mono text-lg tabular-nums text-white">{line.quantity}</td>
                    <td className="py-2 text-right font-mono text-xs tabular-nums text-zinc-500">{line.orderCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {/* ---- PACKING BENCH — APPROACH B -------------------------------- */}
      {packing && activeBatch ? (
        <section className="vl-panel rounded-xl p-5">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-sm font-semibold text-white">
              Packing {packing.position} of {packing.ofTotal}
            </h2>
            <span className="font-mono text-lg text-white">{packing.orderNumber ?? packing.orderId}</span>
          </div>
          <p className="mt-1 text-xs text-zinc-500">{packing.customerName} · {packing.destination}</p>

          <ul className="mt-4 space-y-2">
            {packing.items.map((item) => (
              <li key={item.productId} className="flex items-center gap-3 rounded-lg bg-white/[0.03] px-3 py-2">
                <span className="font-mono text-xl tabular-nums text-white">{item.quantity}×</span>
                <span className="text-sm text-zinc-200">{item.productName}</span>
                <span className="ml-auto font-mono text-[10px] text-zinc-600">{item.productId}</span>
              </li>
            ))}
          </ul>

          {/* APPROACH B, stated in the order the hands move: verify what is in
              the box, then get THIS order's label, then apply it, then next.
              Never a stack of labels waiting to be matched to parcels. */}
          <div className="mt-5 flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => markPacked(packing.orderId, activeBatch)}
              className="vl-btn-primary px-4 py-2 text-xs disabled:opacity-50"
            >
              Verified — mark packed
            </button>
            {packing.hasLabel && packing.labelUrl ? (
              <a
                href={`/api/admin/orders/${encodeURIComponent(packing.orderId)}/shipping/label/print`}
                target="_blank"
                rel="noreferrer"
                className="vl-btn-secondary px-4 py-2 text-xs"
              >
                Print this order&rsquo;s label
              </a>
            ) : (
              <span className="text-xs text-zinc-500">
                Buy this order&rsquo;s label in Shippo, then apply it before moving on.
              </span>
            )}
            <button
              type="button"
              disabled={busy}
              onClick={() => loadNext(activeBatch)}
              className="vl-btn-secondary px-4 py-2 text-xs disabled:opacity-50"
            >
              Skip to next
            </button>
          </div>
        </section>
      ) : null}

      {/* ---- IN FLIGHT, for reference ---------------------------------- */}
      <section className="grid gap-4 lg:grid-cols-2">
        {[["In Progress", inProgress], ["Awaiting Carrier", awaitingCarrier]].map(([title, orders]) => (
          <div key={String(title)} className="vl-panel rounded-xl p-5">
            <h2 className="text-sm font-semibold text-white">{title as string}</h2>
            <ul className="mt-3 space-y-1">
              {(orders as QueueOrder[]).slice(0, 15).map((order) => (
                <li key={order.orderId} className="flex items-center gap-2 text-xs">
                  <span className="font-mono text-zinc-300">{order.orderNumber ?? order.orderId}</span>
                  <span className="text-zinc-500">{order.fulfillmentLabel}</span>
                  {order.trackingNumber ? <span className="ml-auto font-mono text-zinc-600">{order.trackingNumber}</span> : null}
                </li>
              ))}
              {(orders as QueueOrder[]).length === 0 ? <li className="text-xs text-zinc-500">Empty.</li> : null}
            </ul>
          </div>
        ))}
      </section>
    </div>
  );
}
