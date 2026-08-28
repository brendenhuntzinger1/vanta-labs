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
 * POSITIVE PROOF OF DELIVERY EXISTS FOR EXACTLY ONE OF THESE ROWS (E-07). The
 * header here used to say flatly that "nothing writes a row on success", and
 * that stopped being true when `order_email_log` was built: sendOrderEmailOnce
 * writes a 'sent' row with the provider and the provider's own message id. But
 * its only caller is the order-confirmation lane, so shipping and delivery
 * emails still have no success record and still cannot say more than "no
 * failure recorded".
 *
 * So the ceiling is now per row, and the panel must not level it up or down:
 * a CONFIRMATION with a 'sent' log row is genuinely SENT, and the other two
 * keep the honest weaker claim. Where there is no log row the answer is
 * unchanged — the absence of a failure is still not the presence of a send.
 */

export type CommunicationState =
  /** The event that triggers this email has not happened yet. */
  | "not_due"
  /** Due, and nothing went wrong — but nothing proves it landed either. */
  | "no_failure_recorded"
  /**
   * The email provider accepted this one, and `order_email_log` says so.
   *
   * The only state in this union that is a POSITIVE record rather than an
   * inference, which is why it is reachable for the confirmation row alone —
   * nothing writes that log for shipping or delivery.
   */
  | "sent"
  /** Failed once and a later retry got through. */
  | "recovered"
  /** Failed and is still being retried automatically. */
  | "retrying"
  /** Retries exhausted. The customer did not get this. */
  | "failed"
  /**
   * The failure queue could not be read, so nothing can be said either way.
   *
   * An availability problem, not an email problem. Collapsing it into
   * "no failure recorded" would turn a broken query into a clean bill of
   * health, which is the most dangerous direction for this panel to be wrong
   * in — the owner would see green precisely when the system had gone blind.
   */
  | "cannot_determine";

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
  /**
   * Rows read from `pending_emails`, or NULL when the read did not succeed.
   *
   * Nullable rather than a separate `available` flag on purpose: an empty array
   * and an unreadable table are genuinely different answers, and a single value
   * that can only express one of them at a time cannot drift out of step with
   * itself.
   */
  pendingEmails: PendingEmailRow[] | null;
  /**
   * Rows of `order_email_log`, the only table that records a SUCCESSFUL send.
   *
   * Optional, and absent means exactly what it did before this input existed:
   * no positive record, so the strongest claim available is
   * "no failure recorded". A caller that cannot read the log therefore degrades
   * to the old behaviour rather than reporting a gap — which is right here,
   * because unlike `pendingEmails` this table can only ever make an answer
   * STRONGER. Losing it costs certainty, never accuracy.
   */
  emailLog?: OrderEmailLogRow[] | null;
};

/** A row of `order_email_log` — written by sendOrderEmailOnce, success or not. */
export type OrderEmailLogRow = {
  kind: string;
  status: string;
  provider?: string | null;
  provider_message_id?: string | null;
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
  const matches = (input.pendingEmails ?? []).filter((row) => {
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
  // Whether an email is DUE comes from the order row, which was read
  // successfully to get here. That judgement stays reliable even when the
  // failure queue is unreadable, so a not-due row is still reported as not due
  // rather than being downgraded to unknown.
  const queueReadable = input.pendingEmails !== null;

  return (["confirmation", "shipping", "delivery"] as const).map((key) => {
    const due = isDue(input, key);
    const row = matchingRow(input, key);

    if (!due && !row) {
      return { key, label: LABEL[key], state: "not_due", detail: NOT_DUE_DETAIL[key], retryable: false };
    }

    if (!queueReadable) {
      return {
        key,
        label: LABEL[key],
        state: "cannot_determine",
        detail: "Email status data unavailable — this says nothing about whether the email was sent.",
        // Nothing is known to be queued, so offering a retry would imply a
        // certainty this row explicitly does not have.
        retryable: false,
      };
    }

    if (!row) {
      // A POSITIVE RECORD BEATS AN INFERENCE, for the one row that can have one.
      // `order_email_log` is written only by the order-confirmation lane, so
      // this upgrade is deliberately scoped to that key rather than applied to
      // all three — a SENT badge on a shipping row would be an unbacked claim.
      const logged = key === "confirmation"
        ? (input.emailLog ?? []).find((entry) => entry.kind === "order_confirmation" && entry.status === "sent")
        : undefined;
      if (logged) {
        return {
          key,
          label: LABEL[key],
          state: "sent",
          detail: logged.provider_message_id
            ? `Accepted by ${logged.provider ?? "the email provider"} — message id ${logged.provider_message_id}.`
            : "Recorded as sent.",
          retryable: false,
        };
      }
      return {
        key,
        label: LABEL[key],
        state: "no_failure_recorded",
        // Deliberately not "Sent". Nothing recorded a success for this one, so
        // this is the strongest true statement available.
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

/**
 * True when a customer is known to be missing an email.
 *
 * `cannot_determine` deliberately does not count: it is a monitoring gap, not a
 * customer-facing failure, and folding the two together would either cry wolf
 * about every unreadable query or hide a real one among them.
 */
export function needsAttention(rows: CommunicationRow[]): boolean {
  return rows.some((row) => row.state === "failed" || row.state === "retrying");
}

/** True when the panel could not read the data it needs to answer. */
export function hasUnknowns(rows: CommunicationRow[]): boolean {
  return rows.some((row) => row.state === "cannot_determine");
}
