// ---------------------------------------------------------------------------
// One vocabulary for WHY an order did not get paid.
//
// `payment_status = 'payment_failed'` is the machine state, and it stays the
// machine state: the terminal-state guards, the reconcile sweep, the profit and
// BXGY SQL and the customer's order-status poll all read it. What it never
// carried was the reason, so on 2026-09-04 the admin list showed a bank
// decline, a checkout session Veyra expired after the shopper walked away, and
// two test orders retired by hand as the same word — and the operator asked,
// reasonably, whether checkout was broken. It was not.
//
// This module is PURE and imported by both sides: the three server paths that
// write payment_failed (payment-webhook.ts, express/authorize, express-
// reconcile.ts) use it to decide what to record, and the admin UI uses it to
// decide what to say. No "server-only" import, no database, no Next.
// ---------------------------------------------------------------------------

/**
 * Why a payment_failed row failed.
 *
 *   processor_declined  a charge was attempted and the bank or processor said no
 *   checkout_expired    the checkout session expired or was cancelled with no
 *                       charge attempt — an abandoned cart, not a decline
 *   other               retired for a reason this system could not classify,
 *                       or before reasons were recorded
 *
 * Mirrors the CHECK constraint in sql/payment-failure-detail.sql. Add to both
 * or neither.
 */
export type PaymentFailureKind = "processor_declined" | "checkout_expired" | "other";

export interface PaymentFailureDetail {
  kind: PaymentFailureKind;
  /** The processor's machine code (decline code, session status), or null. */
  code: string | null;
  /** The processor's own message when it sent one; otherwise our plain account. */
  reason: string | null;
}

/** Long enough for any real processor message; short enough for a table cell. */
const MAX_REASON_CHARS = 200;
const MAX_CODE_CHARS = 80;

/** A trimmed string, clamped with an ellipsis, or null for anything else. */
function text(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().replace(/\s+/g, " ");
  if (!trimmed) return null;
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1).trimEnd()}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `obj.a.b.c`, or undefined when any step is not an object. */
function dig(obj: unknown, path: readonly string[]): unknown {
  let cursor: unknown = obj;
  for (const key of path) {
    if (!isRecord(cursor)) return undefined;
    cursor = cursor[key];
  }
  return cursor;
}

/** First path that yields a usable string, across every candidate root. */
function firstText(roots: readonly unknown[], paths: readonly (readonly string[])[], max: number): string | null {
  for (const root of roots) {
    for (const path of paths) {
      const found = text(dig(root, path), max);
      if (found) return found;
    }
  }
  return null;
}

// Most specific first. A network decline code ("insufficient_funds") says more
// than the generic failure code ("card_declined") that accompanies it.
const CODE_PATHS: readonly (readonly string[])[] = [
  ["decline_code"],
  ["outcome", "network_decline_code"],
  ["outcome", "reason"],
  ["last_payment_error", "decline_code"],
  ["failure_code"],
  ["last_payment_error", "code"],
  ["last_error", "code"],
  ["error", "code"],
  ["declineCode"],
  ["failureCode"],
];

// The cardholder-facing sentence first, the seller-facing one second.
const REASON_PATHS: readonly (readonly string[])[] = [
  ["failure_message"],
  ["last_payment_error", "message"],
  ["last_error", "message"],
  ["outcome", "seller_message"],
  ["error", "message"],
  ["failure_reason"],
  ["failureReason"],
  ["decline_reason"],
  ["message"],
  ["reason"],
];

/**
 * The processor's account of a failed charge, wherever it put it.
 *
 * VeyraGate delivers `{ id, type, data: <charge> }` and the charge has been
 * seen both nested (`data.object`) and un-nested (`data`); the internal mock
 * gateway sends a flat body. All three are searched, innermost first, so the
 * charge's own fields win over anything on the envelope. Never throws: this
 * runs inside the payment webhook, where an exception is a lost side-effect run.
 */
export function extractProcessorFailure(payload: unknown): PaymentFailureDetail {
  const roots = [dig(payload, ["data", "object"]), dig(payload, ["data"]), payload].filter(isRecord);
  return {
    kind: "processor_declined",
    code: firstText(roots, CODE_PATHS, MAX_CODE_CHARS),
    reason: firstText(roots, REASON_PATHS, MAX_REASON_CHARS),
  };
}

/**
 * What the reconcile sweep learned by reading a dead checkout session.
 *
 * Veyra's by-id read reports `failed`, `expired`, `canceled` or `cancelled`
 * for a session that is terminal with no money moved (express-reconcile.ts,
 * DEAD_SESSION_STATUSES). Only the first of those is a decline; the others are
 * a shopper who never finished. Telling them apart is the whole point.
 */
export function classifyDeadSession(status: string, session?: unknown): PaymentFailureDetail {
  const normalized = String(status ?? "").trim().toLowerCase();
  const roots = [session].filter(isRecord);

  if (normalized === "failed") {
    return {
      kind: "processor_declined",
      code: firstText(roots, CODE_PATHS, MAX_CODE_CHARS) ?? "failed",
      reason: firstText(roots, REASON_PATHS, MAX_REASON_CHARS)
        ?? "The processor reported the payment attempt failed.",
    };
  }
  if (normalized === "expired") {
    return {
      kind: "checkout_expired",
      code: "expired",
      reason: "The checkout session expired at the processor before a payment was completed. No charge was attempted.",
    };
  }
  if (normalized === "canceled" || normalized === "cancelled") {
    return {
      kind: "checkout_expired",
      code: normalized,
      reason: "The checkout session was cancelled at the processor before a payment was completed. No charge was attempted.",
    };
  }
  return {
    kind: "other",
    code: text(normalized, MAX_CODE_CHARS),
    reason: "The processor closed this checkout session without a charge.",
  };
}

/**
 * Veyra's answer to an Apple Pay charge that came back `answered_no`.
 *
 * The pay-bt response carries `public_status` (failed | blocked), sometimes a
 * `decline_code` and `message`, and an `error` slug on plain 4xx refusals.
 * "blocked" is Veyra's own fraud/velocity guard, not the bank — worth saying,
 * because the fix for each is different.
 */
export function describeExpressDecline(payload: unknown, httpStatus: number): PaymentFailureDetail {
  const body = isRecord(payload) ? payload : {};
  const publicStatus = text(body.public_status, MAX_CODE_CHARS);
  const code =
    firstText([body], [["decline_code"], ["declineCode"], ["error_code"], ["code"]], MAX_CODE_CHARS)
    ?? text(body.error, MAX_CODE_CHARS)
    ?? publicStatus
    ?? `http_${Number.isFinite(httpStatus) ? httpStatus : 0}`;
  const reason =
    firstText([body], [["message"], ["error_message"], ["decline_message"], ["detail"]], MAX_REASON_CHARS)
    ?? (publicStatus === "blocked"
      ? "The processor blocked this payment before it reached the bank (fraud or velocity rule)."
      : "The processor declined this payment.");
  return { kind: "processor_declined", code, reason };
}

// ---------------------------------------------------------------------------
// What the operator reads.
// ---------------------------------------------------------------------------

export type PaymentTone = "paid" | "declined" | "expired" | "failed" | "pending" | "refunded" | "canceled" | "neutral";

export interface PaymentStatusLabel {
  label: string;
  tone: PaymentTone;
}

/** "some_new_state" -> "Some new state". */
function humanise(value: string): string {
  return value.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
}

/**
 * The Payment column, in words an operator can act on. The kind only matters
 * for payment_failed; every other status is labelled on its own.
 */
export function describePaymentStatus(status: string | null | undefined, failureKind?: string | null): PaymentStatusLabel {
  const normalized = String(status ?? "pending_payment").trim().toLowerCase();
  switch (normalized) {
    case "paid":
      return { label: "Paid", tone: "paid" };
    case "pending_payment":
    case "pending":
      return { label: "Awaiting payment", tone: "pending" };
    case "awaiting_verification":
      return { label: "Awaiting verification", tone: "pending" };
    case "payment_rejected":
      return { label: "Proof rejected", tone: "failed" };
    case "payment_failed":
      if (failureKind === "processor_declined") return { label: "Declined by bank / processor", tone: "declined" };
      if (failureKind === "checkout_expired") return { label: "Checkout expired", tone: "expired" };
      return { label: "Payment failed", tone: "failed" };
    case "refunded":
      return { label: "Refunded", tone: "refunded" };
    case "partially_refunded":
      return { label: "Partially refunded", tone: "refunded" };
    case "canceled":
    case "cancelled":
      return { label: "Canceled", tone: "canceled" };
    default:
      return { label: humanise(normalized), tone: "neutral" };
  }
}

// ---------------------------------------------------------------------------
// Did the shopper come back and pay?
// ---------------------------------------------------------------------------

/**
 * How long after a failed or abandoned attempt a paid order by the same
 * shopper still counts as "they retried". Every real case so far was under two
 * minutes; a day is generous on purpose, and the badge shows the actual gap so
 * the operator can judge a long one for themselves.
 */
export const PAID_RETRY_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface PaidOrderCandidate {
  order_id: string;
  order_number: string | null;
  customer_email: string | null;
  created_at: string;
  amount_paid: number;
}

export interface PaidRetryLink {
  orderId: string;
  orderNumber: string | null;
  createdAt: string;
  /** Whole minutes after the failed attempt, never less than 1. */
  minutesAfter: number;
  /** The retry charged the same total, to the cent. */
  sameAmount: boolean;
}

function normalizeEmail(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

/**
 * The earliest paid order the same shopper placed after this attempt, inside
 * the window — or null. Read-time only: nothing is written, so a wrong guess
 * here can mislabel a badge and nothing else.
 */
export function findPaidRetry(
  attempt: { customer_email: string | null; created_at: string; amount_paid: number },
  paidOrders: readonly PaidOrderCandidate[],
): PaidRetryLink | null {
  const email = normalizeEmail(attempt.customer_email);
  const attemptedAt = Date.parse(attempt.created_at);
  if (!email || !Number.isFinite(attemptedAt)) return null;

  let best: PaidOrderCandidate | null = null;
  let bestAt = Number.POSITIVE_INFINITY;
  for (const paid of paidOrders) {
    if (normalizeEmail(paid.customer_email) !== email) continue;
    const paidAt = Date.parse(paid.created_at);
    if (!Number.isFinite(paidAt)) continue;
    const gap = paidAt - attemptedAt;
    if (gap <= 0 || gap > PAID_RETRY_WINDOW_MS) continue;
    if (paidAt < bestAt) {
      best = paid;
      bestAt = paidAt;
    }
  }
  if (!best) return null;

  return {
    orderId: best.order_id,
    orderNumber: best.order_number ?? null,
    createdAt: best.created_at,
    minutesAfter: Math.max(1, Math.round((bestAt - attemptedAt) / 60_000)),
    sameAmount: Math.round(Number(best.amount_paid) * 100) === Math.round(Number(attempt.amount_paid) * 100),
  };
}

/** "1 min later", "2.5 h later", "2 days later". */
export function describeRetryDelay(minutesAfter: number): string {
  const minutes = Math.max(1, Math.round(Number(minutesAfter) || 0));
  if (minutes < 60) return `${minutes} min later`;
  if (minutes < 1440) {
    const hours = Math.round((minutes / 60) * 10) / 10;
    return `${hours} h later`;
  }
  const days = Math.round(minutes / 1440);
  return `${days} day${days === 1 ? "" : "s"} later`;
}
