"use client";

import Link from "next/link";

import { useCallback, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import type { BucketCount, QueueOrder } from "@/lib/fulfillment-queues";
import type { BucketId } from "@/lib/fulfillment-buckets";
import type { ExceptionDefinition } from "@/lib/fulfillment-buckets";
import type { FulfillmentBatch, PackingOrder, PickList } from "@/lib/fulfillment-batches";
import type { BatchPurchaseResult, LabelReview } from "@/lib/fulfillment-labels";

// ---------------------------------------------------------------------------
// THE WORKSTATION.
//
// One page for the whole fulfilment day, ordered the way the day runs:
// exceptions, ready, pick, labels, pack.
//
// TWO RULES GOVERN THIS FILE.
//
//   1. Nothing here computes a status. Every value shown comes from the server,
//      which derives it from the canonical pipeline.
//   2. NOTHING THAT RENDERS CAN SPEND MONEY. Reviewing labels is a GET and is
//      safe to run on load, on refresh, in a second tab. Buying is a POST that
//      happens only after the operator has seen the total and confirmed it.
// ---------------------------------------------------------------------------

/** Orders per purchase request. Keeps each POST short and gives live progress. */
const PURCHASE_CHUNK = 10;

function money(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return "—";
  return `$${(cents / 100).toFixed(2)}`;
}

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

/**
 * THE OWNER'S MENTAL MODEL — four words, not nineteen statuses.
 *
 * The detailed buckets still exist, are still derived from the canonical
 * pipeline, and are still shown below. This is a reading of them, not a
 * replacement: nothing is hidden and no state was removed.
 */
const HEADLINE: Array<{ id: string; label: string; from: BucketId[]; hint: string }> = [
  { id: "ready", label: "Ready", from: ["ready"], hint: "Can be fulfilled now." },
  { id: "packing", label: "Packing", from: ["in_progress"], hint: "Being worked on." },
  {
    id: "shipped",
    label: "Shipped",
    from: ["awaiting_carrier", "in_transit", "out_for_delivery", "delivered"],
    hint: "No action needed — the carrier moves these.",
  },
  { id: "exceptions", label: "Needs Attention", from: ["exceptions"], hint: "You need to do something." },
];

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
  const [review, setReview] = useState<LabelReview | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [purchaseResult, setPurchaseResult] = useState<BatchPurchaseResult | null>(null);

  const reasonMap = useMemo(
    () => new Map(exceptionReasons.map((r) => [r.reason, r])),
    [exceptionReasons],
  );

  const headline = useMemo(() => {
    const byId = new Map(counts.map((c) => [c.id, c.count]));
    return HEADLINE.map((h) => ({
      ...h,
      count: h.from.reduce((sum, id) => sum + (byId.get(id) ?? 0), 0),
    }));
  }, [counts]);

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
    setBusy(true); setMessage(null); setRejections([]); setReview(null); setPurchaseResult(null);
    try {
      const body = await call("/api/admin/fulfillment/batches", {
        method: "POST",
        body: JSON.stringify({ orderIds: Array.from(selected) }),
      });
      if (!body.success) { setMessage(String(body.error ?? "Could not create the batch.")); return; }

      const added = Number(body.added ?? 0);
      const rejected = (body.rejected ?? []) as Array<{ orderId: string; reason: string }>;
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
      setPacking(null); setReview(null);
    } finally { setBusy(false); }
  };

  const loadNext = async (batchId: string) => {
    setBusy(true);
    try {
      const body = await call(`/api/admin/fulfillment/batches?batchId=${batchId}&view=next`);
      setPacking((body.next as PackingOrder) ?? null);
      setPickList(null); setReview(null);
    } finally { setBusy(false); }
  };

  /** Quote everything. A GET — SPENDS NOTHING. */
  const loadReview = async (batchId: string) => {
    setBusy(true); setMessage(null); setPurchaseResult(null); setConfirming(false);
    try {
      const body = await call(`/api/admin/fulfillment/labels?batchId=${batchId}`);
      if (!body.success) { setMessage(String(body.error ?? "Could not review labels.")); return; }
      setReview((body.review as LabelReview) ?? null);
      setPickList(null); setPacking(null);
      setActiveBatch(batchId);
    } finally { setBusy(false); }
  };

  /**
   * BUY. Reached only from the confirmation panel, and only for the orders the
   * review marked ready — never the whole batch, and never a line the operator
   * did not see priced.
   */
  const purchaseLabels = async () => {
    if (!review || !activeBatch) return;
    // Carry the reviewed rate with each order so the purchase buys the rate
    // that was priced on screen, not a fresh quote taken seconds later.
    const targets = review.lines
      .filter((l) => l.readiness === "ready")
      .map((l) => ({ orderId: l.orderId, rateId: l.rateId }));
    if (targets.length === 0) return;

    setBusy(true); setConfirming(false); setMessage(null);
    setProgress({ done: 0, total: targets.length });

    const merged: BatchPurchaseResult = {
      purchased: 0, alreadyHadOne: 0, failed: 0, needsVerification: 0, spentCents: 0, lines: [],
    };

    try {
      // Chunked so no single request runs long and the operator sees progress.
      // Sequential: a failure in one chunk must not race ahead into the next.
      for (let i = 0; i < targets.length; i += PURCHASE_CHUNK) {
        const chunk = targets.slice(i, i + PURCHASE_CHUNK);
        const body = await call("/api/admin/fulfillment/labels", {
          method: "POST",
          body: JSON.stringify({ batchId: activeBatch, orderIds: chunk, confirmSpend: true }),
        });
        if (!body.success) {
          setMessage(String(body.error ?? "The purchase stopped. Review before trying again."));
          break;
        }
        const result = body.result as BatchPurchaseResult;
        merged.purchased += result.purchased;
        merged.alreadyHadOne += result.alreadyHadOne;
        merged.failed += result.failed;
        merged.needsVerification += result.needsVerification;
        merged.spentCents += result.spentCents;
        merged.lines.push(...result.lines);
        setProgress({ done: Math.min(i + PURCHASE_CHUNK, targets.length), total: targets.length });
      }
      setPurchaseResult(merged);
      // Re-quote so the panel reflects what is now bought.
      const refreshed = await call(`/api/admin/fulfillment/labels?batchId=${activeBatch}`);
      if (refreshed.success) setReview((refreshed.review as LabelReview) ?? null);
      router.refresh();
    } finally { setBusy(false); setProgress(null); }
  };

  /**
   * Verified → the order moves to `packed` through the canonical pipeline, and
   * the bench advances on its own. ONE action, because the label was printed
   * with the batch — see the note in the packing panel.
   */
  const verifyAndAdvance = async (orderId: string, batchId: string) => {
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

  /** Safe recovery actions on an exception. None of them spends money. */
  const resync = async (orderId: string) => {
    setBusy(true); setMessage(null);
    try {
      const body = await call(`/api/admin/orders/${encodeURIComponent(orderId)}/shipping/sync`, { method: "POST" });
      setMessage(body.success ? "Re-synced with Shippo." : String(body.error ?? "Re-sync failed."));
      router.refresh();
    } finally { setBusy(false); }
  };

  return (
    <div className="space-y-8">
      {/* ---- THE FOUR WORDS ------------------------------------------- */}
      <section className="vl-no-print">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {headline.map((h) => (
            <div
              key={h.id}
              className={`vl-panel rounded-xl p-4 ${h.id === "exceptions" && h.count > 0 ? "border-rose-500/30" : ""}`}
            >
              <p className="text-[11px] uppercase tracking-[0.14em] text-zinc-500">{h.label}</p>
              <p className={`mt-1 font-mono text-3xl tabular-nums ${h.id === "exceptions" && h.count > 0 ? "text-rose-300" : "text-white"}`}>
                {h.count}
              </p>
              <p className="mt-1 text-xs leading-5 text-zinc-500">{h.hint}</p>
            </div>
          ))}
        </div>
        {/* The detailed pipeline, kept visible. Nothing was removed — this is
            the same data the four cards above summarise. */}
        <details className="mt-3">
          <summary className="cursor-pointer text-xs text-zinc-500 hover:text-zinc-300">
            Detailed pipeline
          </summary>
          <div className="mt-3 grid gap-2 sm:grid-cols-3 lg:grid-cols-4">
            {counts.map((bucket) => (
              <div key={bucket.id} className="rounded-lg border border-white/5 px-3 py-2">
                <p className="text-[10px] uppercase tracking-wider text-zinc-600">{bucket.label}</p>
                <p className="font-mono text-sm tabular-nums text-zinc-300">{bucket.count}</p>
              </div>
            ))}
          </div>
        </details>
      </section>

      {/* ---- EXCEPTIONS, ABOVE EVERYTHING, NOW ACTIONABLE -------------- */}
      {exceptions.length > 0 ? (
        <section className="vl-panel vl-no-print rounded-xl border-rose-500/30 p-5">
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
                  {/* A LINK, NOT A LABEL.
                      Every reason here ends in something the operator has to
                      DO, and the order was printed as plain text — so the
                      instruction "decide between reship and refund" arrived
                      with no way to open the order and decide. */}
                  <Link
                    href={`/admin/orders/${encodeURIComponent(order.orderId)}`}
                    className="font-mono text-xs text-cyan-200 underline-offset-2 hover:underline"
                  >
                    {order.orderNumber ?? order.orderId}
                  </Link>
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
                {/* The actual error, shown here rather than named as a column
                    the operator would have to go and look up. */}
                {order.shippoSyncError ? (
                  <p className="mt-1 rounded bg-black/30 px-2 py-1 font-mono text-[11px] text-rose-200">
                    {order.shippoSyncError}
                  </p>
                ) : null}
                {/* THE PAYMENT ACTIONS LIVE ON ANOTHER TAB.
                    Both payment reasons tell the operator to release, or to
                    approve or reject — and those controls are on Payments, not
                    here. Naming an action without a route to it is the same
                    defect as a queue nobody can reach: the operator has to
                    already know where it lives and find the order again. */}
                {order.exceptions.includes("payment_hold") || order.exceptions.includes("payment_review") ? (
                  <Link
                    href="/admin/payments"
                    className="vl-btn-secondary mt-2 mr-2 inline-flex px-3 py-1 text-xs"
                  >
                    Review payment →
                  </Link>
                ) : null}
                {order.exceptions.includes("shippo_error") || order.exceptions.includes("shippo_blocked") ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => resync(order.orderId)}
                    className="vl-btn-secondary mt-2 px-3 py-1 text-xs disabled:opacity-50"
                  >
                    Retry sync
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* ---- CANCELLED WITH A LABEL ------------------------------------ */}
      {cancelledWithLabel.length > 0 ? (
        <section className="vl-panel vl-no-print rounded-xl border-amber-500/30 p-5">
          <h2 className="text-sm font-semibold text-amber-300">
            {cancelledWithLabel.length} cancelled order{cancelledWithLabel.length === 1 ? " has" : "s have"} a purchased label
          </h2>
          {/* The precise, honest claim. Cancelling in Vanta does NOT void or
              refund the label — nothing voids postage automatically — but Vanta
              CAN void it on request, which is why the button exists. */}
          <p className="mt-1 text-xs text-zinc-400">
            Cancelling the order did <strong className="text-amber-300">not</strong> refund the postage.
            If the parcel was never handed over, voiding it recovers the money.
          </p>
          <ul className="mt-3 space-y-2">
            {cancelledWithLabel.map((order) => (
              <li key={order.orderId} className="flex flex-wrap items-center gap-2 text-xs text-zinc-400">
                <span className="font-mono text-zinc-300">{order.orderNumber ?? order.orderId}</span>
                {order.trackingNumber ? <span>· {order.carrier} {order.trackingNumber}</span> : null}
                <a
                  href={`/admin/orders/${encodeURIComponent(order.orderId)}`}
                  className="vl-btn-secondary ml-auto px-3 py-1 text-xs"
                >
                  Open to void
                </a>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* ---- READY TO FULFIL ------------------------------------------- */}
      <section className="vl-panel vl-no-print rounded-xl p-5">
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
          {ready.length === 0 ? <li className="text-xs text-zinc-500">Nothing waiting.</li> : null}
        </ul>
      </section>

      {/* ---- BATCHES --------------------------------------------------- */}
      {openBatches.length > 0 ? (
        <section className="vl-panel vl-no-print rounded-xl p-5">
          <h2 className="text-sm font-semibold text-white">Open batches</h2>
          <ul className="mt-3 space-y-2">
            {openBatches.map((batch) => (
              <li key={batch.id} className="flex flex-wrap items-center gap-2 border-t border-white/5 pt-2">
                <span className="font-mono text-xs text-zinc-300">{batch.label}</span>
                <Pill tone="muted">{batch.orderCount} orders</Pill>
                <button type="button" disabled={busy} onClick={() => loadPickList(batch.id)}
                  className="vl-btn-secondary px-3 py-1 text-xs disabled:opacity-50">
                  1 · Pick list
                </button>
                <button type="button" disabled={busy} onClick={() => loadReview(batch.id)}
                  className="vl-btn-secondary px-3 py-1 text-xs disabled:opacity-50">
                  2 · Review labels
                </button>
                <a
                  href={`/api/admin/fulfillment/labels/print?batchId=${encodeURIComponent(batch.id)}`}
                  target="_blank"
                  rel="noreferrer"
                  className="vl-btn-secondary px-3 py-1 text-xs"
                >
                  3 · Print all labels
                </a>
                <button type="button" disabled={busy} onClick={() => { setActiveBatch(batch.id); loadNext(batch.id); }}
                  className="vl-btn-primary px-3 py-1 text-xs disabled:opacity-50">
                  4 · Start packing
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* ---- LABEL REVIEW, THEN THE SPEND ------------------------------ */}
      {review ? (
        <section className="vl-panel vl-no-print rounded-xl p-5">
          <h2 className="text-sm font-semibold text-white">Label review</h2>
          <p className="mt-1 text-xs text-zinc-500">
            Quoted, not bought. Nothing on this screen has spent anything.
          </p>

          <div className="mt-4 flex flex-wrap gap-3">
            <Pill tone="ok">{review.readyCount} ready</Pill>
            {review.alreadyBoughtCount > 0 ? <Pill tone="muted">{review.alreadyBoughtCount} already have labels</Pill> : null}
            {review.needsAttentionCount > 0 ? <Pill tone="crit">{review.needsAttentionCount} need attention</Pill> : null}
          </div>

          {review.needsAttentionCount > 0 ? (
            <ul className="mt-3 space-y-1">
              {review.lines.filter((l) => l.readiness === "needs_attention").map((line) => (
                <li key={line.orderId} className="text-xs text-zinc-400">
                  <span className="font-mono text-zinc-300">{line.orderNumber ?? line.orderId}</span> — {line.note}
                </li>
              ))}
            </ul>
          ) : null}

          {/* THE CONFIRMATION. The financial consequence is stated plainly and
              the operator has to click a second, differently-labelled button. */}
          {review.readyCount > 0 ? (
            <div className="mt-5 rounded-lg border border-white/10 bg-white/[0.02] p-4">
              {!confirming ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setConfirming(true)}
                  className="vl-btn-primary px-4 py-2 text-xs disabled:opacity-50"
                >
                  Purchase {review.readyCount} label{review.readyCount === 1 ? "" : "s"} · {money(review.estimatedTotalCents)}
                </button>
              ) : (
                <div role="alertdialog" aria-label="Confirm postage purchase">
                  <p className="text-sm text-white">
                    You are about to buy <strong>{review.readyCount}</strong> shipping label
                    {review.readyCount === 1 ? "" : "s"} through Shippo for approximately{" "}
                    <strong>{money(review.estimatedTotalCents)}</strong>.
                  </p>
                  <p className="mt-1 text-xs text-zinc-400">
                    This spends real money. Postage is only refundable by voiding each label.
                  </p>
                  <div className="mt-3 flex gap-2">
                    <button type="button" disabled={busy} onClick={purchaseLabels}
                      className="vl-btn-primary px-4 py-2 text-xs disabled:opacity-50">
                      Yes — buy {review.readyCount} label{review.readyCount === 1 ? "" : "s"}
                    </button>
                    <button type="button" disabled={busy} onClick={() => setConfirming(false)}
                      className="vl-btn-secondary px-4 py-2 text-xs disabled:opacity-50">
                      Cancel
                    </button>
                  </div>
                </div>
              )}
              {progress ? (
                <p className="mt-3 font-mono text-xs text-zinc-300" role="status">
                  Buying {progress.done} / {progress.total}…
                </p>
              ) : null}
            </div>
          ) : null}

          {/* PARTIAL FAILURE, REPORTED HONESTLY. Never "93 labels purchased". */}
          {purchaseResult ? (
            <div role="status" className="mt-4 rounded-lg border border-white/10 p-4">
              <p className="text-sm text-white">
                {purchaseResult.purchased} purchased · {money(purchaseResult.spentCents)} spent
              </p>
              <ul className="mt-1 space-y-0.5 text-xs text-zinc-400">
                {purchaseResult.alreadyHadOne > 0 ? <li>{purchaseResult.alreadyHadOne} already had a label — no charge.</li> : null}
                {purchaseResult.failed > 0 ? <li className="text-amber-300">{purchaseResult.failed} failed — nothing was charged for these.</li> : null}
                {purchaseResult.needsVerification > 0 ? (
                  <li className="text-rose-300">
                    {purchaseResult.needsVerification} need verification — postage may have been charged. Do not retry.
                  </li>
                ) : null}
              </ul>
              {purchaseResult.lines.filter((l) => l.outcome !== "purchased" && l.outcome !== "already_had_one").length > 0 ? (
                <ul className="mt-3 space-y-1 border-t border-white/5 pt-2">
                  {purchaseResult.lines
                    .filter((l) => l.outcome !== "purchased" && l.outcome !== "already_had_one")
                    .map((line) => (
                      <li key={line.orderId} className="text-xs text-zinc-400">
                        <span className="font-mono text-zinc-300">{line.orderNumber ?? line.orderId}</span>{" "}
                        <Pill tone={line.outcome === "needs_verification" ? "crit" : "warn"}>
                          {line.outcome === "needs_verification" ? "verify" : "failed"}
                        </Pill>{" "}
                        {line.message}
                      </li>
                    ))}
                </ul>
              ) : null}
            </div>
          ) : null}
        </section>
      ) : null}

      {/* ---- CONSOLIDATED PICK LIST ------------------------------------ */}
      {pickList ? (
        <section className="vl-panel vl-printable rounded-xl p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-white">Pick list — {pickList.batchLabel}</h2>
            <button
              type="button"
              onClick={() => window.print()}
              className="vl-btn-secondary vl-no-print px-3 py-1 text-xs"
            >
              Print pick list
            </button>
          </div>
          <p className="mt-1 text-xs text-zinc-500">
            {pickList.totalUnits} units across {pickList.lines.length} products, for {pickList.orderCount} orders.
            One walk per product.
          </p>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/10 text-left text-[11px] uppercase tracking-wider text-zinc-500">
                  <th className="pb-2 vl-print-only-cell">✓</th>
                  <th className="pb-2">Product</th>
                  <th className="pb-2 text-right">Units</th>
                  <th className="pb-2 text-right">Orders</th>
                </tr>
              </thead>
              <tbody>
                {pickList.lines.map((line) => (
                  <tr key={line.productId} className="border-b border-white/5">
                    <td className="py-2 vl-print-only-cell">
                      <span className="vl-pick-box" aria-hidden="true" />
                    </td>
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

      {/* ---- PACKING BENCH --------------------------------------------- */}
      {packing && activeBatch ? (
        <section className="vl-panel vl-no-print rounded-xl p-6">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="font-mono text-2xl tabular-nums text-zinc-400">
              {packing.position} / {packing.ofTotal}
            </h2>
            <span className="font-mono text-3xl text-white">{packing.orderNumber ?? packing.orderId}</span>
          </div>
          <p className="mt-2 text-sm text-zinc-400">{packing.customerName} · {packing.destination}</p>

          <ul className="mt-5 space-y-2">
            {packing.items.map((item) => (
              <li key={item.productId} className="flex items-center gap-4 rounded-lg bg-white/[0.03] px-4 py-3">
                <span className="font-mono text-3xl tabular-nums text-white">{item.quantity}×</span>
                <span className="text-lg text-zinc-100">{item.productName}</span>
              </li>
            ))}
          </ul>

          <div className="mt-5 flex flex-wrap gap-4 text-xs">
            <span className="text-zinc-500">
              Shipping:{" "}
              <span className="text-zinc-200">
                {packing.carrier || packing.service
                  ? `${packing.carrier ?? ""} ${packing.service ?? ""}`.trim()
                  : "not yet assigned"}
              </span>
            </span>
            <span className="text-zinc-500">
              Label: {packing.hasLabel
                ? <span className="text-emerald-300">purchased ✓</span>
                : <span className="text-amber-300">not bought yet</span>}
            </span>
            {packing.trackingNumber ? (
              <span className="font-mono text-zinc-500">{packing.trackingNumber}</span>
            ) : null}
          </div>

          {/* ONE ACTION. The label for this order was printed with the batch,
              in this exact position, so the packer matches label to parcel by
              sequence rather than by searching. Where a label is missing the
              single action is replaced by the reason, so nothing is verified
              into a box that cannot ship. */}
          <div className="mt-6 flex flex-wrap items-center gap-3">
            {packing.hasLabel ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => verifyAndAdvance(packing.orderId, activeBatch)}
                className="vl-btn-primary px-8 py-4 text-base disabled:opacity-50"
              >
                Verified — next order
              </button>
            ) : (
              <p className="text-sm text-amber-300">
                No label yet. Run <strong>Review labels</strong> for this batch first.
              </p>
            )}
            <a
              href={`/api/admin/orders/${encodeURIComponent(packing.orderId)}/shipping/label/print`}
              target="_blank"
              rel="noreferrer"
              className={`vl-btn-secondary px-4 py-2 text-xs ${packing.hasLabel ? "" : "pointer-events-none opacity-40"}`}
            >
              Reprint this label
            </a>
            <button
              type="button"
              disabled={busy}
              onClick={() => loadNext(activeBatch)}
              className="vl-btn-secondary px-4 py-2 text-xs disabled:opacity-50"
            >
              Skip
            </button>
          </div>
        </section>
      ) : null}

      {/* ---- IN FLIGHT, for reference ---------------------------------- */}
      <section className="vl-no-print grid gap-4 lg:grid-cols-2">
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
