import { describe, expect, it } from "vitest";
import {
  classifyDeadSession,
  describeExpressDecline,
  describePaymentStatus,
  describeRetryDelay,
  extractProcessorFailure,
  findPaidRetry,
  PAID_RETRY_WINDOW_MS,
} from "@/lib/payment-failure";

// ---------------------------------------------------------------------------
// WHY THIS MODULE EXISTS. Until 2026-09-04 every unpaid outcome was written as
// the bare status `payment_failed`: a bank decline, a checkout session Veyra
// expired because the shopper walked away, and two test orders an operator
// retired by hand all read identically in /admin/orders. The operator saw "a
// lot of failed payments" and could not tell which were the store's fault
// (none were), which were the bank's, and which were simply abandoned. Nor
// could they see that every real customer with a failed row had paid on a
// second order a minute later.
//
// This module is the single vocabulary for telling those apart. It is pure so
// it can be imported by the admin UI and by the three server-side write sites
// alike, and every branch is pinned here.
// ---------------------------------------------------------------------------

describe("extractProcessorFailure — the processor's own words, wherever it put them", () => {
  it("reads a VeyraGate charge nested under data.object", () => {
    const detail = extractProcessorFailure({
      id: "evt_1",
      type: "payment.failed",
      data: {
        object: {
          failure_code: "card_declined",
          failure_message: "Your card was declined.",
          metadata: { order_id: "order-1" },
        },
      },
    });
    expect(detail).toEqual({ kind: "processor_declined", code: "card_declined", reason: "Your card was declined." });
  });

  it("reads an un-nested charge and prefers the network decline code over the generic failure code", () => {
    const detail = extractProcessorFailure({
      type: "charge.failed",
      data: {
        failure_code: "card_declined",
        decline_code: "insufficient_funds",
        outcome: { seller_message: "The bank returned the decline code insufficient_funds." },
      },
    });
    expect(detail.code).toBe("insufficient_funds");
    expect(detail.reason).toBe("The bank returned the decline code insufficient_funds.");
  });

  it("reads the flat shape the internal mock gateway sends", () => {
    const detail = extractProcessorFailure({ orderId: "order-1", type: "payment.failed", reason: "Test decline" });
    expect(detail).toEqual({ kind: "processor_declined", code: null, reason: "Test decline" });
  });

  it("records an honest null when the processor said nothing about why", () => {
    const detail = extractProcessorFailure({ type: "payment.failed", data: { metadata: { order_id: "order-1" } } });
    expect(detail).toEqual({ kind: "processor_declined", code: null, reason: null });
  });

  it("clamps a runaway message and ignores values that are not strings", () => {
    const detail = extractProcessorFailure({
      type: "payment.failed",
      data: { object: { failure_code: 42, failure_message: `   ${"x".repeat(500)}   ` } },
    });
    expect(detail.code).toBeNull();
    expect(detail.reason).toHaveLength(200);
    expect(detail.reason?.endsWith("…")).toBe(true);
  });

  it("never throws, whatever it is handed", () => {
    for (const garbage of [null, undefined, "string", 12, [], { data: null }, { data: { object: "nope" } }]) {
      expect(() => extractProcessorFailure(garbage)).not.toThrow();
      expect(extractProcessorFailure(garbage).kind).toBe("processor_declined");
    }
  });
});

describe("classifyDeadSession — what the reconcile sweep learned by asking the processor", () => {
  it("treats a failed session as a processor decline and keeps the processor's reason", () => {
    const detail = classifyDeadSession("failed", { status: "failed", last_error: { code: "do_not_honor", message: "Do not honor" } });
    expect(detail).toEqual({ kind: "processor_declined", code: "do_not_honor", reason: "Do not honor" });
  });

  it("still calls a bare failed session a decline, with the status as its code", () => {
    const detail = classifyDeadSession("failed", { status: "failed" });
    expect(detail.kind).toBe("processor_declined");
    expect(detail.code).toBe("failed");
    expect(detail.reason).toMatch(/payment attempt failed/i);
  });

  it("treats an expired session as an abandoned checkout, not a decline", () => {
    const detail = classifyDeadSession("expired", { status: "expired" });
    expect(detail.kind).toBe("checkout_expired");
    expect(detail.code).toBe("expired");
    expect(detail.reason).toMatch(/expired/i);
    expect(detail.reason).not.toMatch(/declin/i);
  });

  for (const status of ["canceled", "cancelled"]) {
    it(`treats a ${status} session as an abandoned checkout`, () => {
      const detail = classifyDeadSession(status, null);
      expect(detail.kind).toBe("checkout_expired");
      expect(detail.code).toBe(status);
      expect(detail.reason).toMatch(/cancel/i);
    });
  }

  it("files anything it does not recognise under 'other' rather than guessing", () => {
    const detail = classifyDeadSession("weird_new_status", { status: "weird_new_status" });
    expect(detail.kind).toBe("other");
    expect(detail.code).toBe("weird_new_status");
    expect(detail.reason).toBeTruthy();
  });
});

describe("describeExpressDecline — Veyra's answer to an Apple Pay charge", () => {
  it("keeps the decline code and message when Veyra sends them", () => {
    const detail = describeExpressDecline({ public_status: "failed", decline_code: "insufficient_funds", message: "Insufficient funds" }, 402);
    expect(detail).toEqual({ kind: "processor_declined", code: "insufficient_funds", reason: "Insufficient funds" });
  });

  it("names a fraud/velocity block as a block, so it is not mistaken for the bank saying no", () => {
    const detail = describeExpressDecline({ public_status: "blocked" }, 403);
    expect(detail.kind).toBe("processor_declined");
    expect(detail.code).toBe("blocked");
    expect(detail.reason).toMatch(/blocked/i);
  });

  it("keeps the bank label for a failed verdict with no message", () => {
    const detail = describeExpressDecline({ public_status: "failed" }, 402);
    expect(detail.kind).toBe("processor_declined");
    expect(detail.code).toBe("failed");
    expect(detail.reason).toMatch(/declined/i);
  });

  // The authorize route lands in answered_no on ANY 4xx, including refusals
  // that never reached the bank (a 409 shipping-method mismatch, a 400 for a
  // bad token). Those must not wear the "Declined by bank" badge.
  it("files a plain 4xx refusal under 'other', saying the bank was never asked", () => {
    const detail = describeExpressDecline({ error: "invalid_token" }, 400);
    expect(detail.kind).toBe("other");
    expect(detail.code).toBe("invalid_token");
    expect(detail.reason).toMatch(/before it reached the bank/i);
    expect(detail.reason).not.toMatch(/declined/i);
  });

  it("records the HTTP status when the body said nothing usable, still as 'other'", () => {
    const detail = describeExpressDecline(null, 400);
    expect(detail.kind).toBe("other");
    expect(detail.code).toBe("http_400");
    expect(detail.reason).toBeTruthy();
  });
});

describe("describePaymentStatus — what the operator reads in the Payment column", () => {
  it("tells a bank decline apart from an abandoned checkout", () => {
    expect(describePaymentStatus("payment_failed", "processor_declined")).toEqual({ label: "Declined by bank / processor", tone: "declined" });
    expect(describePaymentStatus("payment_failed", "checkout_expired")).toEqual({ label: "Checkout expired", tone: "expired" });
  });

  it("keeps a plain 'Payment failed' for failures with no recorded kind", () => {
    expect(describePaymentStatus("payment_failed", null)).toEqual({ label: "Payment failed", tone: "failed" });
    expect(describePaymentStatus("payment_failed", "other")).toEqual({ label: "Payment failed", tone: "failed" });
  });

  it("labels the ordinary statuses in plain English", () => {
    expect(describePaymentStatus("paid")).toEqual({ label: "Paid", tone: "paid" });
    expect(describePaymentStatus("pending_payment")).toEqual({ label: "Awaiting payment", tone: "pending" });
    expect(describePaymentStatus("awaiting_verification")).toEqual({ label: "Awaiting verification", tone: "pending" });
    expect(describePaymentStatus("payment_rejected")).toEqual({ label: "Proof rejected", tone: "failed" });
    expect(describePaymentStatus("refunded")).toEqual({ label: "Refunded", tone: "refunded" });
    expect(describePaymentStatus("partially_refunded")).toEqual({ label: "Partially refunded", tone: "refunded" });
    expect(describePaymentStatus("canceled")).toEqual({ label: "Canceled", tone: "canceled" });
    expect(describePaymentStatus("cancelled")).toEqual({ label: "Canceled", tone: "canceled" });
  });

  it("humanises anything it has never heard of instead of showing a raw enum", () => {
    expect(describePaymentStatus("some_new_state")).toEqual({ label: "Some new state", tone: "neutral" });
    expect(describePaymentStatus(null)).toEqual({ label: "Awaiting payment", tone: "pending" });
  });
});

describe("findPaidRetry — did this shopper come back and pay?", () => {
  const attempt = { customer_email: "Shopper@Example.com", created_at: "2026-09-03T17:48:57.700Z", amount_paid: 194.98 };
  const paid = (over: Partial<{ order_id: string; order_number: string | null; customer_email: string | null; created_at: string; amount_paid: number }> = {}) => ({
    order_id: "order-paid",
    order_number: "VL-A068413C",
    customer_email: "shopper@example.com",
    created_at: "2026-09-03T17:50:30.916Z",
    amount_paid: 194.98,
    ...over,
  });

  it("links the paid order the same shopper placed a minute later", () => {
    const link = findPaidRetry(attempt, [paid()]);
    expect(link).toEqual({
      orderId: "order-paid",
      orderNumber: "VL-A068413C",
      createdAt: "2026-09-03T17:50:30.916Z",
      minutesAfter: 2,
      sameAmount: true,
    });
  });

  it("matches the email case-insensitively and ignores surrounding whitespace", () => {
    expect(findPaidRetry(attempt, [paid({ customer_email: "  SHOPPER@example.com " })])).not.toBeNull();
  });

  it("ignores a different shopper", () => {
    expect(findPaidRetry(attempt, [paid({ customer_email: "someone@else.com" })])).toBeNull();
  });

  it("ignores a paid order placed BEFORE the failed attempt — that is not a retry", () => {
    expect(findPaidRetry(attempt, [paid({ created_at: "2026-09-03T17:00:00.000Z" })])).toBeNull();
  });

  it("ignores a paid order outside the retry window", () => {
    const later = new Date(Date.parse(attempt.created_at) + PAID_RETRY_WINDOW_MS + 60_000).toISOString();
    expect(findPaidRetry(attempt, [paid({ created_at: later })])).toBeNull();
  });

  it("picks the EARLIEST paid order after the attempt when there are several", () => {
    const link = findPaidRetry(attempt, [
      paid({ order_id: "order-later", order_number: "VL-LATER", created_at: "2026-09-03T19:00:00.000Z" }),
      paid(),
    ]);
    expect(link?.orderId).toBe("order-paid");
  });

  it("still links a retry whose total changed, and says so", () => {
    // Real case: $18.80 declined, $18.95 paid a minute later once shipping
    // was recalculated. Requiring an exact amount match would hide it.
    const link = findPaidRetry({ ...attempt, amount_paid: 18.8 }, [paid({ amount_paid: 18.95 })]);
    expect(link?.sameAmount).toBe(false);
  });

  it("copes with an attempt that has no email or an unreadable timestamp", () => {
    expect(findPaidRetry({ ...attempt, customer_email: null }, [paid()])).toBeNull();
    expect(findPaidRetry({ ...attempt, created_at: "not a date" }, [paid()])).toBeNull();
  });
});

describe("describeRetryDelay — the gap, as a person would say it", () => {
  it("speaks in minutes, hours and days", () => {
    expect(describeRetryDelay(1)).toBe("1 min later");
    expect(describeRetryDelay(45)).toBe("45 min later");
    expect(describeRetryDelay(60)).toBe("1 h later");
    expect(describeRetryDelay(150)).toBe("2.5 h later");
    expect(describeRetryDelay(1440)).toBe("1 day later");
    expect(describeRetryDelay(2880)).toBe("2 days later");
  });
});
