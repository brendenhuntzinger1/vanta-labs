import { describe, expect, it } from "vitest";

import { decideFromOrderStatus } from "@/lib/checkout-poll-decision";

// ---------------------------------------------------------------------------
// What the payment page does with each answer from /api/checkout/order-status.
//
// THE DEFECT THIS EXISTS TO PREVENT.
//
// The poll used to read exactly one field:
//
//   const data = await response.json() as { paid?: boolean };
//   if (data?.paid) goToConfirmation();
//
// So a DECLINED payment — which the server records correctly as
// payment_failed, and which order-status already reports as
// `{ paid: false, pending: false }`, with a comment saying the payment page
// needs to stop polling and let the shopper act — was indistinguishable from
// "not finished yet". The page polled every 2.5s, forever, showing the card
// form. The shopper was never told the payment failed.
//
// Observed in production on 2026-08-26: one shopper, three attempts in sixteen
// minutes (~82s, ~150s, ~35s on the page), no completed order, and not one
// server error, because nothing was erroring. The server knew. The page never
// asked.
//
// A decision this small is worth a pure function because the alternative is a
// conditional buried in a useCallback inside a cross-origin iframe host, which
// is exactly where it went unnoticed for the life of the checkout.
// ---------------------------------------------------------------------------

describe("a paid order settles", () => {
  it("settles on paid", () => {
    expect(decideFromOrderStatus({ paid: true, pending: false, status: "paid" })).toBe("settled");
  });

  it("settles on paid even when pending is stale or absent", () => {
    // paid is the authoritative signal; a contradictory pending must never
    // hold a settled order on the spinner.
    expect(decideFromOrderStatus({ paid: true, pending: true, status: "paid" })).toBe("settled");
    expect(decideFromOrderStatus({ paid: true })).toBe("settled");
  });

  it("settles on the legacy isPaid field", () => {
    // order-status returns BOTH isPaid (original contract) and paid (added for
    // this page). Reading only one is how the failed case was missed.
    expect(decideFromOrderStatus({ isPaid: true, status: "paid" })).toBe("settled");
  });
});

describe("a terminally failed order tells the shopper instead of spinning", () => {
  for (const status of ["payment_failed", "canceled", "cancelled"]) {
    it(`reports failure for "${status}"`, () => {
      expect(decideFromOrderStatus({ paid: false, pending: false, status })).toBe("failed");
    });
  }

  it("reports failure from pending:false alone, whatever the status string says", () => {
    // pending is the server's own computed verdict (!isPaid && !failed). If it
    // says the wait is over and the order is not paid, the wait is over.
    expect(decideFromOrderStatus({ paid: false, pending: false, status: "something_new" })).toBe("failed");
  });
});

describe("anything else keeps waiting", () => {
  it("waits while the order is still pending", () => {
    expect(decideFromOrderStatus({ paid: false, pending: true, status: "pending_payment" })).toBe("wait");
  });

  it("waits on a malformed or empty body rather than crying failure", () => {
    // A dropped request on mobile data is expected mid-payment. Treating it as
    // a decline would tell a shopper their good card was refused.
    expect(decideFromOrderStatus({})).toBe("wait");
    expect(decideFromOrderStatus(null)).toBe("wait");
    expect(decideFromOrderStatus(undefined)).toBe("wait");
    expect(decideFromOrderStatus("nonsense")).toBe("wait");
    expect(decideFromOrderStatus({ paid: "yes", pending: "no" })).toBe("wait");
  });

  it("waits when pending is absent and the order is not paid", () => {
    // Absent is not the same as false. An older server, or a truncated
    // response, must not be read as a decline.
    expect(decideFromOrderStatus({ paid: false, status: "pending_payment" })).toBe("wait");
  });
});
