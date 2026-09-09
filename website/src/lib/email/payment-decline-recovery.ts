/**
 * PAYMENT DECLINE RECOVERY — the eligibility rule.
 *
 * THE LEAK THIS CLOSES (production, 2026-09-09):
 *   $2,444.00 of orders reached payment_failed against $1,085.21 ever paid.
 *   $1,813.24 of that belongs to customers who never came back at all, and no
 *   recovery email of any kind has ever been sent for a failed payment.
 *
 * Meanwhile the abandoned-cart sweep has sent 85 messages to people who merely
 * added something to a cart. Somebody who entered card details is further down
 * the funnel than anyone that sweep mails, and they were getting nothing.
 *
 * THE DISCRIMINATION THAT MATTERS. `payment_failed` covers two unrelated
 * events and only one of them is a decline:
 *
 *   processor_declined  the bank was asked and said no. The customer TRIED to
 *                       pay — $1,494.76 of the loss. The barrier is the card,
 *                       not the price, so this is recoverable by making the
 *                       retry easy.
 *   checkout_expired    no charge was ever attempted; the session aged out.
 *                       Telling these people "your payment was declined" is a
 *                       false statement about their bank, and false
 *                       transactional mail is how a sending domain earns
 *                       complaints it cannot argue with.
 *
 * NO INCENTIVE, DELIBERATELY. The customer had already chosen to pay full
 * price and their card failed. A discount buys nothing that was in doubt and
 * costs margin on an order that was already won. It also keeps this message
 * TRANSACTIONAL — no offer, no marketing footer — which is what lets it reach
 * someone who has unsubscribed from marketing and still needs to know their
 * order did not go through, exactly as a receipt does.
 *
 * Pure, so the rule can be argued about and tested without a webhook.
 */

export type DeclineRecoveryFacts = {
  paymentStatus: string | null | undefined;
  failureKind: string | null | undefined;
  orderType: string | null | undefined;
  customerEmail: string | null | undefined;
  /**
   * What the declined attempt was for. The email states this figure, so an
   * order whose amount did not survive is refused rather than mailed: "your
   * payment of $0.00 was declined" reads as a broken system and invites a
   * support ticket instead of a retry.
   */
  amountCents?: number | null;
  /** The order has since been paid — a later event overtook the failure. */
  alreadyPaid?: boolean;
  /**
   * Present only so the rule can state that it does NOT consult it. This is
   * transactional mail about an order the customer placed; a marketing
   * unsubscribe does not mean "do not tell me my payment failed".
   */
  marketingUnsubscribed?: boolean;
};

/** The only failure kind that means a bank was asked and said no. */
const RECOVERABLE_KIND = "processor_declined";

/** Order types whose failure this email is about. A membership has its own dunning. */
const RECOVERABLE_ORDER_TYPES = new Set(["product", "sale"]);

function clean(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

function isPositiveAmount(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/**
 * Why the rule decided what it decided, in words an operator can act on.
 *
 * Returned alongside every refusal so a "no email went out" question has an
 * answer in the logs rather than requiring someone to re-derive the rule.
 */
export function declineRecoveryReason(facts: DeclineRecoveryFacts): string {
  if (clean(facts.paymentStatus) !== "payment_failed") {
    return `Order is ${clean(facts.paymentStatus) || "in an unknown state"}, not a failed payment.`;
  }
  if (facts.alreadyPaid) {
    return "This order has since been paid — a later event overtook the failure.";
  }
  if (!RECOVERABLE_ORDER_TYPES.has(clean(facts.orderType))) {
    return `Order type "${clean(facts.orderType) || "unknown"}" has its own handling; membership dunning and replacement reships are not customer retries.`;
  }
  if (!clean(facts.customerEmail)) {
    return "No deliverable address on the order.";
  }
  if (clean(facts.failureKind) !== RECOVERABLE_KIND) {
    return "No charge was attempted — the checkout expired rather than being declined, so there is no decline to tell the customer about.";
  }
  if (!isPositiveAmount(facts.amountCents)) {
    return "The order carries no amount, and this email states the figure that was declined.";
  }
  return "The processor declined a real payment attempt, and the customer can retry.";
}

/**
 * Should this failed order earn a decline-recovery email?
 *
 * Fails closed on anything it does not recognise: an unexplained failure is not
 * assumed to be a decline, because the email asserts something specific about
 * the customer's bank.
 */
export function shouldSendDeclineRecovery(facts: DeclineRecoveryFacts): boolean {
  if (clean(facts.paymentStatus) !== "payment_failed") return false;
  if (facts.alreadyPaid) return false;
  if (!RECOVERABLE_ORDER_TYPES.has(clean(facts.orderType))) return false;
  if (!clean(facts.customerEmail)) return false;
  if (clean(facts.failureKind) !== RECOVERABLE_KIND) return false;
  if (!isPositiveAmount(facts.amountCents)) return false;
  return true;
}
