import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { FULLY_TERMINAL_ORDER_STATES } from "@/lib/payment-types";

// ---------------------------------------------------------------------------
// AN ORDER WHOSE MONEY HAS GONE BACK MUST NOT RE-ENTER THE APPROVAL QUEUE.
//
// /api/checkout/submit-payment is the manual-payment lane: the customer sends
// money out of band, then posts a transaction id here, and the order moves to
// awaiting_verification for an admin to approve.
//
// It refused a "paid" order and nothing else. A REFUNDED or CANCELLED one could
// be posted straight back to awaiting_verification — with rejection_reason
// cleared on the way, so it arrived looking clean — and would then sit in the
// admin's approval list indistinguishable from an ordinary pending payment.
// Approving it marks paid an order whose money has already been returned.
//
// The route takes no session; the order id is the bearer credential, which this
// repo treats as a deliberate design elsewhere. That makes the CUSTOMER of a
// refunded order the likely trigger rather than an attacker: they still have the
// link, they resubmit, and the store's own admin completes the mistake.
//
// The set of terminal states was already written down in processPaymentWebhook.
// It is now written down once, in payment-types.ts, and imported by both — the
// second copy of a rule like this is how the two ends of a state machine drift.
// payment_failed is deliberately excluded: a rejected manual payment is meant to
// be resubmittable, which is the whole reason the route clears the rejection.
// ---------------------------------------------------------------------------

const ROUTE = readFileSync(
  path.resolve(process.cwd(), "src/app/api/checkout/submit-payment/route.ts"),
  "utf8",
);
const WEBHOOK = readFileSync(path.resolve(process.cwd(), "src/lib/payment-webhook.ts"), "utf8");

describe("the terminal-state set", () => {
  it("names the states an order does not come back from", () => {
    expect([...FULLY_TERMINAL_ORDER_STATES].sort()).toEqual(["canceled", "refunded"]);
  });

  it("does NOT include payment_failed, which must stay resubmittable", () => {
    // A manual payment that was rejected is meant to be re-sent. Blocking it
    // here would strand the customer on an order they can still pay for.
    expect(FULLY_TERMINAL_ORDER_STATES.has("payment_failed")).toBe(false);
    expect(FULLY_TERMINAL_ORDER_STATES.has("pending_payment")).toBe(false);
    expect(FULLY_TERMINAL_ORDER_STATES.has("awaiting_verification")).toBe(false);
  });
});

describe("both ends of the state machine use the same set", () => {
  it("submit-payment consults it before re-queueing an order", () => {
    expect(ROUTE).toContain("FULLY_TERMINAL_ORDER_STATES");
    expect(ROUTE).toMatch(/FULLY_TERMINAL_ORDER_STATES\.has\(order\.payment_status\)/);
  });

  it("submit-payment still refuses an order that is already paid", () => {
    // The guard it always had. Adding the terminal check must not replace it:
    // "paid" is not in the terminal set, because a paid order is not closed.
    expect(ROUTE).toContain('order.payment_status === "paid"');
  });

  it("the webhook uses the shared set rather than a second copy of the literals", () => {
    // The duplicate is the defect being prevented. If someone re-inlines it,
    // the two ends can disagree about what "closed" means and only one of them
    // will be wrong at a time.
    expect(WEBHOOK).toContain("FULLY_TERMINAL_ORDER_STATES");
    expect(
      WEBHOOK,
      "payment-webhook.ts re-declares the terminal states instead of importing them",
    ).not.toMatch(/new Set\(\["refunded", "canceled"\]\)/);
  });

  it("the guard runs before the write, not after it", () => {
    // A check that happens after the update has already moved the row is not a
    // guard. Both offsets are in the same handler, so ordering is the assertion.
    const guard = ROUTE.indexOf("FULLY_TERMINAL_ORDER_STATES.has(order.payment_status)");
    const write = ROUTE.indexOf('payment_status: "awaiting_verification"');
    expect(guard).toBeGreaterThan(-1);
    expect(write).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(write);
  });
});
