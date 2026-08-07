import { fulfillmentStatusLabel, normalizeLegacyStatus, type FulfillmentStatus } from "@/lib/order-pipeline";

// The fulfillment status as a coloured pill, shared by the order list and the
// fulfillment queue. It lived inside the old shipping workstation; that file is
// gone, and a pill has no business being coupled to a packing screen anyway.

const STATUS_TONE: Partial<Record<FulfillmentStatus, string>> = {
  awaiting_payment: "border-zinc-400/30 bg-zinc-400/10 text-zinc-300",
  paid: "border-sky-300/40 bg-sky-300/10 text-sky-200",
  ready_to_fulfill: "border-amber-300/40 bg-amber-300/10 text-amber-200",
  packed: "border-violet-300/40 bg-violet-300/10 text-violet-200",
  label_purchased: "border-indigo-300/40 bg-indigo-300/10 text-indigo-200",
  shipped: "border-cyan-300/40 bg-cyan-300/10 text-cyan-200",
  in_transit: "border-cyan-300/40 bg-cyan-300/10 text-cyan-200",
  out_for_delivery: "border-teal-300/40 bg-teal-300/10 text-teal-200",
  delivered: "border-emerald-300/40 bg-emerald-300/10 text-emerald-200",
  cancelled: "border-zinc-400/30 bg-zinc-400/10 text-zinc-400",
  refunded: "border-rose-300/40 bg-rose-300/10 text-rose-200",
  returned: "border-orange-300/40 bg-orange-300/10 text-orange-200",
};

export function FulfillmentStatusPill({ status }: { status: string }) {
  const normalized = normalizeLegacyStatus(status);
  const tone = (normalized && STATUS_TONE[normalized]) || "border-white/20 bg-white/5 text-zinc-300";
  return (
    <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-semibold ${tone}`}>
      {fulfillmentStatusLabel(status)}
    </span>
  );
}
