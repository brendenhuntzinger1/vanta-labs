import { describe, expect, it } from "vitest";
import { shouldSendDeclineRecovery, declineRecoveryReason } from "@/lib/email/payment-decline-recovery";

// ---------------------------------------------------------------------------
// PAYMENT DECLINE RECOVERY — WHO GETS ONE, AND WHO MUST NOT.
//
// THE LEAK THIS EXISTS TO CLOSE (production, 2026-09-09):
//   $2,444.00 of orders reached payment_failed against $1,085.21 ever paid.
//   $1,813.24 of that belongs to customers who never came back at all.
//   Zero recovery emails of any kind have ever been sent for a failed payment.
//   Meanwhile 85 abandoned-cart emails went to people who only added to cart.
//
// The system chases its lowest-intent audience and ignores its highest: someone
// who entered card details is further down the funnel than anyone the
// abandoned-cart sweep mails.
//
// THE DISCRIMINATION THAT MATTERS. `payment_failed` covers two different
// events, and only one of them is a decline:
//
//   processor_declined  the bank was asked and said no. The customer TRIED to
//                       pay. $1,494.76 of the loss. Recoverable — the barrier
//                       is the card, not the price.
//   checkout_expired    no charge was ever attempted; the session aged out.
//                       Telling these people "your payment failed" is simply
//                       false, and false transactional mail is how a sending
//                       domain earns complaints.
//
// NO INCENTIVE, DELIBERATELY. The customer had already chosen to pay full
// price; their card failed. A discount here buys nothing that was in doubt and
// costs margin on an order that was already won. It also keeps the message
// TRANSACTIONAL — no offer, no marketing footer — which is what lets it reach a
// customer who has unsubscribed from marketing and still needs to know their
// order did not go through.
// ---------------------------------------------------------------------------

const declined = {
  paymentStatus: "payment_failed",
  failureKind: "processor_declined",
  orderType: "product",
  customerEmail: "buyer@x.test",
  amountCents: 36_794,
};

describe("a real decline earns a recovery email", () => {
  it("sends for a processor decline on a product order", () => {
    expect(shouldSendDeclineRecovery(declined)).toBe(true);
  });

  it("sends regardless of how large the order was", () => {
    expect(shouldSendDeclineRecovery({ ...declined })).toBe(true);
  });
});

describe("who must never receive one", () => {
  // The single most important exclusion. No charge was attempted, so "your
  // payment was declined" is a false statement about the customer's bank.
  it("never sends for an expired checkout, where no charge was attempted", () => {
    expect(shouldSendDeclineRecovery({ ...declined, failureKind: "checkout_expired" })).toBe(false);
    expect(declineRecoveryReason({ ...declined, failureKind: "checkout_expired" })).toMatch(/no charge/i);
  });

  it("never sends when the failure kind is unknown", () => {
    // "other" covers rows recorded before reasons were captured. Guessing that
    // an unexplained failure was a decline risks the same false statement.
    expect(shouldSendDeclineRecovery({ ...declined, failureKind: "other" })).toBe(false);
    expect(shouldSendDeclineRecovery({ ...declined, failureKind: null })).toBe(false);
  });

  it("never sends for an order that is not in a failed state", () => {
    for (const status of ["paid", "pending_payment", "refunded", "canceled"]) {
      expect(shouldSendDeclineRecovery({ ...declined, paymentStatus: status })).toBe(false);
    }
  });

  // A customer whose card failed and who then succeeded must not be told their
  // payment failed. The webhook can deliver events out of order.
  it("never sends when the customer has since paid this order", () => {
    expect(shouldSendDeclineRecovery({ ...declined, alreadyPaid: true })).toBe(false);
  });

  // Membership dunning already exists (membershipPaymentFailedTemplate) and
  // says something different — it points at updating a stored card, not at
  // retrying one order.
  it("never sends for a membership order", () => {
    expect(shouldSendDeclineRecovery({ ...declined, orderType: "membership" })).toBe(false);
  });

  it("never sends for a replacement reship, which the customer never paid for", () => {
    expect(shouldSendDeclineRecovery({ ...declined, orderType: "replacement" })).toBe(false);
  });

  it("never sends without a deliverable address", () => {
    expect(shouldSendDeclineRecovery({ ...declined, customerEmail: "" })).toBe(false);
    expect(shouldSendDeclineRecovery({ ...declined, customerEmail: null })).toBe(false);
  });

  // The one case where staying silent is worse than sending: a suppressed
  // address. This is TRANSACTIONAL mail about an order the customer placed —
  // a marketing unsubscribe does not mean "do not tell me my order failed",
  // exactly as it does not silence a receipt.
  it("still sends to someone who unsubscribed from marketing", () => {
    expect(shouldSendDeclineRecovery({ ...declined, marketingUnsubscribed: true })).toBe(true);
  });
});

describe("the reason is always explainable", () => {
  it("explains why it will send", () => {
    expect(declineRecoveryReason(declined)).toMatch(/declined/i);
  });

  it("explains every refusal in words an operator can act on", () => {
    const reasons = [
      declineRecoveryReason({ ...declined, paymentStatus: "paid" }),
      declineRecoveryReason({ ...declined, orderType: "membership" }),
      declineRecoveryReason({ ...declined, customerEmail: null }),
      declineRecoveryReason({ ...declined, alreadyPaid: true }),
    ];
    for (const reason of reasons) {
      expect(reason.length).toBeGreaterThan(10);
      expect(reason).not.toMatch(/undefined|null/);
    }
  });
});

// ---------------------------------------------------------------------------
// FOUND IN THE ADVERSARIAL PASS. An order whose amount did not survive would
// produce "your payment of $0.00 was declined" — a message that reads as a
// broken system and invites a support ticket rather than a retry. Not present
// in today's data (all 6 declined orders carry an amount), but the email makes
// a specific claim about money and must not make a nonsensical one.
// ---------------------------------------------------------------------------

describe("it will not send a message about no money", () => {
  it("refuses an order with no amount", () => {
    expect(shouldSendDeclineRecovery({ ...declined, amountCents: 0 })).toBe(false);
    expect(shouldSendDeclineRecovery({ ...declined, amountCents: null })).toBe(false);
  });

  it("says why", () => {
    expect(declineRecoveryReason({ ...declined, amountCents: 0 })).toMatch(/amount/i);
  });

  it("still sends when an amount is present", () => {
    expect(shouldSendDeclineRecovery({ ...declined, amountCents: 36_794 })).toBe(true);
  });
});
