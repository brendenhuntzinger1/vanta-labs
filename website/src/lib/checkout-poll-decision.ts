/**
 * What the payment page should do with one answer from
 * `/api/checkout/order-status/[orderId]`.
 *
 * WHY THIS IS ITS OWN FUNCTION
 *
 * The poll on the payment page used to read a single field — `paid` — and do
 * nothing with anything else. `order-status` already distinguished a terminal
 * failure (`pending: !isPaid && !failed`, added with a comment saying the
 * payment page needs to stop polling and let the shopper act), but the page
 * never consumed it. A declined card therefore looked exactly like "not
 * finished yet": the page polled every 2.5s indefinitely, showing the card
 * form, and the shopper was never told anything had gone wrong.
 *
 * That conditional lived inside a useCallback inside the host for a
 * cross-origin iframe, which is why nobody saw it. Out here it is three cases
 * and a test file.
 *
 * DELIBERATELY CONSERVATIVE ABOUT FAILURE. Only an explicit `pending === false`
 * from the server counts as terminal. A dropped request, an empty body, a
 * truncated response or an older server all fall through to "wait", because
 * telling a shopper their good card was declined is worse than one more poll.
 */

export type PollDecision =
  /** The order is paid. Navigate to confirmation. */
  | "settled"
  /** The processor is finished and the order was not paid. Tell the shopper. */
  | "failed"
  /** No verdict yet. Poll again. */
  | "wait";

export interface OrderStatusBody {
  /** Added for the payment page; mirrors isPaid. */
  paid?: unknown;
  /** The original contract, still returned. */
  isPaid?: unknown;
  /** The server's own verdict: !isPaid && !failed. */
  pending?: unknown;
  status?: unknown;
  /** Coarse reason, present only on a terminal failure. */
  failureKind?: unknown;
}

/**
 * How confident we are about WHY a payment did not complete.
 *
 * "declined" is the only value that licenses saying a bank refused the card.
 * Everything else — an abandoned verification, an expired session, an order an
 * operator retired — reaches the same payment_failed status with no bank
 * involved, and on this store most of them do: of eighteen failed orders,
 * sixteen had no processor event at all.
 */
export type FailureKind = "declined" | "unknown";

/**
 * What a shopper is told when a payment did not complete.
 *
 * Shared by the payment page and the order-confirmation page, which is the
 * point: they described the same event differently, and the confirmation page's
 * version asserted a bank decline for every failure — including the ones where
 * no bank was ever asked.
 *
 * Split by how much is actually known. `payment_failed` is also written for an
 * abandoned verification, an expired session, a processor event carrying no
 * reason, and an order retired by hand; on this store sixteen of eighteen
 * failures had no processor event at all. Both texts carry the step that
 * actually recovers the sale — approve the bank's prompt, then retry — which is
 * exactly how David's decline became a paid order 71 seconds later.
 */
export const DECLINE_MESSAGE: Record<FailureKind, string> = {
  declined:
    "Your bank declined this payment, so your card was not charged. If your bank has just asked you to "
    + "confirm the purchase — by text or in its app — approve it and then try again. You can also use a "
    + "different card.",
  unknown:
    "This payment didn't go through. If your bank has just asked you to confirm the purchase — by text or "
    + "in its app — approve it and then try again. You can also use a different card, or contact us and "
    + "we'll sort it out.",
};

export function failureKindFromStatus(body: unknown): FailureKind {
  if (!body || typeof body !== "object") return "unknown";
  const kind = String((body as OrderStatusBody).failureKind ?? "").toLowerCase();
  return kind === "processor_declined" ? "declined" : "unknown";
}

export function decideFromOrderStatus(body: unknown): PollDecision {
  if (!body || typeof body !== "object") return "wait";
  const data = body as OrderStatusBody;

  // Strictly true, never merely truthy: a "yes" or 1 from a malformed response
  // must not navigate a shopper to a confirmation page for an unpaid order.
  if (data.paid === true || data.isPaid === true) return "settled";

  // Only an explicit false is terminal. Absent means an older or truncated
  // response, which is a reason to poll again, not to announce a decline.
  if (data.pending === false) return "failed";

  return "wait";
}
