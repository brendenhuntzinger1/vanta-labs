type AuditLogEntry = {
  id: string;
  action: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
};

const ACTION_LABELS: Record<string, string> = {
  order_update_status: "Status updated",
  order_refund: "Refund issued",
  order_cancel: "Order cancelled",
  order_resend_confirmation: "Confirmation email resent",
  order_print_packing_slip: "Packing slip printed",
};

function actionLabel(action: string) {
  return ACTION_LABELS[action] ?? action.replace(/^order_/, "").replace(/_/g, " ");
}

function describeMetadata(action: string, metadata: Record<string, unknown> | null) {
  if (!metadata) return null;

  if (action === "order_refund") {
    const amount = Number(metadata.amount ?? 0);
    const isFullRefund = Boolean(metadata.isFullRefund);
    return `${isFullRefund ? "Full refund" : "Partial refund"} of $${amount.toFixed(2)}`;
  }

  if (action === "order_update_status") {
    const parts: string[] = [];
    if (metadata.paymentStatus) parts.push(`payment → ${metadata.paymentStatus}`);
    if (metadata.fulfillmentStatus) parts.push(`fulfillment → ${metadata.fulfillmentStatus}`);
    if (metadata.trackingNumber) parts.push(`tracking ${metadata.trackingNumber}`);
    return parts.length > 0 ? parts.join(", ") : null;
  }

  return null;
}

export function AdminOrderTimeline({ entries }: { entries: AuditLogEntry[] }) {
  return (
    <div className="vl-panel-soft mt-6 rounded-xl p-4">
      <p className="text-xs uppercase tracking-[0.22em] text-zinc-500">Order Timeline</p>
      {entries.length === 0 ? (
        <p className="mt-3 text-sm text-zinc-500">No activity recorded yet.</p>
      ) : (
        <ol className="mt-3 space-y-3 border-l border-white/10 pl-4">
          {entries.map((entry) => {
            const performedBy = typeof entry.metadata?.performedBy === "string" ? entry.metadata.performedBy : null;
            const detail = describeMetadata(entry.action, entry.metadata);
            return (
              <li key={entry.id} className="relative">
                <span className="absolute -left-[21px] top-1.5 h-2 w-2 rounded-full bg-cyan-400/70" />
                <p className="text-sm font-medium text-zinc-100">{actionLabel(entry.action)}</p>
                {detail ? <p className="text-xs text-zinc-400">{detail}</p> : null}
                <p className="mt-0.5 text-xs text-zinc-500">
                  {new Date(entry.created_at).toLocaleString()}
                  {performedBy ? ` • ${performedBy}` : ""}
                </p>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
