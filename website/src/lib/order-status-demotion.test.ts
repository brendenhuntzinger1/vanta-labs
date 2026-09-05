import { describe, expect, it } from "vitest";

import { isPaymentStatusDemotion } from "@/lib/order-status";

// ---------------------------------------------------------------------------
// AN ORDER THAT HAS BEEN PAID CANNOT BE "UN-PAID" BY A DROPDOWN.
//
// The admin order page's payment-status control refuses to move an order INTO
// paid / refunded / partially_refunded (those transitions run side effects), but
// it accepted moving a paid order OUT to pending_payment — or to a status that
// does not exist, "failed" — rewriting the column with no reversal of
// inventory, commission, points or store credit, and no history row. The only
// honest ways out of a money state are the refund and cancel actions.
// ---------------------------------------------------------------------------

describe("isPaymentStatusDemotion", () => {
  it.each([
    ["paid", "pending_payment"],
    ["paid", "failed"],
    ["paid", "payment_failed"],
    ["paid", "canceled"],
    ["refunded", "pending_payment"],
    ["partially_refunded", "paid"],
    ["Paid", " pending_payment "],
  ])("refuses %s -> %s", (from, to) => {
    expect(isPaymentStatusDemotion(from, to)).toBe(true);
  });

  it.each([
    ["pending_payment", "payment_failed"],
    ["pending_payment", "canceled"],
    ["payment_failed", "pending_payment"],
    ["paid", "paid"],
    ["", "pending_payment"],
    [null, "canceled"],
  ])("allows %s -> %s", (from, to) => {
    expect(isPaymentStatusDemotion(from as string | null, to)).toBe(false);
  });
});
