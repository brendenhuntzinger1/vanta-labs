import Link from "next/link";

import { AdminAlertResolveButton } from "@/components/admin-alert-resolve-button";
import { extractAlertOrderIds, type SystemAlertRow } from "@/lib/monitoring";

// ---------------------------------------------------------------------------
// ONE ROW OF /admin/status, INCLUDING THE ORDERS THE ALERT IS ABOUT.
//
// Extracted from the page so it can be rendered in a test. The page maps this
// over unresolved alerts; everything specific to one alert lives here.
//
// The order links are the point. `shipping_cost_manual_entry_required` ends
// with "Enter the cost by hand in Admin -> Orders" and the ids it means are in
// `context`, which the page never read -- so the instruction named a task
// without naming its subjects.
//
// ONE ROW IS NOW ONE KIND OF ALERT, not one database row. Production carried 52
// open alerts of which 44 were the same warning repeating every half hour; at
// ten rows a page that is the entire window, which is exactly how the badge
// came to say "4 critical" above a list showing two. `occurrences` is that
// count, folded back in so nothing is hidden by the folding.
//
// Still a server component apart from the resolve control, which has to be a
// client component because it posts.
// ---------------------------------------------------------------------------

const DOT_BY_SEVERITY: Record<string, string> = {
  critical: "bg-rose-500",
  warning: "bg-amber-400",
};

/** Enough of the id to recognise, without wrapping the row on a phone. */
function shortOrderId(orderId: string): string {
  const bare = orderId.startsWith("order-") ? orderId.slice("order-".length) : orderId;
  return bare.length > 8 ? bare.slice(0, 8) : bare;
}

export function AdminSystemAlertRow({
  alert,
  occurrences = 1,
  alertIds,
}: {
  alert: SystemAlertRow;
  /** How many unresolved alerts of this type this row stands for. */
  occurrences?: number;
  /** Every id in the group, so resolving clears all of them. */
  alertIds?: string[];
}) {
  const orderIds = extractAlertOrderIds(alert.context);

  return (
    <div className="bg-white/[0.02] p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={`inline-block h-2 w-2 rounded-full ${DOT_BY_SEVERITY[alert.severity] ?? "bg-sky-400"}`}
          aria-hidden
        />
        <span className="text-sm font-medium text-white">{alert.type}</span>
        {occurrences > 1 ? (
          <span className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-zinc-400">
            ×{occurrences}
          </span>
        ) : null}
        <span className="text-xs text-zinc-500">
          {occurrences > 1 ? "latest " : ""}
          {new Date(alert.created_at).toLocaleString()}
        </span>
        <span className="ml-auto">
          <AdminAlertResolveButton
            type={alert.type}
            severity={alert.severity}
            alertIds={alertIds ?? [alert.id]}
            occurrences={occurrences}
          />
        </span>
      </div>
      <p className="mt-1 pl-4 text-xs text-zinc-400">{alert.message}</p>
      {orderIds.length > 0 ? (
        <div className="mt-2 flex flex-wrap items-center gap-1.5 pl-4">
          <span className="text-[11px] uppercase tracking-[0.14em] text-zinc-600">
            {orderIds.length === 1 ? "Order" : "Orders"}
          </span>
          {orderIds.map((orderId) => (
            <Link
              key={orderId}
              href={`/admin/orders/${orderId}`}
              // The full id in the title: the visible text is truncated to keep
              // a long backlog readable, and an operator comparing against the
              // alert email needs the whole thing available.
              title={orderId}
              className="rounded-md border border-white/15 bg-white/[0.06] px-2 py-0.5 font-mono text-[11px] text-zinc-200 hover:bg-white/[0.12]"
            >
              {shortOrderId(orderId)}
            </Link>
          ))}
        </div>
      ) : null}
    </div>
  );
}
