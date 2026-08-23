"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { normalizeLegacyStatus, type FulfillmentStatus } from "@/lib/order-pipeline";

// ---------------------------------------------------------------------------
// Fulfillment, as a status card.
//
// This replaces a 900-line workstation that duplicated Shippo: a package
// selector, a weight override, a rate list, a carrier picker, manual tracking
// and postage fields. All of it existed so an order could be shipped from here
// -- and none of it should, because shipping happens in Shippo.
//
// The reason to delete rather than hide is throughput. The owner ships by
// working the Shippo queue, not by opening one Vanta page per order, and every
// control on this card is a reason to open a page that did not need opening.
// What is left answers exactly one question -- where is this parcel? -- plus
// the one action that is genuinely Vanta's: repairing a failed push.
//
// NOTHING HERE PUSHES TO SHIPPO. The push happens on payment, server-side (see
// scheduleShippoSync in payment-webhook.ts) with a cron sweep behind it. Retry
// appears only after a real failure, so a healthy order needs no visit at all.
// ---------------------------------------------------------------------------

export interface FulfillmentCardLabel {
  carrier: string | null;
  service: string | null;
  trackingNumber: string | null;
  trackingUrl: string | null;
  /** Integer cents. null renders as Pending -- never $0.00. */
  postageCostCents: number | null;
  purchasedAt: string | null;
}

export interface AdminOrderFulfillmentCardProps {
  orderId: string;
  fulfillmentStatus: string;
  /** Shippo's id for this order, once the push succeeded. */
  shippoOrderId: string | null;
  shippoSyncStatus: string | null;
  shippoSyncError: string | null;
  label: FulfillmentCardLabel | null;
  /** False when payment is not verified -- nothing should have been pushed. */
  canFulfill: boolean;
  /** A line had no weight on its SKU, so the declared parcel is a guess. */
  weightReviewRequired: boolean;
  shippoConfigured: boolean;
}

const USD = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

/**
 * An unknown postage cost is "Pending", never "$0.00". Zero is a real price
 * meaning the shipment was free, and showing it for "not known yet" is how a
 * store talks itself into better margins than it has.
 */
function money(cents: number | null | undefined): string {
  if (cents == null || !Number.isFinite(cents)) return "Pending";
  return USD.format(cents / 100);
}

function shippoOrderUrl(shippoOrderId: string | null): string {
  return shippoOrderId
    ? `https://apps.goshippo.com/orders/${encodeURIComponent(shippoOrderId)}`
    : "https://apps.goshippo.com/orders";
}

/** The five words that describe where the parcel is. */
function headline(
  status: FulfillmentStatus | null,
  hasLabel: boolean,
  synced: boolean,
  failed: boolean,
): string {
  switch (status) {
    case "delivered":
      return "Delivered";
    case "out_for_delivery":
      return "Out for delivery";
    case "in_transit":
      return "In transit";
    case "shipped":
    case "label_purchased":
      return "Label purchased";
    case "returned":
      return "Returned";
    case "cancelled":
      return "Cancelled";
    case "refunded":
      return "Refunded";
    default:
      if (hasLabel) return "Label purchased";
      if (synced) return "Awaiting label";
      // Before this branch existed the pill read "Syncing to Shippo…" while the
      // body of the same card said the sync had failed. A status badge that
      // contradicts the error beneath it is worse than no badge: the reassuring
      // one is the one people believe.
      return failed ? "Sync failed" : "Syncing to Shippo…";
  }
}

const TONE: Record<string, string> = {
  ok: "border-emerald-300/40 bg-emerald-300/10 text-emerald-200",
  wait: "border-amber-300/40 bg-amber-300/10 text-amber-200",
  bad: "border-rose-300/40 bg-rose-300/10 text-rose-200",
};

export function AdminOrderFulfillmentCard({
  orderId,
  fulfillmentStatus,
  shippoOrderId,
  shippoSyncStatus,
  shippoSyncError,
  label,
  canFulfill,
  weightReviewRequired,
  shippoConfigured,
}: AdminOrderFulfillmentCardProps) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  // Synchronous, so two clicks in one React tick cannot both reach fetch().
  const inFlight = useRef(false);

  // Legacy rows carry statuses this pipeline retired; an unmappable one is
  // treated as "not yet shipped", which is the safe reading.
  // A legacy row can carry a status this pipeline retired; null then means
  // "nothing known yet", which the headline treats as not-yet-shipped.
  const status = normalizeLegacyStatus(fulfillmentStatus);
  const hasLabel = Boolean(label?.trackingNumber || label?.carrier);
  const synced = Boolean(shippoOrderId);
  // Only a real failure earns a Retry button. A pending push is not a problem
  // to be clicked at; it resolves itself within seconds.
  const failed = !synced && canFulfill && (shippoSyncStatus === "error" || shippoSyncStatus === "blocked");

  async function retrySync() {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setNotice(null);
    try {
      const res = await fetch(`/api/admin/orders/${orderId}/shipping/sync`, { method: "POST" });
      const json = (await res.json().catch(() => null)) as { success?: boolean; error?: string } | null;
      setNotice(json?.success ? "Sent to Shippo." : (json?.error ?? "Could not reach Shippo."));
      if (json?.success) router.refresh();
    } catch {
      setNotice("Network error — try again.");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  const title = headline(status, hasLabel, synced, failed);
  const tone = status === "delivered" || hasLabel ? "ok" : failed ? "bad" : "wait";

  return (
    <section className="mt-6 rounded-2xl border border-white/10 bg-white/[0.02] p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold uppercase tracking-[0.18em] text-zinc-300">Fulfillment</h2>
        <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide ${TONE[tone]}`}>
          {title}
        </span>
      </div>

      {!shippoConfigured ? (
        <p className="mt-3 rounded-lg border border-rose-300/30 bg-rose-300/10 px-3 py-2 text-[13px] text-rose-100">
          Shippo is not configured on this deployment, so orders are not reaching it.
        </p>
      ) : failed ? (
        <div className="mt-3 rounded-lg border border-rose-300/30 bg-rose-300/10 px-3 py-2 text-[13px] text-rose-100">
          <p className="font-semibold">Shippo sync failed</p>
          {shippoSyncError ? <p className="mt-1 text-[12px] text-rose-200/90">{shippoSyncError}</p> : null}
        </div>
      ) : null}

      {weightReviewRequired && !hasLabel ? (
        <p className="mt-3 rounded-lg border border-amber-300/30 bg-amber-300/10 px-3 py-2 text-[12px] text-amber-100">
          One or more items have no weight stored on the SKU, so the weight sent to Shippo is a fallback.
        </p>
      ) : null}

      {/* Everything below appears only once Shippo has sold a label -- and all of
          it arrives from the transaction_created webhook, never typed here. */}
      {hasLabel && label ? (
        <dl className="mt-4 divide-y divide-white/5 border-t border-white/10">
          <Row label="Carrier">{[label.carrier, label.service].filter(Boolean).join(" · ") || "—"}</Row>
          <Row label="Tracking">
            {label.trackingNumber ? (
              <span className="font-mono text-[12px] break-all">{label.trackingNumber}</span>
            ) : (
              "—"
            )}
          </Row>
          <Row label="Postage">
            <span className={`tabular-nums ${label.postageCostCents == null ? "text-amber-300" : ""}`}>
              {money(label.postageCostCents)}
            </span>
          </Row>
        </dl>
      ) : null}

      {/* THE HANDOFF, ON THE SCREEN WHERE THE OWNER IS STANDING.
          Vanta owns the order; Shippo buys and prints the label with Click to
          Print. Once a label exists this stops inviting a purchase and says so
          plainly — buying the same parcel twice in Shippo is the one mistake
          here that costs real money, and Shippo cannot know Vanta already has
          one. */}
      {shippoOrderId ? (
        <div className={`mt-4 rounded-xl border p-3 ${hasLabel ? "border-emerald-400/25 bg-emerald-400/[0.06]" : "border-cyan-400/25 bg-cyan-400/[0.06]"}`}>
          {hasLabel ? (
            <>
              <p className="text-sm font-semibold text-emerald-100">Label already purchased.</p>
              <p className="mt-1 text-[12px] leading-6 text-emerald-100/80">
                In Shippo, use Click to Print only. Do not buy postage for this order again — it is
                already paid for.
              </p>
            </>
          ) : (
            <>
              <p className="text-sm font-semibold text-cyan-100">Buy and print this label in Shippo.</p>
              <p className="mt-1 text-[12px] leading-6 text-cyan-100/80">
                The order is already in Shippo with its address, parcel and Vanta order number — you
                do not need to re-enter anything. Buy the label there, then Click to Print. Vanta
                picks up the tracking and postage on its own and moves the order to Awaiting Carrier.
              </p>
            </>
          )}
          <a
            href="https://apps.goshippo.com/orders"
            target="_blank"
            rel="noopener noreferrer"
            className="vl-btn-secondary mt-2.5 inline-flex px-4 py-2 text-xs"
          >
            Open in Shippo →
          </a>
        </div>
      ) : null}

      {notice ? <p className="mt-3 text-[12px] text-zinc-300">{notice}</p> : null}

      <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        {hasLabel && label?.trackingUrl ? (
          <a
            href={label.trackingUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="vl-btn-primary w-full px-5 py-2.5 text-center text-sm sm:w-auto"
          >
            Track package
          </a>
        ) : null}

        <a
          href={shippoOrderUrl(shippoOrderId)}
          target="_blank"
          rel="noopener noreferrer"
          className={`w-full px-5 py-2.5 text-center text-sm sm:w-auto ${hasLabel ? "vl-btn-secondary" : "vl-btn-primary"}`}
        >
          Open in Shippo
        </a>

        {/* Only after a real failure. A healthy order never shows this, which is
            the difference between a status page and a control panel. */}
        {failed ? (
          <button
            type="button"
            onClick={retrySync}
            disabled={busy}
            className="vl-btn-secondary w-full px-5 text-sm disabled:opacity-40 sm:w-auto"
          >
            {busy ? "Retrying…" : "Retry sync"}
          </button>
        ) : null}
      </div>
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-2">
      <dt className="text-[11px] uppercase tracking-[0.12em] text-zinc-500">{label}</dt>
      <dd className="text-right text-sm text-zinc-100">{children}</dd>
    </div>
  );
}
