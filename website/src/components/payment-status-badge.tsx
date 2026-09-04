import Link from "next/link";
import {
  describePaymentStatus,
  describeRetryDelay,
  type PaidRetryLink,
  type PaymentTone,
} from "@/lib/payment-failure";

// ---------------------------------------------------------------------------
// The Payment column, and the two lines under it.
//
// Before 2026-09-04 this cell printed the raw enum: `payment_failed` for a bank
// decline, for a checkout the shopper abandoned, and for a test order retired
// by hand alike. The operator read a list of them as "a lot of failed payments"
// and asked whether the store was broken. It was not, and every real customer
// on that list had paid on a second order a minute later — a fact the page had
// no way to show.
//
// So: a badge whose colour and words say WHICH kind of not-paid this is, the
// processor's reason beneath it when there is one, and a link to the paid retry
// when the same shopper came straight back. Rendered by the list (both table
// and mobile cards) and by the order page, so all three say the same thing.
//
// Client-safe: no server-only imports. The list is a client component.
// ---------------------------------------------------------------------------

const TONE_CLASSES: Record<PaymentTone, string> = {
  paid: "border-emerald-400/30 bg-emerald-400/10 text-emerald-200",
  declined: "border-rose-400/40 bg-rose-500/10 text-rose-200",
  // Muted on purpose: an abandoned checkout is a non-event, and it must not
  // read with the same urgency as a decline.
  expired: "border-white/10 bg-white/[0.04] text-zinc-400",
  failed: "border-amber-400/40 bg-amber-400/10 text-amber-200",
  pending: "border-sky-400/30 bg-sky-400/10 text-sky-200",
  refunded: "border-violet-400/30 bg-violet-400/10 text-violet-200",
  canceled: "border-white/10 bg-white/[0.04] text-zinc-400",
  neutral: "border-white/15 bg-white/[0.05] text-zinc-200",
};

export function PaymentStatusBadge({
  status,
  failureKind,
  className = "",
}: {
  status: string | null | undefined;
  failureKind?: string | null;
  className?: string;
}) {
  const { label, tone } = describePaymentStatus(status, failureKind);
  return (
    <span
      data-payment-tone={tone}
      className={`inline-flex items-center whitespace-nowrap rounded-full border px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide ${TONE_CLASSES[tone]} ${className}`}
    >
      {label}
    </span>
  );
}

/** How much of a processor message a table cell shows before it is cut. */
const MAX_INLINE_REASON = 140;

function clampReason(reason: string): string {
  const text = reason.trim();
  return text.length <= MAX_INLINE_REASON ? text : `${text.slice(0, MAX_INLINE_REASON - 1).trimEnd()}…`;
}

/**
 * Badge plus the story: the processor's reason for a failed row, and the paid
 * retry when there was one. `compact` is the table cell; the order page passes
 * false and gets the full reason.
 */
export function PaymentOutcome({
  status,
  failureKind,
  failureReason,
  paidRetry,
  compact = true,
}: {
  status: string | null | undefined;
  failureKind?: string | null;
  failureReason?: string | null;
  paidRetry?: PaidRetryLink | null;
  compact?: boolean;
}) {
  const normalized = String(status ?? "").toLowerCase();
  const isFailed = normalized === "payment_failed";
  const isPaid = normalized === "paid";
  const reason = (failureReason ?? "").trim();

  return (
    <div className="flex flex-col items-start gap-1">
      <PaymentStatusBadge status={status} failureKind={failureKind} />

      {isFailed && reason ? (
        <p className="max-w-xs text-xs leading-snug text-zinc-400" title={reason}>
          {compact ? clampReason(reason) : reason}
        </p>
      ) : null}

      {/* A paid order that carries an earlier decline on the SAME row: the
          shopper retried within the same checkout. True, and worth a footnote,
          but never the headline — the headline is that they paid. */}
      {isPaid && failureKind === "processor_declined" ? (
        <p className="text-[11px] text-zinc-500">First attempt was declined; this order then paid.</p>
      ) : null}

      {!isPaid && paidRetry ? (
        <Link
          href={`/admin/orders/${paidRetry.orderId}`}
          data-paid-retry
          className="inline-flex items-center gap-1.5 rounded-full border border-cyan-300/40 bg-cyan-400/10 px-2 py-0.5 text-[11px] font-semibold text-cyan-100 hover:border-cyan-300/70 hover:text-white"
          title={paidRetry.sameAmount ? "The same customer placed a paid order for the same total shortly afterwards." : "The same customer placed a paid order shortly afterwards, for a different total."}
        >
          <span aria-hidden>↻</span>
          Retried and paid
          <span className="font-mono font-normal text-cyan-200/90">{paidRetry.orderNumber ?? paidRetry.orderId}</span>
          <span className="font-normal text-cyan-200/70">· {describeRetryDelay(paidRetry.minutesAfter)}</span>
          {/* Visible, not a tooltip: a title attribute is unreachable on a
              phone, and a different total is the one thing that says this may
              not be the same purchase. */}
          <span className="font-normal text-cyan-200/70">· {paidRetry.sameAmount ? "same total" : "different total"}</span>
        </Link>
      ) : null}
    </div>
  );
}
