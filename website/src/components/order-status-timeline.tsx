/**
 * Order Confirmed → Processing → Shipped.
 *
 * Shown only once payment is CONFIRMED — before that the hero is still resolving
 * whether the charge landed, and a timeline claiming "Order Confirmed" would be
 * asserting something we do not yet know.
 *
 * The current step reads from the order's real fulfilment status rather than
 * being hard-coded, so a customer who revisits this link after their parcel
 * ships sees where it actually is.
 */

const STEPS = ["Order confirmed", "Processing", "Shipped"] as const;

/** Which step the order is on, from its fulfilment status. */
export function stepIndexForFulfillment(fulfillmentStatus: string | null | undefined): number {
  const status = (fulfillmentStatus ?? "").trim().toLowerCase();
  // The same ladder order-status.ts reads: carrier scans write in_transit /
  // out_for_delivery, and the shop writes ready_to_fulfill / packed /
  // label_purchased before the parcel leaves. None of them may read as "not
  // started".
  if (["shipped", "in_transit", "out_for_delivery", "delivered", "fulfilled"].includes(status)) return 2;
  if (["processing", "awaiting_fulfillment", "partially_fulfilled", "ready_to_fulfill", "packed", "label_purchased"].includes(status)) return 1;
  return 0;
}

export function OrderStatusTimeline({ fulfillmentStatus }: { fulfillmentStatus: string | null | undefined }) {
  const current = stepIndexForFulfillment(fulfillmentStatus);

  return (
    <ol className="mt-6 flex items-start" aria-label="Order progress">
      {STEPS.map((label, index) => {
        const done = index < current;
        const active = index === current;
        const reached = done || active;

        return (
          <li key={label} className="relative flex flex-1 flex-col items-center text-center">
            {/* Spans the gap BETWEEN two dot centres, inset by the 11px dot
                radius plus 3px of breathing room at each end — so the line stops
                short of both markers instead of showing through the
                semi-transparent fill. Steps are flex-1, so the previous centre
                is always at -50% of this item's width. */}
            {index > 0 ? (
              <span
                aria-hidden
                className={`absolute left-[calc(-50%+14px)] top-[11px] z-0 h-px w-[calc(100%-28px)] ${reached ? "bg-emerald-400/40" : "bg-white/10"}`}
              />
            ) : null}

            <span
              className={`relative z-10 flex h-[22px] w-[22px] items-center justify-center rounded-full border text-[10px] ${
                active
                  ? "border-emerald-300/60 bg-emerald-400/20 text-emerald-200"
                  : done
                    ? "border-emerald-300/40 bg-emerald-400/15 text-emerald-300"
                    : "border-white/15 bg-[#0b0b0b] text-white/25"
              }`}
            >
              {reached ? "✓" : ""}
            </span>

            <span
              className={`mt-2 px-1 text-[11px] leading-tight ${
                active ? "font-semibold text-white" : reached ? "text-white/70" : "text-white/35"
              }`}
            >
              {label}
            </span>
            {active ? <span className="sr-only">(current step)</span> : null}
          </li>
        );
      })}
    </ol>
  );
}
