"use client";

import { useCallback, useEffect, useState } from "react";
import type { CommunicationRow, CommunicationState } from "@/lib/order-communications";

/**
 * What the customer has been told about this order.
 *
 * Everything shown is derived from the order's own state and the failed-email
 * queue; nothing new is stored to render it. The one claim it will not make is
 * "Sent" — nothing records a successful send, so the honest label is that no
 * failure was recorded. An owner who needs certainty has the provider's log;
 * an owner who needs to spot a problem has this.
 */

type Payload = {
  orderNumber?: string;
  paymentStatus?: string | null;
  fulfillmentStatus?: string | null;
  shippedAt?: string | null;
  deliveredAt?: string | null;
  rows?: CommunicationRow[];
  found?: number;
  sent?: number;
  stillFailing?: number;
};

const TONE: Record<CommunicationState, string> = {
  failed: "border-rose-400/40 bg-rose-400/10 text-rose-200",
  retrying: "border-amber-300/40 bg-amber-300/10 text-amber-200",
  recovered: "border-emerald-300/30 bg-emerald-300/[0.07] text-emerald-200",
  no_failure_recorded: "border-white/10 bg-white/[0.03] text-zinc-300",
  not_due: "border-white/10 bg-white/[0.02] text-zinc-500",
};

const STATE_LABEL: Record<CommunicationState, string> = {
  failed: "FAILED",
  retrying: "RETRYING",
  recovered: "SENT ON RETRY",
  no_failure_recorded: "NO FAILURE RECORDED",
  not_due: "NOT DUE",
};

function when(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
}

export function AdminOrderCommunications({ orderId }: { orderId: string }) {
  const [data, setData] = useState<Payload | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/admin/orders/${encodeURIComponent(orderId)}/communications`, {
        cache: "no-store",
      });
      if (response.ok) setData((await response.json()) as Payload);
    } catch {
      /* an observability panel must never break the order page */
    }
  }, [orderId]);

  useEffect(() => {
    const timer = setTimeout(() => void load(), 0);
    return () => clearTimeout(timer);
  }, [load]);

  const retry = useCallback(async () => {
    setBusy(true);
    setNote(null);
    try {
      const response = await fetch(`/api/admin/orders/${encodeURIComponent(orderId)}/communications`, {
        method: "POST",
      });
      const body = (await response.json()) as Payload;
      setData(body);
      setNote(
        body.found === 0
          ? "Nothing queued to retry."
          : `Retried ${body.found}: ${body.sent ?? 0} delivered, ${body.stillFailing ?? 0} still failing.`,
      );
    } catch (error) {
      setNote(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [orderId]);

  if (!data?.rows) return null;

  const retryable = data.rows.some((row) => row.retryable);

  return (
    <section className="vl-panel rounded-2xl p-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-[0.16em] text-zinc-300">Customer communications</h2>
          <p className="mt-1 text-xs text-zinc-500">
            Derived from the order&rsquo;s own state and the failed-email queue. Nothing records a successful send, so a
            clean row means no failure was recorded — not proof of delivery.
          </p>
        </div>
        {retryable ? (
          <button
            type="button"
            onClick={() => void retry()}
            disabled={busy}
            className="rounded-xl border border-amber-300/40 bg-amber-300/10 px-4 py-2 text-xs font-semibold text-amber-100 transition hover:bg-amber-300/20 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? "Retrying…" : "Retry email"}
          </button>
        ) : null}
      </header>

      <dl className="mt-4 grid gap-2 text-xs sm:grid-cols-2">
        {[
          ["Payment", data.paymentStatus ?? "—"],
          ["Fulfilment", data.fulfillmentStatus ?? "—"],
          ["Shipped at", when(data.shippedAt)],
          ["Delivered at", when(data.deliveredAt)],
        ].map(([label, value]) => (
          <div key={label} className="flex items-center justify-between rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2">
            <dt className="text-zinc-400">{label}</dt>
            <dd className="font-mono text-[11px] text-zinc-200">{value}</dd>
          </div>
        ))}
      </dl>

      <ul className="mt-3 space-y-2">
        {data.rows.map((row) => (
          <li key={row.key} className={`rounded-xl border px-3 py-2.5 ${TONE[row.state]}`}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs font-semibold text-white/90">{row.label}</span>
              <span className="font-mono text-[10px] tracking-[0.1em]">{STATE_LABEL[row.state]}</span>
            </div>
            <p className="mt-1 text-[11px] leading-5 opacity-90">{row.detail}</p>
            {row.lastError ? (
              <p className="mt-1 font-mono text-[10px] leading-4 opacity-75">{row.lastError}</p>
            ) : null}
          </li>
        ))}
      </ul>

      {note ? <p className="mt-3 text-xs text-zinc-400">{note}</p> : null}
      {retryable ? (
        <p className="mt-2 text-[11px] leading-5 text-zinc-500">
          Retry re-sends the stored message only. It cannot re-charge a card, move stock, pay a commission or change
          fulfilment — the retry path has no access to any of them.
        </p>
      ) : null}
    </section>
  );
}
