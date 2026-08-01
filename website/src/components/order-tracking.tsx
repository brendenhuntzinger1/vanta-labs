import { getOrderProgress } from "@/lib/order-status";

function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="h-3 w-3" aria-hidden="true">
      <path d="m5 12 4 4 10-10" />
    </svg>
  );
}

/**
 * Presentational order tracking stepper. Derives a 5-step progression from the
 * order's payment + fulfillment status. Horizontal on desktop, comfortable on
 * mobile. Pure server component — no client JS.
 */
export function OrderTracking({
  paymentStatus,
  fulfillmentStatus,
  estimatedDelivery,
  compact = false,
}: {
  paymentStatus: string;
  fulfillmentStatus: string;
  estimatedDelivery?: string | null;
  compact?: boolean;
}) {
  const progress = getOrderProgress(paymentStatus, fulfillmentStatus);

  if (progress.cancelled || progress.refunded) {
    return (
      <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
        <p className={`text-sm font-medium ${progress.refunded ? "text-amber-200" : "text-zinc-300"}`}>{progress.headline}</p>
        <p className="mt-1 text-xs text-zinc-500">
          {progress.refunded ? "A refund has been issued for this order." : "This order was cancelled and will not ship."}
        </p>
      </div>
    );
  }

  return (
    <div className={compact ? "" : "rounded-xl border border-white/10 bg-white/[0.02] p-4 sm:p-5"}>
      {!compact ? (
        <div className="mb-4 flex items-center justify-between">
          <p className="text-sm font-medium text-white">{progress.headline}</p>
          {estimatedDelivery ? (
            <p className="text-xs text-zinc-500">
              Est. delivery {new Date(estimatedDelivery).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
            </p>
          ) : null}
        </div>
      ) : null}

      <ol className="flex items-center">
        {progress.steps.map((step, i) => {
          const done = step.state === "done";
          const current = step.state === "current";
          const active = done || current;
          return (
            <li key={step.key} className={`flex items-center ${i < progress.steps.length - 1 ? "flex-1" : ""}`}>
              <div className="flex flex-col items-center gap-1.5">
                <span
                  className={`flex h-6 w-6 items-center justify-center rounded-full border text-[10px] transition-colors ${
                    done
                      ? "border-cyan-300/50 bg-cyan-400/20 text-cyan-200"
                      : current
                        ? "border-cyan-300 bg-cyan-400/30 text-white"
                        : "border-white/15 bg-white/[0.03] text-zinc-600"
                  }`}
                  aria-current={current ? "step" : undefined}
                >
                  {done ? <CheckIcon /> : <span className={current ? "h-1.5 w-1.5 rounded-full bg-cyan-200" : "h-1.5 w-1.5 rounded-full bg-zinc-600"} />}
                </span>
                <span className={`text-[10px] ${active ? "text-zinc-300" : "text-zinc-600"} ${compact ? "hidden sm:block" : ""}`}>{step.label}</span>
              </div>
              {i < progress.steps.length - 1 ? (
                <span className={`mx-1 h-0.5 flex-1 rounded-full ${done ? "bg-cyan-400/40" : "bg-white/10"}`} />
              ) : null}
            </li>
          );
        })}
      </ol>
    </div>
  );
}
