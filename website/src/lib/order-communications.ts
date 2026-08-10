/**
 * What the customer has actually been told about an order.
 *
 * Derived, not stored. The state machine already knows when each email became
 * due — payment settling, the parcel entering the carrier network, delivery —
 * and `pending_emails` already records every send that failed. A
 * `confirmation_email_sent_at` column would be a second source of truth for
 * something two existing systems answer between them, and second sources of
 * truth drift.
 *
 * The one thing that CANNOT be derived is positive proof of delivery. Nothing
 * writes a row on success, so the absence of a failure is not the presence of a
 * send. That distinction is preserved all the way to the label an owner reads:
 * "No failure recorded" is what the data supports, and claiming "Sent" would be
 * the system pretending it knows something it does not.
 */

export type CommunicationState =
  /** The event that triggers this email has not happened yet. */
  | "not_due"
  /** Due, and nothing went wrong — but nothing proves it landed either. */
  | "no_failure_recorded"
  /** Failed once and a later retry got through. */
  | "recovered"
  /** Failed and is still being retried automatically. */
  | "retrying"
  /** Retries exhausted. The customer did not get this. */
  | "failed";

export type CommunicationRow = {
  key: "confirmation" | "shipping" | "delivery";
  label: string;
  state: CommunicationState;
  /** Why it is in this state, in a sentence an owner can act on. */
  detail: string;
  /** Present only when a failure was recorded. */
  lastError?: string | null;
  attempts?: number;
  /** True when a manual retry would do something. */
  retryable: boolean;
};

/** A row of `pending_emails`, which only ever exists because a send failed. */
export type PendingEmailRow = {
  id: string;
  subject: string;
  status: string;
  attempts?: number | null;
  last_error?: string | null;
  updated_at?: string | null;
};

export type OrderCommunicationInput = {
  orderNumber: string;
  paymentStatus: string | null;
  fulfillmentStatus: string | null;
  shippedAt: string | null;
  deliveredAt: string | null;
  pendingEmails: PendingEmailRow[];
};

/**
 * Subjects are the join key.
 *
 * The templates embed the public order number — "Order Confirmed - VL-1042" —
 * and `pending_emails` stores the rendered subject. That is what lets a failed
 * send be traced back to its order without adding a foreign key to a table
 * whose whole purpose is to survive the failure of everything around it.
 */
const SUBJECT_PREFIX: Record<CommunicationRow["key"], string> = {
  confirmation: "Order Confirmed",
  shipping: "Shipping Update",
  delivery: "Delivered",
};

const LABEL: Record<CommunicationRow["key"], string> = {
  confirmation: "Order confirmation",
  shipping: "Shipping email",
  delivery: "Delivery email",
};

/** Statuses that mean the parcel is with the carrier, so the notice is due. */
const IN_CARRIER_NETWORK = new Set(["shipped", "in_transit", "out_for_delivery", "delivered"]);

function matchingRow(input: OrderCommunicationInput, key: CommunicationRow["key"]): PendingEmailRow | null {
  const prefix = SUBJECT_PREFIX[key].toLowerCase();
  const orderNumber = input.orderNumber.toLowerCase();
  const matches = input.pendingEmails.filter((row) => {
    const subject = String(row.subject ?? "").toLowerCase();
    return subject.includes(orderNumber) && subject.startsWith(prefix);
  });
  if (matches.length === 0) return null;
  // The worst outcome wins: an owner needs to see a failure even if a later
  // duplicate of the same email happened to succeed.
  const rank = (row: PendingEmailRow) => (row.status === "failed" ? 0 : row.status === "pending" ? 1 : 2);
  return [...matches].sort((a, b) => rank(a) - rank(b))[0];
}

function isDue(input: OrderCommunicationInput, key: CommunicationRow["key"]): boolean {
  if (key === "confirmation") return String(input.paymentStatus ?? "").toLowerCase() === "paid";
  if (key === "delivery") return Boolean(input.deliveredAt) || input.fulfillmentStatus === "delivered";
  // Shipping is due from the first carrier scan. `shipped_at` is stamped then
  // and never moved, so it survives the parcel progressing past "shipped".
  return Boolean(input.shippedAt) || IN_CARRIER_NETWORK.has(String(input.fulfillmentStatus ?? ""));
}

const NOT_DUE_DETAIL: Record<CommunicationRow["key"], string> = {
  confirmation: "Not due — the order has not been paid.",
  shipping: "Waiting for the first carrier scan. A printed label does not send this.",
  delivery: "Not applicable yet — the carrier has not reported delivery.",
};

export function deriveOrderCommunications(input: OrderCommunicationInput): CommunicationRow[] {
  return (["confirmation", "shipping", "delivery"] as const).map((key) => {
    const due = isDue(input, key);
    const row = matchingRow(input, key);

    if (!due && !row) {
      return { key, label: LABEL[key], state: "not_due", detail: NOT_DUE_DETAIL[key], retryable: false };
    }

    if (!row) {
      return {
        key,
        label: LABEL[key],
        state: "no_failure_recorded",
        // Deliberately not "Sent". Nothing writes a row on success, so this is
        // the strongest true statement available.
        detail: "Due, and no delivery failure was recorded for it.",
        retryable: false,
      };
    }

    const attempts = Number(row.attempts ?? 0);
    if (row.status === "failed") {
      return {
        key,
        label: LABEL[key],
        state: "failed",
        detail: `Gave up after ${attempts} attempt(s). The customer did not receive this.`,
        lastError: row.last_error ?? null,
        attempts,
        retryable: true,
      };
    }
    if (row.status === "pending") {
      return {
        key,
        label: LABEL[key],
        state: "retrying",
        detail: `Delivery failed and is being retried automatically (${attempts} attempt(s) so far).`,
        lastError: row.last_error ?? null,
        attempts,
        retryable: true,
      };
    }
    return {
      key,
      label: LABEL[key],
      state: "recovered",
      detail: `Failed initially, then delivered on retry after ${attempts} attempt(s).`,
      lastError: row.last_error ?? null,
      attempts,
      retryable: false,
    };
  });
}

/** True when anything about this order's communications needs an owner's attention. */
export function needsAttention(rows: CommunicationRow[]): boolean {
  return rows.some((row) => row.state === "failed" || row.state === "retrying");
}
